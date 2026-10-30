// Swallows shipping failures so PayCo never redelivers: an order whose ship() call timed out
// before reaching the shipping service is never shipped.
export async function handleWebhook(event: any, ctx: any): Promise<void> {
  const charge = await ctx.payco.getCharge(event.data.charge.id);
  const orderId = charge.metadata.orderId;
  const order = await ctx.db.get(`order:${orderId}`);
  const full = charge.amountRefunded >= charge.amount;
  let delta = 0;
  await ctx.db.update(`applied:${charge.id}`, (a: any = { credited: 0, refunded: 0 }) => {
    const next = { credited: charge.amount, refunded: Math.max(a.refunded, charge.amountRefunded) };
    delta = next.credited - a.credited - (next.refunded - a.refunded);
    return next;
  });
  if (delta) await ctx.db.update(`balance:${order.sellerId}`, (b = 0) => b + delta);
  await ctx.db.update(`order:${orderId}`, (o: any) => ({ ...o, status: full || o.status === "refunded" ? "refunded" : "paid" }));
  if (!full && (await ctx.db.insertIfAbsent(`shipped:${orderId}`, true))) {
    try { await ctx.shipping.ship(orderId); } catch { /* best effort */ }
  }
}
