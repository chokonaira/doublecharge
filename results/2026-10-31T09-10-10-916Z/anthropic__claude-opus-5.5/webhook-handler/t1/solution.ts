// PayCo webhook handler.
//
// Design:
// - Per-charge state lives in `chargestate:<chargeId>`. It records whether the charge
//   amount has been credited to the seller, the highest cumulative refund already
//   debited, and whether the order has shipped. This state is changed in the same
//   Db transaction as the order and balance, so a duplicate, concurrent or reordered
//   event can never apply money twice.
// - Refunds are cumulative (amountRefunded), so we only ever debit the difference
//   between the newest total we know of and the total already applied. That makes
//   order irrelevant: older or duplicate refund events produce a difference of zero.
// - The latest charge is also fetched from PayCo, so the handler works on the freshest
//   amountRefunded. This also means we never act on a charge PayCo doesn't know about.
// - Shipping happens after the transaction, with a stable idempotency key per order.
//   If the instance dies between the transaction and ship(), the retried event finds
//   `shipped: false` and calls ship() again with the same key, so nothing is lost and
//   nothing is shipped twice.

interface ChargeState {
  credited: boolean;
  refunded: number;
  shipped: boolean;
}

interface Order {
  id: string;
  sellerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "refunded";
}

const stateKey = (chargeId: string) => `chargestate:${chargeId}`;
const orderKey = (orderId: string) => `order:${orderId}`;
const balanceKey = (sellerId: string) => `balance:${sellerId}`;

export async function handleWebhook(event: PayCoEvent, ctx: Ctx): Promise<void> {
  if (event.type !== "charge.succeeded" && event.type !== "charge.refunded") return;

  const evCharge = event.data?.charge;
  if (!evCharge?.id) return;

  // Source of truth: the charge as PayCo has it now. If this fails we throw,
  // and PayCo retries the event later.
  const charge: Charge = await ctx.payco.getCharge(evCharge.id);
  const orderId = charge.metadata?.orderId ?? evCharge.metadata?.orderId;
  if (!orderId) return; // not a marketplace order charge; nothing to do

  const amount = charge.amount;
  const latestRefunded = Math.min(
    amount,
    Math.max(charge.amountRefunded ?? 0, evCharge.amountRefunded ?? 0),
  );

  // Every charge returned by PayCo has status "succeeded" (refunds don't change it).
  // So any event for the charge, including a refund that arrives first, proves the
  // charge succeeded. We therefore credit the amount on whichever event comes first.
  const result = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey(orderId));
    if (!order) return { missing: true as const };

    const st: ChargeState =
      tx.get<ChargeState>(stateKey(charge.id)) ?? { credited: false, refunded: 0, shipped: false };

    const balKey = balanceKey(order.sellerId);
    let balance = tx.get<number>(balKey) ?? 0;
    let changed = false;

    if (!st.credited) {
      balance += amount;
      st.credited = true;
      changed = true;
    }

    if (latestRefunded > st.refunded) {
      balance -= latestRefunded - st.refunded;
      st.refunded = latestRefunded;
      changed = true;
    }

    const fullyRefunded = st.refunded >= amount;
    let newStatus = order.status;
    if (fullyRefunded) newStatus = "refunded";
    else if (order.status === "pending") newStatus = "paid";

    if (newStatus !== order.status) tx.set<Order>(orderKey(orderId), { ...order, status: newStatus });
    if (changed) {
      tx.set<number>(balKey, balance);
      tx.set<ChargeState>(stateKey(charge.id), st);
    }

    return {
      missing: false as const,
      shouldShip: !fullyRefunded && !st.shipped && newStatus === "paid",
    };
  });

  if (result.missing) {
    // The order record isn't there (yet). Throw so PayCo retries rather than
    // silently losing the payment.
    const err = new Error(`order ${orderId} not found`) as Error & { code: string };
    err.code = "order_not_found";
    throw err;
  }

  if (!result.shouldShip) return;

  // Re-check right before shipping, to shrink the window in which a full refund
  // could land between our transaction and the shipment.
  // LIMITATION: Shipping has no cancel API and the Db offers no lock spanning external
  // calls. A full refund processed in the tiny window between this check and ship()
  // can't be prevented. Every refund that is already visible here is honoured.
  const fresh = await ctx.payco.getCharge(charge.id);
  if (fresh.amountRefunded >= fresh.amount) return;
  const st = await ctx.db.get<ChargeState>(stateKey(charge.id));
  if (st && (st.shipped || st.refunded >= amount)) return;
  const order = await ctx.db.get<Order>(orderKey(orderId));
  if (!order || order.status !== "paid") return;

  // A stable key per order means retries (and concurrent duplicate deliveries)
  // never create a second shipment. A timeout throws, and PayCo retries the event.
  await ctx.shipping.ship(orderId, { idempotencyKey: `ship:${orderId}` });

  await ctx.db.update<ChargeState>(stateKey(charge.id), (cur) => ({
    credited: cur?.credited ?? true,
    refunded: cur?.refunded ?? 0,
    shipped: true,
  }));
}
