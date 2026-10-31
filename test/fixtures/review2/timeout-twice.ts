// Retries a timeout once with the same key; if the retry also times out, gives up and calls it a decline.
import { errorCode, type Ctx } from "../../../src/world/index.ts";
interface Order { id: string; customerId: string; amount: number; currency: string; status: string; attempt?: number }
export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const key = `order:${orderId}`;
  const order = (await ctx.db.get<Order>(key))!;
  if (order.status === "paid") return "paid";
  const attempt = order.status === "declined" ? (order.attempt ?? 0) + 1 : (order.attempt ?? 0);
  for (let tries = 1; ; tries++) {
    try {
      await ctx.payco.createCharge({ amount: order.amount, currency: order.currency, customerId: order.customerId, metadata: { orderId }, idempotencyKey: `${orderId}:${attempt}` });
      await ctx.db.update<Order>(key, (o) => ({ ...o!, status: "paid", attempt }));
      return "paid";
    } catch (err) {
      if (errorCode(err) === "timeout" && tries < 2) continue;
      const now = await ctx.db.update<Order>(key, (o) => (o!.status === "paid" ? o! : { ...o!, status: "declined", attempt }));
      return now.status === "paid" ? "paid" : "declined";
    }
  }
}
