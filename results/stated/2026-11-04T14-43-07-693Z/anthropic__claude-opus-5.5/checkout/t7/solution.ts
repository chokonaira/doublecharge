// Checkout with crash-safe, retry-safe, multi-instance-safe charging.
//
// Design:
// - Each payment *attempt* for an order has a stable PayCo idempotency key:
//   `checkout:<orderId>:<n>`. Any retry of the same attempt, from any instance,
//   after any crash, reuses the same key, so PayCo charges at most once per attempt.
// - We only move to attempt n+1 once attempt n is known to be DECLINED, which
//   PayCo guarantees created no charge. Therefore at most one attempt can ever
//   succeed, so the customer is charged at most once per order.
// - The step from n to n+1 happens inside a Db transaction. Concurrent
//   "Pay again" presses therefore agree on a single new attempt number.
// - The amount and currency are frozen into the attempt record. If the order
//   changes, a retry still sends identical parameters for the same key.
// - On timeout we retry a few times inline with the same key. That is always
//   safe. If it still times out we throw. The caller's retry resumes the same
//   attempt with the same key.

type OrderStatus = "pending" | "paid" | "declined";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: OrderStatus;
}

interface AttemptRecord {
  n: number; // current attempt number
  amount: number;
  currency: string;
  customerId: string;
  declinedN: number; // highest attempt number known to be declined (0 = none)
  chargeId?: string; // set once an attempt succeeded
}

const orderKey = (id: string) => `order:${id}`;
const attemptKey = (id: string) => `checkout:${id}`;

function errCode(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : undefined;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const { db, payco } = ctx;

  // Step 1: atomically decide which attempt this request belongs to.
  const decision = db.transaction((tx) => {
    const order = tx.get<Order>(orderKey(orderId));
    if (!order) {
      const e = new Error(`order ${orderId} not found`) as Error & { code: string };
      e.code = "order_not_found";
      throw e;
    }
    if (order.status === "paid") {
      return { done: true as const };
    }

    let rec = tx.get<AttemptRecord>(attemptKey(orderId));
    if (!rec) {
      rec = {
        n: 1,
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        declinedN: 0,
      };
      tx.set(attemptKey(orderId), rec);
    } else if (rec.chargeId) {
      // A charge already succeeded, but the order update was lost
      // (for example, a crash between the two writes). Repair it.
      tx.set<Order>(orderKey(orderId), { ...order, status: "paid" });
      return { done: true as const };
    } else if (rec.declinedN >= rec.n) {
      // The current attempt was declined, and the customer pressed Pay again.
      // Start a fresh attempt. No charge exists for any earlier attempt.
      rec = {
        ...rec,
        n: rec.n + 1,
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
      };
      tx.set(attemptKey(orderId), rec);
      if (order.status === "declined") {
        tx.set<Order>(orderKey(orderId), { ...order, status: "pending" });
      }
    }
    // Otherwise the attempt rec.n is in progress or unknown (for example, a crash
    // or timeout). Resume it with the same idempotency key.
    return { done: false as const, rec };
  });

  const d = await decision;
  if (d.done) return "paid";
  const rec = d.rec;
  const n = rec.n;
  const idempotencyKey = `checkout:${orderId}:${n}`;

  // Step 2: charge. Retry timeouts inline with the same key, which is safe per PayCo.
  let charge: Charge | undefined;
  let declined = false;
  const maxTries = 3;
  for (let i = 0; i < maxTries; i++) {
    try {
      charge = await payco.createCharge({
        amount: rec.amount,
        currency: rec.currency,
        customerId: rec.customerId,
        metadata: { orderId, attempt: String(n) },
        idempotencyKey,
      });
      break;
    } catch (e) {
      const code = errCode(e);
      if (code === "card_declined") {
        declined = true;
        break;
      }
      if (code === "timeout" && i < maxTries - 1) {
        await new Promise((r) => setTimeout(r, 200 * (i + 1)));
        continue;
      }
      // A final timeout, or any other error. The outcome is unknown, so we throw.
      // The customer's retry, or the reconciliation job, resumes attempt n
      // with the same key.
      throw e;
    }
  }

  if (charge) {
    const chargeId = charge.id;
    await db.transaction((tx) => {
      const cur = tx.get<AttemptRecord>(attemptKey(orderId));
      if (cur && cur.n === n) tx.set(attemptKey(orderId), { ...cur, chargeId });
      const order = tx.get<Order>(orderKey(orderId));
      // The money has been taken, so the order is paid. This overrides any
      // "declined" status, for example one set by reconciliation.
      if (order && order.status !== "paid") {
        tx.set<Order>(orderKey(orderId), { ...order, status: "paid" });
      }
    });
    return "paid";
  }

  if (declined) {
    const result = await db.transaction((tx) => {
      const order = tx.get<Order>(orderKey(orderId));
      if (order?.status === "paid") return "paid" as const;
      const cur = tx.get<AttemptRecord>(attemptKey(orderId));
      if (cur && cur.n === n && cur.declinedN < n) {
        tx.set(attemptKey(orderId), { ...cur, declinedN: n });
      }
      // Only mark the order declined if no newer attempt has started.
      if (order && cur && cur.n === n) {
        tx.set<Order>(orderKey(orderId), { ...order, status: "declined" });
      }
      return "declined" as const;
    });
    return result;
  }

  // This is unreachable: the loop either sets charge or declined, or throws.
  throw Object.assign(new Error("checkout: unexpected state"), { code: "internal" });
}
