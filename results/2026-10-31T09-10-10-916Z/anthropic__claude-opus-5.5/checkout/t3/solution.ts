// Local type declarations (Ctx, Db, PayCo, Charge... are provided by the runtime).
type OrderStatus = "pending" | "paid" | "declined";
interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: OrderStatus;
}
interface CheckoutState {
  attempt: number;   // current attempt number; idempotency key is derived from it
  chargeId?: string; // set once the order is paid
}

const orderKey = (id: string) => `order:${id}`;
const stateKey = (id: string) => `checkout:${id}`;
const chargeIdemKey = (id: string, attempt: number) => `checkout:${id}:${attempt}`;

const MAX_TIMEOUT_RETRIES = 3;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function errCode(e: unknown): string | undefined {
  return e && typeof e === "object" && typeof (e as any).code === "string"
    ? (e as any).code
    : undefined;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const { db, payco } = ctx;

  // Step 1: atomically load the order and decide which attempt we are on.
  // If the previous attempt was declined (definitive for its key), start a new
  // attempt with a fresh idempotency key and put the order back to pending.
  // Concurrent presses: only one transaction does the transition; the others
  // see "pending" and join the same attempt (same key -> at most one charge).
  const prep = db.transaction((tx) => {
    const order = tx.get<Order>(orderKey(orderId));
    if (!order) {
      const e: any = new Error(`order ${orderId} not found`);
      e.code = "order_not_found";
      throw e;
    }
    let state = tx.get<CheckoutState>(stateKey(orderId)) ?? { attempt: 1 };

    if (order.status === "paid") {
      return { done: true as const, order, attempt: state.attempt };
    }
    if (order.status === "declined") {
      state = { attempt: state.attempt + 1 };
      tx.set(stateKey(orderId), state);
      tx.set(orderKey(orderId), { ...order, status: "pending" as OrderStatus });
    } else if (!tx.get<CheckoutState>(stateKey(orderId))) {
      tx.set(stateKey(orderId), state);
    }
    return { done: false as const, order, attempt: state.attempt };
  });

  const { done, order, attempt } = await prep;
  if (done) return "paid";

  if (!Number.isInteger(order.amount) || order.amount <= 0) {
    const e: any = new Error(`invalid amount for order ${orderId}`);
    e.code = "invalid_amount";
    throw e;
  }

  // Step 2: charge with the attempt's idempotency key. Timeouts are retried with
  // the same key (safe per PayCo docs). If they keep timing out we throw; the
  // customer's retry reuses the same attempt/key, so no double charge.
  const idempotencyKey = chargeIdemKey(orderId, attempt);
  let charge: Charge | undefined;
  let declined = false;
  for (let i = 0; ; i++) {
    try {
      charge = await payco.createCharge({
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId, attempt: String(attempt) },
        idempotencyKey,
      });
      break;
    } catch (e) {
      const code = errCode(e);
      if (code === "card_declined") {
        declined = true;
        break;
      }
      if (code === "timeout" && i < MAX_TIMEOUT_RETRIES) {
        await sleep(200 * 2 ** i);
        continue;
      }
      // timeout (exhausted), idempotency_mismatch, or anything else: surface it.
      // State is untouched, so a retry continues the same attempt safely.
      throw e;
    }
  }

  // Step 3: record the outcome atomically, only if we are still on this attempt.
  if (charge) {
    const chargeId = charge.id;
    await db.transaction((tx) => {
      const o = tx.get<Order>(orderKey(orderId));
      if (!o) return;
      // A successful charge on any attempt means the customer paid; record it.
      // (A newer attempt can only exist if this one was declined, which
      // contradicts success, so this does not clobber a newer attempt.)
      if (o.status !== "paid") {
        tx.set(orderKey(orderId), { ...o, status: "paid" as OrderStatus });
      }
      const s = tx.get<CheckoutState>(stateKey(orderId)) ?? { attempt };
      tx.set(stateKey(orderId), { ...s, chargeId });
    });
    return "paid";
  }

  if (declined) {
    const result = await db.transaction((tx) => {
      const o = tx.get<Order>(orderKey(orderId));
      const s = tx.get<CheckoutState>(stateKey(orderId));
      if (!o) return "declined" as const;
      if (o.status === "paid") return "paid" as const; // another attempt already succeeded
      // Only mark declined if no newer attempt has started (stale-request guard).
      if (s && s.attempt === attempt && o.status === "pending") {
        tx.set(orderKey(orderId), { ...o, status: "declined" as OrderStatus });
      }
      return "declined" as const;
    });
    return result;
  }

  // Unreachable: the loop either sets charge, sets declined, or throws.
  throw new Error("unexpected checkout state");
}
