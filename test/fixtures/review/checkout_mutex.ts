// get/set only; double-click safety comes from an in-process mutex keyed by orderId.
const locks = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  locks.set(key, run);
  return run.finally(() => { if (locks.get(key) === run) locks.delete(key); });
}
const code = (e: unknown) => (e as { code?: string })?.code;
export function checkout(orderId: string, ctx: any): Promise<"paid" | "declined"> {
  return serial(orderId, async () => {
    const order = await ctx.db.get(`order:${orderId}`);
    if (order.status === "paid") return "paid";
    const attempt = (order.attempt ?? 0) + (order.status === "declined" ? 1 : 0);
    await ctx.db.set(`order:${orderId}`, { ...order, status: "pending", attempt });
    for (let i = 1; ; i++) {
      try {
        await ctx.payco.createCharge({ amount: order.amount, currency: order.currency, customerId: order.customerId, idempotencyKey: `${orderId}:${attempt}` });
        await ctx.db.set(`order:${orderId}`, { ...order, status: "paid", attempt });
        return "paid";
      } catch (e) {
        if (code(e) === "card_declined") { await ctx.db.set(`order:${orderId}`, { ...order, status: "declined", attempt }); return "declined"; }
        if (code(e) === "timeout" && i < 4) continue;
        throw e;
      }
    }
  });
}
