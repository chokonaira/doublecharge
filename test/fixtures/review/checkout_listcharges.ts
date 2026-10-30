// Alternative design: no idempotency keys. A per-order lock in the db plus reconciliation against
// PayCo's list of charges (tagged with metadata.orderId) before and after every charge attempt.
const code = (e: unknown) => (e as { code?: string })?.code;
async function findCharge(ctx: any, order: any) {
  const charges = await ctx.payco.listCharges({ customerId: order.customerId });
  return charges.find((c: any) => c.metadata?.orderId === order.id && c.amount === order.amount);
}
export async function checkout(orderId: string, ctx: any): Promise<"paid" | "declined"> {
  const key = `order:${orderId}`;
  const order = await ctx.db.get(key);
  if (order.status === "paid") return "paid";
  if (!(await ctx.db.insertIfAbsent(`lock:${orderId}`, true))) throw new Error("payment in progress, try again");
  try {
    for (let tries = 1; tries <= 4; tries++) {
      if (await findCharge(ctx, order)) { await ctx.db.update(key, (o: any) => ({ ...o, status: "paid" })); return "paid"; }
      try {
        await ctx.payco.createCharge({ amount: order.amount, currency: order.currency, customerId: order.customerId, metadata: { orderId } });
        await ctx.db.update(key, (o: any) => ({ ...o, status: "paid" }));
        return "paid";
      } catch (e) {
        if (code(e) === "card_declined") { await ctx.db.update(key, (o: any) => ({ ...o, status: "declined" })); return "declined"; }
        if (code(e) !== "timeout") throw e;
      }
    }
    throw new Error("PayCo unavailable, try again");
  } finally {
    await ctx.db.delete(`lock:${orderId}`);
  }
}
