// PayCo webhook handler.
//
// Each charge has a record in the Db that stores two facts:
// - `credited`: whether the charge amount was added to the seller's balance.
// - `refundApplied`: the highest cumulative `amountRefunded` already subtracted.
// The record, the order and the seller balance are updated in one Db
// transaction. Because of this:
// - Duplicate or concurrent deliveries change nothing a second time.
// - Events can arrive in any order. Refund events carry cumulative totals,
//   so only the increase over `refundApplied` is applied. A stale refund
//   event is a no-op.
// - A refund event arriving before charge.succeeded still credits the charge
//   once. PayCo only reports succeeded charges, so the charge did succeed.
// After all events are delivered, the balance holds amount - totalRefunded
// and the status is "refunded" iff totalRefunded >= amount, otherwise "paid".
//
// Shipping happens outside the transaction, with the stable idempotency key
// `ship:<orderId>`. Duplicate or retried calls cannot create two shipments.
// On `timeout` or any other error we rethrow so PayCo redelivers the event,
// and the retry reuses the same key.
// Before shipping we re-read the charge from PayCo and skip it if it is
// fully refunded.
// Limitation: a refund that happens between that check and `ship()` cannot
// be prevented with the APIs available. The order then ships, but the
// balance and status are still corrected by the refund event.

interface OrderRec {
  id: string;
  sellerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "refunded";
}

interface ChargeRec {
  chargeId: string;
  orderId: string;
  amount: number;
  credited: boolean;
  refundApplied: number;
  shipped: boolean;
}

export async function handleWebhook(event: PayCoEvent, ctx: Ctx): Promise<void> {
  if (event.type !== "charge.succeeded" && event.type !== "charge.refunded") return;
  const charge = event.data?.charge;
  if (!charge) return;
  const orderId = charge.metadata?.orderId;
  if (!orderId) return; // Not a marketplace order charge.

  const orderKey = `order:${orderId}`;
  const chargeKey = `charge:${charge.id}`;
  const refundedTotal = Math.max(0, charge.amountRefunded ?? 0);

  const result = await ctx.db.transaction((tx) => {
    const order = tx.get<OrderRec>(orderKey);
    if (!order) return undefined;

    const rec: ChargeRec = tx.get<ChargeRec>(chargeKey) ?? {
      chargeId: charge.id,
      orderId,
      amount: charge.amount,
      credited: false,
      refundApplied: 0,
      shipped: false,
    };

    const balanceKey = `balance:${order.sellerId}`;
    let balance = tx.get<number>(balanceKey) ?? 0;

    if (!rec.credited) {
      balance += rec.amount;
      rec.credited = true;
    }
    if (refundedTotal > rec.refundApplied) {
      balance -= refundedTotal - rec.refundApplied;
      rec.refundApplied = refundedTotal;
    }

    const fullyRefunded = rec.refundApplied >= rec.amount;
    const newOrder: OrderRec = { ...order, status: fullyRefunded ? "refunded" : "paid" };

    tx.set(balanceKey, balance);
    tx.set(chargeKey, rec);
    tx.set(orderKey, newOrder);
    return { rec, order: newOrder };
  });

  if (!result) return; // Unknown order: nothing to reconcile.
  const { rec, order } = result;
  if (rec.shipped || order.status !== "paid") return;

  // Re-read the charge from PayCo to avoid shipping an order that has
  // already been fully refunded. Errors propagate, so PayCo retries.
  const fresh = await ctx.payco.getCharge(charge.id);
  if (fresh.amountRefunded >= fresh.amount) {
    // Apply the newer refund total now. Its refund event will also arrive
    // and will be a no-op for the balance.
    await ctx.db.transaction((tx) => {
      const o = tx.get<OrderRec>(orderKey);
      const r = tx.get<ChargeRec>(chargeKey);
      if (!o || !r) return;
      if (fresh.amountRefunded > r.refundApplied) {
        const bk = `balance:${o.sellerId}`;
        tx.set(bk, (tx.get<number>(bk) ?? 0) - (fresh.amountRefunded - r.refundApplied));
        r.refundApplied = fresh.amountRefunded;
        tx.set(chargeKey, r);
      }
      if (r.refundApplied >= r.amount) tx.set(orderKey, { ...o, status: "refunded" });
    });
    return;
  }

  await ctx.shipping.ship(orderId, { idempotencyKey: `ship:${orderId}` });

  await ctx.db.update<ChargeRec>(chargeKey, (cur) => {
    if (!cur) throw new Error("charge record missing");
    return { ...cur, shipped: true };
  });
}
