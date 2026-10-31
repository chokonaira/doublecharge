import { errorCode, type Ctx } from "../../../src/world/index.ts";
interface Order { id: string; customerId: string; amount: number; currency: string; status: string; attempt?: number }
// a callback-style "defer" helper, as in a hand-rolled retry/backoff utility
const later = <T>(fn: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => setTimeout(() => { fn().then(resolve, reject); }, 0));
export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const order = (await later(() => ctx.db.get<Order>(`order:${orderId}`)))!;
  if (order.status === "paid") return "paid";
  if (!(await later(() => ctx.db.insertIfAbsent(`lock:${orderId}`, true)))) throw new Error("payment already in progress");
  try {
    const attempt = order.status === "declined" ? (order.attempt ?? 0) + 1 : (order.attempt ?? 0);
    await later(() => ctx.payco.createCharge({ amount: order.amount, currency: order.currency, customerId: order.customerId, idempotencyKey: `${orderId}:${attempt}` }));
    await later(() => ctx.db.update<Order>(`order:${orderId}`, (o) => ({ ...o!, status: "paid", attempt })));
    return "paid";
  } catch (err) {
    if (errorCode(err) === "card_declined") {
      await later(() => ctx.db.update<Order>(`order:${orderId}`, (o) => ({ ...o!, status: "declined", attempt: o!.status === "declined" ? (o!.attempt ?? 0) + 1 : (o!.attempt ?? 0) })));
      return "declined";
    }
    throw err;
  } finally {
    await later(() => ctx.db.delete(`lock:${orderId}`));
  }
}
