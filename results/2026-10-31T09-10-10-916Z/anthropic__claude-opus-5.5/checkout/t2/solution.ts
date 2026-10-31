// Checkout with protection against double charges.
//
// Design:
// - A per-order checkout record `checkout:<orderId>` holds { attempt, state, chargeId? }.
// - Each attempt uses the PayCo idempotency key `checkout:<orderId>:<attempt>`.
//   A retry after a crash or timeout, or a concurrent duplicate request, reuses the
//   same attempt and key. PayCo then returns the original result and never charges twice.
// - The attempt number moves forward only after a decline has been recorded. A customer
//   who updates their card and presses Pay again gets a fresh key, so PayCo does not
//   replay the cached decline.
// - The order status and the checkout record are updated together in one Db transaction.
//
// Limitation: an instance can be killed after PayCo declined the card but before the
// decline was saved. The retry then reuses the old key and PayCo replays that decline,
// even if the card was updated in between. The customer sees "declined" and can press
// Pay once more, which starts a new attempt. No money is taken incorrectly.

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface CheckoutRecord {
  attempt: number;
  state: "inflight" | "declined" | "paid";
  chargeId?: string;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const { db, payco } = ctx;
  const orderKey = `order:${orderId}`;
  const recKey = `checkout:${orderId}`;

  const order = await db.get<Order>(orderKey);
  if (!order) {
    const err: any = new Error(`Order ${orderId} not found`);
    err.code = "order_not_found";
    throw err;
  }
  if (order.status === "paid") return "paid";

  // Claim or resume an attempt atomically.
  const rec = await db.update<CheckoutRecord>(recKey, (cur) => {
    if (!cur) return { attempt: 1, state: "inflight" };
    if (cur.state === "declined") return { attempt: cur.attempt + 1, state: "inflight" };
    return cur; // "inflight" (resume with the same key) or "paid"
  });

  if (rec.state === "paid") {
    // The order may not show "paid" yet if an earlier run crashed mid-way. Repair it.
    await db.transaction((tx) => {
      const o = tx.get<Order>(orderKey);
      if (o && o.status !== "paid") tx.set(orderKey, { ...o, status: "paid" });
    });
    return "paid";
  }

  const attempt = rec.attempt;
  let charge: Charge;
  try {
    charge = await payco.createCharge({
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      metadata: { orderId, attempt: String(attempt) },
      idempotencyKey: `checkout:${orderId}:${attempt}`,
    });
  } catch (e: any) {
    if (e && e.code === "card_declined") {
      const result = await db.transaction((tx) => {
        const r = tx.get<CheckoutRecord>(recKey);
        if (r && r.state === "paid") return "paid" as const;
        if (r && r.attempt === attempt && r.state === "inflight") {
          tx.set<CheckoutRecord>(recKey, { attempt, state: "declined" });
        }
        const o = tx.get<Order>(orderKey);
        if (o && o.status !== "paid") {
          tx.set(orderKey, { ...o, status: "declined" });
          return "declined" as const;
        }
        return o && o.status === "paid" ? ("paid" as const) : ("declined" as const);
      });
      return result;
    }
    // A timeout or any other error leaves the attempt "inflight". A retry reuses the
    // same key, so the charge either completes now or PayCo returns the recorded result.
    throw e;
  }

  // The charge succeeded. Record it, overriding any status a reconciliation job may have
  // set in the meantime, because the money has been taken.
  await db.transaction((tx) => {
    tx.set<CheckoutRecord>(recKey, { attempt, state: "paid", chargeId: charge.id });
    const o = tx.get<Order>(orderKey);
    if (o) tx.set(orderKey, { ...o, status: "paid" });
  });
  return "paid";
}
