interface Charge {
  id: string;
  amount: number;
  currency: string;
  customerId: string;
  metadata: Record<string, string>;
  status: "succeeded";
  amountRefunded: number;
  created: number;
}

interface PayCoEvent {
  id: string;
  type: "charge.succeeded" | "charge.refunded";
  created: number;
  data: { charge: Charge };
}

interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

interface Db {
  transaction<T>(fn: (tx: Tx) => T): Promise<T>;
}

interface Ctx {
  db: Db;
  payco: {
    getCharge(id: string): Promise<Charge>;
  };
  shipping: {
    ship(orderId: string, opts?: { idempotencyKey?: string }): Promise<void>;
  };
}

interface Order {
  id: string;
  sellerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "refunded";
}

interface ChargeLedger {
  orderId: string;
  sellerId: string;
  amount: number;
  currency: string;
  refunded: number;
}

interface ShipmentReceipt {
  shipped: true;
}

interface ShippingDecision {
  orderId: string;
  shouldShip: boolean;
}

const chargeKey = (id: string): string => `payco-webhook:charge:${id}`;
const shipmentKey = (id: string): string => `payco-webhook:shipment:${id}`;
const shippingIdempotencyKey = (id: string): string =>
  `payco-webhook:ship:${id}`;

function validateCharge(charge: Charge): void {
  if (
    charge.status !== "succeeded" ||
    !charge.metadata?.orderId ||
    !Number.isSafeInteger(charge.amount) ||
    charge.amount < 0 ||
    !Number.isSafeInteger(charge.amountRefunded) ||
    charge.amountRefunded < 0 ||
    charge.amountRefunded > charge.amount
  ) {
    throw new Error(`Invalid charge: ${charge.id}`);
  }
}

async function loadCharge(id: string, ctx: Ctx): Promise<Charge> {
  const charge = await ctx.payco.getCharge(id);
  if (charge.id !== id) {
    throw new Error(`PayCo returned an unexpected charge for ${id}`);
  }
  validateCharge(charge);
  return charge;
}

/**
 * Atomically replaces this charge's previously accounted contribution with its
 * latest net contribution. This also handles a refund arriving before success.
 *
 * No event-ID deduplication is needed: accounting is per charge, and fulfillment
 * is separately recoverable if the process stops after committing accounting.
 */
async function reconcile(
  charge: Charge,
  ctx: Ctx,
): Promise<ShippingDecision> {
  return ctx.db.transaction((tx) => {
    const orderId = charge.metadata.orderId;
    const orderDbKey = `order:${orderId}`;
    const order = tx.get<Order>(orderDbKey);

    if (!order || order.id !== orderId) {
      throw new Error(`Order not found: ${orderId}`);
    }

    const ledgerDbKey = chargeKey(charge.id);
    const previous = tx.get<ChargeLedger>(ledgerDbKey);

    // These fields identify the contribution already applied to the balance.
    // Refuse to silently move or reinterpret it if the underlying data changes.
    if (
      previous &&
      (previous.orderId !== orderId ||
        previous.sellerId !== order.sellerId ||
        previous.amount !== charge.amount ||
        previous.currency !== charge.currency)
    ) {
      throw new Error(`Charge accounting identity changed: ${charge.id}`);
    }

    // Refund totals only increase. An older concurrent read must never undo a
    // newer refund already committed by another instance.
    const refunded = Math.max(
      previous?.refunded ?? 0,
      charge.amountRefunded,
    );

    const oldContribution = previous
      ? previous.amount - previous.refunded
      : 0;
    const newContribution = charge.amount - refunded;
    const delta = newContribution - oldContribution;

    if (delta !== 0) {
      const balanceDbKey = `balance:${order.sellerId}`;
      const balance = tx.get<number>(balanceDbKey) ?? 0;
      const nextBalance = balance + delta;

      if (
        !Number.isSafeInteger(balance) ||
        !Number.isSafeInteger(nextBalance)
      ) {
        throw new Error(`Invalid or overflowing balance: ${order.sellerId}`);
      }

      tx.set(balanceDbKey, nextBalance);
    }

    tx.set<ChargeLedger>(ledgerDbKey, {
      orderId,
      sellerId: order.sellerId,
      amount: charge.amount,
      currency: charge.currency,
      refunded,
    });

    // A zero-amount successful charge with no refund is not a refund event.
    const fullyRefunded =
      charge.amount > 0 && refunded === charge.amount;
    const status: Order["status"] = fullyRefunded ? "refunded" : "paid";

    if (order.status !== status) {
      tx.set<Order>(orderDbKey, { ...order, status });
    }

    const shipped =
      tx.get<ShipmentReceipt>(shipmentKey(orderId))?.shipped === true;

    return {
      orderId,
      shouldShip: !fullyRefunded && !shipped,
    };
  });
}

/**
 * Accounting is atomic across instances and converges despite duplicate or
 * reordered events. As implied by the order data model, each order has its own
 * charge; multiple independently charged payments for one order would require
 * an additional policy defining that order's refund status.
 *
 * API limitation: strict "never ship a fully refunded charge" cannot be
 * guaranteed. PayCo can process a refund after our final check but before
 * Shipping creates the shipment. Neither API offers an atomic conditional
 * shipment, a shared transaction, or shipment cancellation. We refresh PayCo
 * immediately before fulfillment and never ship when the last reconciled state
 * is fully refunded. A refund after shipping also cannot undo a shipment.
 */
export async function handleWebhook(
  event: PayCoEvent,
  ctx: Ctx,
): Promise<void> {
  const chargeId = event.data.charge.id;

  // Fetch current truth rather than trusting an old webhook snapshot.
  const current = await loadCharge(chargeId, ctx);
  const firstDecision = await reconcile(current, ctx);

  if (!firstDecision.shouldShip) {
    return;
  }

  // Accounting may have taken time. Refresh before fulfillment, and merge with
  // any newer refund another instance has already recorded in the database.
  const latest = await loadCharge(chargeId, ctx);
  const finalDecision = await reconcile(latest, ctx);

  if (!finalDecision.shouldShip) {
    return;
  }

  // The key is stable across events, instances, timeouts, and process restarts.
  // Do not record success before this call: a timeout is an ambiguous outcome.
  // Let errors propagate so PayCo retries the webhook.
  await ctx.shipping.ship(finalDecision.orderId, {
    idempotencyKey: shippingIdempotencyKey(finalDecision.orderId),
  });

  // If this write fails after shipping succeeded, a later retry uses the same
  // Shipping key and therefore cannot create a second shipment.
  await ctx.db.transaction((tx) => {
    tx.set<ShipmentReceipt>(shipmentKey(finalDecision.orderId), {
      shipped: true,
    });
  });
}
