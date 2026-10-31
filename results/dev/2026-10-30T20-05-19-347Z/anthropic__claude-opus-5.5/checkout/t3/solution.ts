// Types Ctx, Db, Tx, PayCo, Charge are provided by the runtime.

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface CheckoutState {
  attempt: number;   // current attempt number; changes only after a recorded decline
  chargeId?: string; // set once paid
}

/**
 * Every charge attempt for an order uses the PayCo idempotency key
 * `checkout:<orderId>:<attempt>`. The attempt counter lives in the Db.
 *
 * - Retries, concurrent clicks and crashes after PayCo charged the card all
 *   reuse the same key. PayCo returns the original charge, so there is no
 *   double charge. We then (re)mark the order paid.
 * - A timeout is rethrown. A retry with the same key is safe.
 * - On decline, the order is marked "declined" and the attempt counter is
 *   advanced atomically. This happens only if the counter still equals the
 *   attempt that declined, so concurrent decliners advance it once. The next
 *   Pay press then uses a fresh key, and PayCo really retries the
 *   (possibly updated) saved card instead of returning the cached decline.
 * - A new attempt number only exists after the previous attempt was
 *   recorded as declined. So at most one attempt per order can ever succeed.
 */
export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const { db, payco } = ctx;
  const orderKey = `order:${orderId}`;
  const stateKey = `checkout:${orderId}`;

  const order = await db.get<Order>(orderKey);
  if (!order) {
    throw Object.assign(new Error(`Order ${orderId} not found`), { code: "order_not_found" });
  }
  if (order.status === "paid") return "paid";

  const state = (await db.get<CheckoutState>(stateKey)) ?? { attempt: 0 };
  if (state.chargeId) {
    // Paid charge recorded, but the order status write may not be visible yet.
    await markPaid(db, orderKey, stateKey, state.chargeId);
    return "paid";
  }
  const attempt = state.attempt;

  let charge: Charge;
  try {
    charge = await payco.createCharge({
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      metadata: { orderId: order.id, attempt: String(attempt) },
      idempotencyKey: `checkout:${orderId}:${attempt}`,
    });
  } catch (err: any) {
    if (err && err.code === "card_declined") {
      const result = await db.transaction<"paid" | "declined">((tx) => {
        const o = tx.get<Order>(orderKey);
        if (!o) throw new Error(`Order ${orderId} disappeared`);
        if (o.status === "paid") return "paid";
        const s = tx.get<CheckoutState>(stateKey) ?? { attempt: 0 };
        if (s.chargeId) return "paid";
        if (s.attempt === attempt) {
          tx.set<CheckoutState>(stateKey, { attempt: attempt + 1 });
        }
        // If the counter already moved past us, another request recorded this
        // decline. A newer attempt may be in flight; marking declined is still
        // consistent, because a later success overwrites it with "paid".
        tx.set<Order>(orderKey, { ...o, status: "declined" });
        return "declined";
      });
      return result;
    }
    // timeout, idempotency_mismatch, network errors: let the caller retry.
    // Retrying with the same key is safe.
    throw err;
  }

  await markPaid(db, orderKey, stateKey, charge.id);
  return "paid";
}

async function markPaid(db: Db, orderKey: string, stateKey: string, chargeId: string): Promise<void> {
  await db.transaction((tx) => {
    const o = tx.get<Order>(orderKey);
    if (!o) throw new Error(`Order ${orderKey} disappeared`);
    const s = tx.get<CheckoutState>(stateKey) ?? { attempt: 0 };
    tx.set<CheckoutState>(stateKey, { ...s, chargeId });
    if (o.status !== "paid") tx.set<Order>(orderKey, { ...o, status: "paid" });
    return undefined;
  });
}
