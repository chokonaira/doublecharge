import type { Ctx, PayCoEvent } from "/Users/henryokonkwo/Desktop/doublecharge/src/world/index.ts";

interface Order {
  id: string;
  sellerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "refunded";
}

/** What this charge has contributed to the seller's balance so far. */
interface Applied {
  credited: number;
  refunded: number;
}

const done = new Set<string>(); // per-process fast path: events this instance already finished
export async function handleWebhook(event: PayCoEvent, ctx: Ctx): Promise<void> {
  if (done.has(event.id)) return;
  await handleOnce(event, ctx);
  done.add(event.id);
}
async function handleOnce(event: PayCoEvent, ctx: Ctx): Promise<void> {
  // Events can be stale, duplicated or out of order: act on PayCo's current state, not the snapshot.
  const charge = await ctx.payco.getCharge(event.data.charge.id);
  const orderId = charge.metadata.orderId;
  if (!orderId) return;
  const order = await ctx.db.get<Order>(`order:${orderId}`);
  if (!order) throw new Error(`order ${orderId} not found yet`); // PayCo will retry
  const fullyRefunded = charge.amountRefunded >= charge.amount;

  // Move the balance by exactly the difference between PayCo's state and what we already applied.
  // The claim on that difference is atomic, so duplicates and concurrent deliveries apply it once.
  let delta = 0;
  await ctx.db.update<Applied>(`applied:${charge.id}`, (applied = { credited: 0, refunded: 0 }) => {
    const next = { credited: charge.amount, refunded: Math.max(applied.refunded, charge.amountRefunded) };
    delta = next.credited - applied.credited - (next.refunded - applied.refunded);
    return next;
  });
  if (delta !== 0) await ctx.db.update<number>(`balance:${order.sellerId}`, (balance = 0) => balance + delta);

  // Status only moves forward: pending -> paid -> refunded.
  await ctx.db.update<Order>(`order:${orderId}`, (o) => ({ ...o!, status: fullyRefunded || o!.status === "refunded" ? "refunded" : "paid" }));

  if (!fullyRefunded) await ctx.shipping.ship(orderId, { idempotencyKey: `ship:${orderId}` });
}
