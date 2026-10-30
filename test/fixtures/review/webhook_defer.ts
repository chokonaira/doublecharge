// Each event type books its own money movement exactly once; a refund for an order we have not
// seen paid yet is deferred by throwing, relying on "If your handler throws, PayCo retries the event later".
interface Ledger { credited: boolean; refunded: number }
export async function handleWebhook(event: any, ctx: any): Promise<void> {
  const snap = event.data.charge;
  const orderId = snap.metadata.orderId;
  const order = await ctx.db.get(`order:${orderId}`);
  if (!order) throw new Error("unknown order, retry later");
  const live = await ctx.payco.getCharge(snap.id);
  const full = live.amountRefunded >= live.amount;
  if (event.type === "charge.succeeded") {
    let credit = false;
    await ctx.db.update(`ledger:${snap.id}`, (l: Ledger = { credited: false, refunded: 0 }) => {
      credit = !l.credited;
      return { ...l, credited: true };
    });
    if (credit) await ctx.db.update(`balance:${order.sellerId}`, (b = 0) => b + snap.amount);
    await ctx.db.update(`order:${orderId}`, (o: any) => ({ ...o, status: full || o.status === "refunded" ? "refunded" : "paid" }));
    if (!full) await ctx.shipping.ship(orderId, { idempotencyKey: `ship:${orderId}` });
    return;
  }
  // charge.refunded
  const ledger = await ctx.db.get(`ledger:${snap.id}`) as Ledger | undefined;
  if (!ledger?.credited) throw new Error("refund before the charge was booked; PayCo will retry later");
  let delta = 0;
  await ctx.db.update(`ledger:${snap.id}`, (l: Ledger) => {
    const total = Math.max(l.refunded, snap.amountRefunded);
    delta = total - l.refunded;
    return { ...l, refunded: total };
  });
  if (delta) await ctx.db.update(`balance:${order.sellerId}`, (b = 0) => b - delta);
  if (snap.amountRefunded >= snap.amount) await ctx.db.update(`order:${orderId}`, (o: any) => ({ ...o, status: "refunded" }));
}
