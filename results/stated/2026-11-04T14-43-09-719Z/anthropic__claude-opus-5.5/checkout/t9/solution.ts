// Types (Ctx, Db, PayCo, Charge, ...) are provided by the runtime.

type OrderStatus = "pending" | "paid" | "declined";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: OrderStatus;
}

interface AttemptState {
  attempt: number; // current attempt number; advanced only after a definite decline
}

const orderKey = (id: string) => `order:${id}`;
const attemptKey = (id: string) => `checkout_attempt:${id}`;
const paycoKey = (id: string, n: number) => `checkout:${id}:${n}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Design:
 * - Each order has an attempt counter in the Db. The PayCo idempotency key is
 *   derived from (orderId, attempt), so retries/concurrent requests reuse the
 *   same key and can never double-charge.
 * - The counter advances only after PayCo gives a *definite* decline for the
 *   current key, and it advances atomically before "declined" is returned.
 *   So a later press of Pay (after the customer was told "declined") uses a
 *   fresh key, i.e. a real new charge attempt with the updated card.
 * - On timeout we retry with the same key (always safe per PayCo docs). If it
 *   keeps timing out we throw; the caller's retry reuses the same key.
 */
export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const { db, payco } = ctx;

  const order = await db.get<Order>(orderKey(orderId));
  if (!order) {
    const err = new Error(`order ${orderId} not found`) as Error & { code: string };
    err.code = "not_found";
    throw err;
  }
  if (order.status === "paid") return "paid";

  const state = await db.get<AttemptState>(attemptKey(orderId));
  const attempt = state?.attempt ?? 0;
  const key = paycoKey(orderId, attempt);

  // Parameters must be deterministic so that retries with the same key match.
  const params = {
    amount: order.amount,
    currency: order.currency,
    customerId: order.customerId,
    metadata: { orderId, attempt: String(attempt) },
    idempotencyKey: key,
  };

  let charge: Charge | undefined;
  let declined = false;
  const maxTries = 4;
  for (let i = 0; ; i++) {
    try {
      charge = await payco.createCharge(params);
      break;
    } catch (e: any) {
      if (e?.code === "card_declined") {
        declined = true;
        break;
      }
      if (e?.code === "timeout" && i < maxTries - 1) {
        await sleep(200 * 2 ** i);
        continue;
      }
      // Still uncertain (or unexpected error): throw. A retry reuses the same
      // key, so it either finds the recorded result or processes it now.
      throw e;
    }
  }

  if (charge) {
    // The customer has been charged: record it and report paid.
    await db.transaction((tx) => {
      const o = tx.get<Order>(orderKey(orderId));
      if (o && o.status !== "paid") {
        tx.set<Order>(orderKey(orderId), { ...o, status: "paid" });
      }
      tx.set(`order_charge:${orderId}`, { chargeId: charge!.id, attempt });
    });
    return "paid";
  }

  // Definite decline for key `attempt`. Atomically advance the attempt counter
  // (so future presses use a fresh key) and mark declined, unless the order
  // has since been paid by another request.
  const result = await db.transaction<"paid" | "declined">((tx) => {
    const o = tx.get<Order>(orderKey(orderId));
    if (o && o.status === "paid") return "paid";
    const s = tx.get<AttemptState>(attemptKey(orderId));
    const cur = s?.attempt ?? 0;
    if (cur === attempt) {
      tx.set<AttemptState>(attemptKey(orderId), { attempt: attempt + 1 });
      if (o) tx.set<Order>(orderKey(orderId), { ...o, status: "declined" });
    }
    // If cur > attempt, a concurrent request that saw the same decline already
    // advanced the counter. This request started before that decline was told,
    // so reporting it is still truthful. A charge made under a newer key after
    // we last looked is a race no handler can prevent.
    return "declined";
  });
  return result;
}
