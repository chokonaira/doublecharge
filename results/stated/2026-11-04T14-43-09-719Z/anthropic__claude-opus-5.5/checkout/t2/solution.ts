import { setTimeout as sleep } from "node:timers/promises";

// Local declarations of the runtime-provided shapes we rely on.
type OrderStatus = "pending" | "paid" | "declined";
interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: OrderStatus;
}

/**
 * Durable per-order checkout state, shared across all instances.
 * - "charging": attempt `attempt` is (or was) in flight. Anyone may re-send it with the
 *   same idempotency key; PayCo will either process it once or return the recorded result.
 * - "declined": PayCo declined attempt `attempt`. The next Pay press starts attempt+1
 *   with a new key, so the customer's updated card is actually tried.
 * - "paid": a charge succeeded.
 * We only move to a new attempt from a recorded decline. So an attempt that might have
 * succeeded (timeout, crash) is never abandoned; it is always resolved via its own key.
 */
interface CheckoutState {
  attempt: number;
  state: "charging" | "declined" | "paid";
  chargeId?: string;
}

const orderKey = (id: string) => `order:${id}`;
const stateKey = (id: string) => `checkout:${id}`;
const idemKey = (id: string, attempt: number) => `checkout:${id}:attempt:${attempt}`;

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

async function markPaid(ctx: Ctx, orderId: string, attempt: number, chargeId?: string): Promise<"paid"> {
  await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey(orderId));
    if (order && order.status !== "paid") tx.set(orderKey(orderId), { ...order, status: "paid" });
    const st = tx.get<CheckoutState>(stateKey(orderId));
    tx.set<CheckoutState>(stateKey(orderId), {
      attempt: Math.max(st?.attempt ?? attempt, attempt),
      state: "paid",
      chargeId: chargeId ?? st?.chargeId,
    });
  });
  return "paid";
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const { db, payco } = ctx;

  const order = await db.get<Order>(orderKey(orderId));
  if (!order) throw err("order_not_found", `order ${orderId} not found`);
  if (order.status === "paid") return "paid";

  // Atomically pick the attempt to use:
  // - none yet               -> attempt 1
  // - previous attempt declined -> new attempt (fresh key). A decline already on record
  //   may have been told to the customer, so we never re-report it.
  // - charging               -> reuse the same key (retry / crash recovery / concurrent press)
  // - paid                   -> nothing to do
  const st = await db.update<CheckoutState>(stateKey(orderId), (cur) => {
    if (!cur) return { attempt: 1, state: "charging" };
    if (cur.state === "declined") return { attempt: cur.attempt + 1, state: "charging" };
    return cur;
  });
  if (st.state === "paid") return markPaid(ctx, orderId, st.attempt, st.chargeId);

  const attempt = st.attempt;
  const key = idemKey(orderId, attempt);

  // Send the charge. On timeout, retry with the SAME key. That is always safe and either
  // performs the charge once or returns PayCo's recorded result (success or decline).
  let charge: Charge | undefined;
  let declined = false;
  const maxTries = 4;
  for (let i = 0; ; i++) {
    try {
      charge = await payco.createCharge({
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId, attempt: String(attempt) },
        idempotencyKey: key,
      });
      break;
    } catch (e: any) {
      const code = e?.code;
      if (code === "card_declined") {
        declined = true;
        break;
      }
      if (code === "timeout" && i < maxTries - 1) {
        await sleep(200 * 2 ** i);
        continue;
      }
      // Unknown outcome (persistent timeout) or unexpected error. We leave the state as
      // "charging" so the next Pay press reuses this key and resolves it safely.
      throw e;
    }
  }

  if (charge && !declined) return markPaid(ctx, orderId, attempt, charge.id);

  // Our own most recent charge request was declined. Before telling the customer
  // "declined", make sure they have not actually been charged for this order by some
  // other attempt. Example: data from an older code version, or another path.
  // If listCharges fails we throw, because throwing is always a safe answer.
  const charges = await payco.listCharges({ customerId: order.customerId });
  const existing = charges.find((c) => c.status === "succeeded" && c.metadata?.orderId === orderId);
  if (existing) return markPaid(ctx, orderId, attempt, existing.id);

  // Record the decline atomically with the order status, unless the order is already paid.
  return db.transaction((tx) => {
    const o = tx.get<Order>(orderKey(orderId));
    const s = tx.get<CheckoutState>(stateKey(orderId));
    if (o?.status === "paid" || s?.state === "paid") {
      // We read the order as paid, so the truthful answer is "paid".
      if (o && o.status !== "paid") tx.set(orderKey(orderId), { ...o, status: "paid" });
      return "paid" as const;
    }
    // Only record our decline if the state still refers to our attempt and is unresolved.
    // If it moved on, a decline for our attempt was already recorded by a concurrent
    // request. Our answer is still a truthful, fresh decline from this request's own call.
    if (s && s.attempt === attempt && s.state === "charging") {
      tx.set<CheckoutState>(stateKey(orderId), { attempt, state: "declined" });
    }
    if (o && o.status !== "declined" && (!s || s.attempt === attempt)) {
      tx.set(orderKey(orderId), { ...o, status: "declined" });
    }
    return "declined" as const;
  });
}
