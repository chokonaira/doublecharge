// Classic at-most-once bug: claims the event id BEFORE doing the work, so if the handler dies
// half-way (shipping times out, process crashes) PayCo's redelivery is skipped and the work is lost.
// Also ships without an idempotency key.
export async function handleWebhook(event: any, ctx: any): Promise<void> {
  if (!(await ctx.db.insertIfAbsent(`event:${event.id}`, true))) return;
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
  if (event.type === "charge.succeeded" && !full) await ctx.shipping.ship(orderId);
}
