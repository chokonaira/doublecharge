// PayCo webhook handler.
//
// Design:
// - All bookkeeping for an order lives in one Db record, `orderpay:<orderId>`.
//   It holds, for every charge seen, the charge amount already credited to the
//   seller and the refund total already debited, plus a `shipped` flag.
//   Each event is applied in a single Db transaction that updates this record,
//   the order and the seller balance together. Applying an event is
//   idempotent: we credit a charge at most once and only debit the increase
//   of the refund total. Duplicate, concurrent or out-of-order deliveries
//   therefore converge to: balance = sum(amount - amountRefunded) and
//   status = "refunded" iff every charge of the order is fully refunded.
// - Any event for a charge proves the charge succeeded. A refund that arrives
//   before `charge.succeeded` also credits the charge first.
// - We read the latest charge from PayCo (getCharge) and use the larger refund
//   total. State then catches up even before the remaining refund events arrive.
// - Shipping is attempted after the transaction commits, keyed by
//   `ship:<orderId>` so retries never create a second shipment. The `shipped`
//   flag is set only after `ship` succeeds. If the instance dies in between,
//   PayCo retries the event and we call `ship` again with the same key,
//   which is safe.
//
// Limitation: a full refund can happen at PayCo after our getCharge check and
// before ship() runs. That race cannot be closed with the APIs provided.
// We minimise the window by checking the freshest charge state right before
// shipping.

interface OrderRec {
  id: string;
  sellerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "refunded";
}

interface ChargeState {
  amount: number; // amount credited to the seller for this charge
  refunded: number; // refund total already debited from the seller
}

interface OrderPayState {
  charges: Record<string, ChargeState>;
  shipped: boolean;
}

function err(code: string, msg: string): Error {
  return Object.assign(new Error(msg), { code });
}

export async function handleWebhook(event: PayCoEvent, ctx: Ctx): Promise<void> {
  if (event.type !== "charge.succeeded" && event.type !== "charge.refunded") return;
  const evCharge = event.data?.charge;
  if (!evCharge) return;
  const orderId = evCharge.metadata?.orderId;
  if (!orderId) return; // Not a marketplace order charge; nothing to do.

  // Get the freshest view of the charge. If this fails we throw and PayCo retries.
  const fresh = await ctx.payco.getCharge(evCharge.id);
  const amount = fresh.amount;
  const refundedTotal = Math.min(
    amount,
    Math.max(fresh.amountRefunded ?? 0, evCharge.amountRefunded ?? 0),
  );

  const orderKey = `order:${orderId}`;
  const payKey = `orderpay:${orderId}`;

  const result = await ctx.db.transaction((tx: Tx) => {
    const order = tx.get<OrderRec>(orderKey);
    // Throwing makes PayCo retry later, in case the order is not written yet.
    if (!order) throw err("order_not_found", `order ${orderId} not found`);

    const prev = tx.get<OrderPayState>(payKey) ?? { charges: {}, shipped: false };
    const charges: Record<string, ChargeState> = { ...prev.charges };
    const existing = charges[evCharge.id];
    let delta = 0;
    let c: ChargeState;
    if (!existing) {
      c = { amount, refunded: 0 };
      delta += amount;
    } else {
      c = { ...existing };
    }
    if (refundedTotal > c.refunded) {
      delta -= refundedTotal - c.refunded;
      c.refunded = refundedTotal;
    }
    charges[evCharge.id] = c;

    const state: OrderPayState = { charges, shipped: prev.shipped };
    tx.set(payKey, state);

    if (delta !== 0) {
      const balKey = `balance:${order.sellerId}`;
      const bal = tx.get<number>(balKey) ?? 0;
      tx.set(balKey, bal + delta);
    }

    const all = Object.values(charges);
    const fullyRefunded = all.length > 0 && all.every((x) => x.refunded >= x.amount);
    const status: OrderRec["status"] = fullyRefunded ? "refunded" : "paid";
    if (order.status !== status) tx.set(orderKey, { ...order, status });

    return { shouldShip: !state.shipped && status === "paid" };
  });

  if (!result.shouldShip) return;

  // Last check right before shipping: has this charge been fully refunded
  // meanwhile? A refund on another charge of the same order is caught by the
  // aggregate check in the transaction.
  const latest = await ctx.payco.getCharge(evCharge.id);
  if (latest.amountRefunded >= latest.amount) {
    // The refund event will arrive and update the state. Re-run the bookkeeping
    // now so the state converges sooner. No shipment is made.
    if (latest.amountRefunded > refundedTotal) {
      await handleWebhook(
        { ...event, data: { charge: latest } } as PayCoEvent,
        ctx,
      );
    }
    return;
  }

  // Idempotent per order: retries and concurrent deliveries never ship twice.
  // A timeout throws, and PayCo retries the event with the same key.
  await ctx.shipping.ship(orderId, { idempotencyKey: `ship:${orderId}` });

  await ctx.db.update<OrderPayState>(payKey, (cur) => ({
    charges: cur?.charges ?? {},
    shipped: true,
  }));
}
