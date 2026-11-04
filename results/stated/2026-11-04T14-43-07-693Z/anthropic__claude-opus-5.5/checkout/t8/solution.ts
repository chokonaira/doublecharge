// Types Ctx, Db, Tx, PayCo, Charge are provided by the runtime.

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

/**
 * One record per order describing the current charge attempt.
 * - n: attempt number, used in the PayCo idempotency key.
 * - status "open": a charge with key n may be in flight or already done at PayCo.
 *   Any retry (on any instance, after a crash, timeout, ...) must reuse the same key,
 *   so PayCo returns the original result instead of charging twice.
 * - status "declined": attempt n was declined. The next Pay press starts attempt n+1
 *   with a fresh key, so PayCo really retries (with the possibly updated saved card)
 *   instead of replaying the cached decline.
 * - amount/currency/customerId are frozen per attempt, so a reused key always has
 *   identical parameters and never hits idempotency_mismatch.
 */
interface Attempt {
  n: number;
  status: "open" | "declined" | "paid";
  amount: number;
  currency: string;
  customerId: string;
  chargeId?: string;
}

const orderKey = (id: string) => `order:${id}`;
const attemptKey = (id: string) => `checkout_attempt:${id}`;

type Begin =
  | { kind: "done"; result: "paid" }
  | { kind: "charge"; attempt: Attempt };

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const { db, payco } = ctx;

  // 1. Atomically decide which attempt this request works on.
  const begin = await db.transaction<Begin>((tx) => {
    const order = tx.get<Order>(orderKey(orderId));
    if (!order) {
      const err: any = new Error(`order ${orderId} not found`);
      err.code = "order_not_found";
      throw err;
    }
    if (order.status === "paid") return { kind: "done", result: "paid" };

    const cur = tx.get<Attempt>(attemptKey(orderId));
    if (cur && cur.status === "paid") {
      // Charge recorded but order not marked (should not happen; both are written together).
      tx.set<Order>(orderKey(orderId), { ...order, status: "paid" });
      return { kind: "done", result: "paid" };
    }
    if (cur && cur.status === "open") {
      // Retry of an in-flight, crashed or timed-out attempt: reuse the same key.
      return { kind: "charge", attempt: cur };
    }

    // No attempt yet, or the previous one was declined: start a new attempt.
    const next: Attempt = {
      n: cur ? cur.n + 1 : 1,
      status: "open",
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
    };
    tx.set<Attempt>(attemptKey(orderId), next);
    if (order.status !== "pending") {
      tx.set<Order>(orderKey(orderId), { ...order, status: "pending" });
    }
    return { kind: "charge", attempt: next };
  });

  if (begin.kind === "done") return begin.result;
  const attempt = begin.attempt;

  // 2. Charge with a deterministic idempotency key for this attempt.
  let charge: Charge;
  try {
    charge = await payco.createCharge({
      amount: attempt.amount,
      currency: attempt.currency,
      customerId: attempt.customerId,
      metadata: { orderId, attempt: String(attempt.n) },
      idempotencyKey: `checkout:${orderId}:${attempt.n}`,
    });
  } catch (e: any) {
    if (e && e.code === "card_declined") {
      // Record the decline atomically, but only if this attempt is still current and open.
      return await db.transaction<"paid" | "declined">((tx) => {
        const order = tx.get<Order>(orderKey(orderId));
        const cur = tx.get<Attempt>(attemptKey(orderId));
        if (order && order.status === "paid") return "paid";
        if (cur && cur.n === attempt.n && cur.status === "open") {
          tx.set<Attempt>(attemptKey(orderId), { ...cur, status: "declined" });
          if (order) tx.set<Order>(orderKey(orderId), { ...order, status: "declined" });
        }
        return "declined";
      });
    }
    // timeout, idempotency_mismatch or anything else: the outcome is unknown.
    // Throw; the customer's retry reuses the same open attempt and key, so PayCo
    // either processes it now or returns the recorded result. No double charge.
    throw e;
  }

  // 3. Charge succeeded: mark attempt and order paid together.
  await db.transaction<void>((tx) => {
    const order = tx.get<Order>(orderKey(orderId));
    const cur = tx.get<Attempt>(attemptKey(orderId));
    if (cur && cur.n === attempt.n) {
      tx.set<Attempt>(attemptKey(orderId), { ...cur, status: "paid", chargeId: charge.id });
    }
    if (order && order.status !== "paid") {
      tx.set<Order>(orderKey(orderId), { ...order, status: "paid" });
    }
  });
  return "paid";
}
