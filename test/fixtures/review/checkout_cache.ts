import { errorCode, type Ctx } from "../../../src/world/index.ts";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
  /** Bumped after each definitive decline, so the next attempt gets a fresh idempotency key. */
  attempt?: number;
}

const MAX_TRIES = 4;

const paid = new Set<string>(); // orders this instance has seen paid: skip the db round trip
export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  if (paid.has(orderId)) return "paid";
  const r = await inner(orderId, ctx);
  if (r === "paid") paid.add(orderId);
  return r;
}
async function inner(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const key = `order:${orderId}`;
  let order = await ctx.db.get<Order>(key);
  if (!order) throw new Error(`order ${orderId} not found`);
  if (order.status === "paid") return "paid";
  if (order.status === "declined") {
    // The customer may have updated their card: start a new attempt with a new key.
    order = await ctx.db.update<Order>(key, (o) => (o && o.status === "declined" ? { ...o, status: "pending", attempt: (o.attempt ?? 0) + 1 } : o!));
    if (order.status === "paid") return "paid";
  }

  const attempt = order.attempt ?? 0;
  for (let tries = 1; ; tries++) {
    try {
      await ctx.payco.createCharge({
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId },
        idempotencyKey: `checkout:${orderId}:${attempt}`,
      });
      await ctx.db.update<Order>(key, (o) => ({ ...o!, status: "paid" }));
      return "paid";
    } catch (err) {
      if (errorCode(err) === "card_declined") {
        await ctx.db.update<Order>(key, (o) => (o!.status === "paid" || (o!.attempt ?? 0) !== attempt ? o! : { ...o!, status: "declined" }));
        return "declined";
      }
      // A timeout may or may not have charged the card: never treat it as a decline.
      // Retrying with the same key is safe; if we give up, the next press reuses the key.
      if (errorCode(err) === "timeout" && tries < MAX_TRIES) continue;
      throw err;
    }
  }
}
