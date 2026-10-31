// PayCo webhook handler.
//
// How it works:
// 1. Every event (succeeded or refunded) proves the charge succeeded. Its order
//    is credited exactly once per charge, whichever event arrives first.
// 2. Refunds are cumulative (`amountRefunded` is the running total). Per charge
//    we store the highest total already applied. Only the difference is
//    subtracted, so duplicates and reordering are harmless.
// 3. Order status, balance and per-charge bookkeeping change in ONE Db
//    transaction. A crash never leaves them half-applied.
// 4. Shipping happens after the transaction commits. It uses an idempotency key
//    derived from the order id, and a `shipped:<orderId>` marker is written only
//    after it succeeds. If we crash before or during `ship`, the handler fails;
//    PayCo redelivers and we retry with the same key, so the order ships once.
//
// Limitation: a refund issued at PayCo in the instant between our final check
// (fresh getCharge + order status) and the ship() call can't be prevented with
// these APIs. Shipping has no cancel and PayCo has no lock. We keep that window
// as small as possible. Balances and statuses stay correct regardless.

interface OrderRec {
  id: string;
  sellerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "refunded";
}

interface ChargeRec {
  amount: number;   // amount credited to the seller for this charge
  refunded: number; // highest cumulative refunded amount already applied
}

type OrderCharges = Record<string, ChargeRec>;

function codedError(code: string, message: string): Error {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

export async function handleWebhook(event: PayCoEvent, ctx: Ctx): Promise<void> {
  if (event.type !== "charge.succeeded" && event.type !== "charge.refunded") return;
  const charge = event.data?.charge;
  if (!charge) return;
  const orderId = charge.metadata?.orderId;
  if (!orderId) return; // not a marketplace order charge; nothing to do

  const orderKey = `order:${orderId}`;
  const chargesKey = `orderCharges:${orderId}`;

  // --- Step 1: atomically apply the accounting effects of this event. ---
  const status = await ctx.db.transaction((tx: Tx) => {
    const order = tx.get<OrderRec>(orderKey);
    if (!order) {
      // Throwing makes PayCo retry later, in case the order is not yet visible.
      throw codedError("order_not_found", `order ${orderId} not found`);
    }
    const balanceKey = `balance:${order.sellerId}`;
    let balance = tx.get<number>(balanceKey) ?? 0;
    const charges: OrderCharges = { ...(tx.get<OrderCharges>(chargesKey) ?? {}) };

    let rec = charges[charge.id];
    if (!rec) {
      // First time we see this charge: credit the seller once.
      rec = { amount: charge.amount, refunded: 0 };
      balance += charge.amount;
    } else {
      rec = { ...rec };
    }

    const reported = Math.max(0, Math.min(charge.amountRefunded ?? 0, rec.amount));
    if (reported > rec.refunded) {
      balance -= reported - rec.refunded;
      rec.refunded = reported;
    }
    charges[charge.id] = rec;

    // Paid if any charge still has unrefunded money, otherwise refunded.
    const anyLive = Object.values(charges).some((c) => c.refunded < c.amount);
    const newStatus: OrderRec["status"] = anyLive ? "paid" : "refunded";

    tx.set(chargesKey, charges);
    tx.set(balanceKey, balance);
    if (order.status !== newStatus) tx.set(orderKey, { ...order, status: newStatus });
    return newStatus;
  });

  // --- Step 2: ship if the order is paid and not yet shipped. ---
  if (status !== "paid") return;
  const shippedKey = `shipped:${orderId}`;
  if (await ctx.db.get<boolean>(shippedKey)) return;

  // Re-check against PayCo's current view, not the possibly stale event snapshot.
  const fresh = await ctx.payco.getCharge(charge.id);
  if (fresh.amountRefunded >= fresh.amount) {
    // This charge is now fully refunded. Record it so the order goes to
    // "refunded" if nothing else is live. Don't ship from this charge; another
    // live charge of this order (if any) ships via its own events.
    await handleRefundSnapshot(fresh, orderId, ctx);
    return;
  }

  // Final status check right before shipping, in case a refund event landed meanwhile.
  const current = await ctx.db.get<OrderRec>(orderKey);
  if (!current || current.status !== "paid") return;

  // If this times out, the error propagates. PayCo redelivers and we retry with
  // the same key, which never creates a second shipment.
  await ctx.shipping.ship(orderId, { idempotencyKey: `ship:${orderId}` });
  await ctx.db.set(shippedKey, true);
}

// Applies a fresher refund total seen via getCharge, using the same rules as above.
async function handleRefundSnapshot(fresh: Charge, orderId: string, ctx: Ctx): Promise<void> {
  const orderKey = `order:${orderId}`;
  const chargesKey = `orderCharges:${orderId}`;
  await ctx.db.transaction((tx: Tx) => {
    const order = tx.get<OrderRec>(orderKey);
    if (!order) return;
    const balanceKey = `balance:${order.sellerId}`;
    let balance = tx.get<number>(balanceKey) ?? 0;
    const charges: OrderCharges = { ...(tx.get<OrderCharges>(chargesKey) ?? {}) };
    let rec = charges[fresh.id];
    if (!rec) {
      rec = { amount: fresh.amount, refunded: 0 };
      balance += fresh.amount;
    } else {
      rec = { ...rec };
    }
    const reported = Math.max(0, Math.min(fresh.amountRefunded, rec.amount));
    if (reported > rec.refunded) {
      balance -= reported - rec.refunded;
      rec.refunded = reported;
    }
    charges[fresh.id] = rec;
    const anyLive = Object.values(charges).some((c) => c.refunded < c.amount);
    const newStatus: OrderRec["status"] = anyLive ? "paid" : "refunded";
    tx.set(chargesKey, charges);
    tx.set(balanceKey, balance);
    if (order.status !== newStatus) tx.set(orderKey, { ...order, status: newStatus });
  });
}
