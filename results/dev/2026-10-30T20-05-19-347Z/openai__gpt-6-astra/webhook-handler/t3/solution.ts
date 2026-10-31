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
  delete(key: string): void;
}

interface Db {
  transaction<T>(fn: (tx: Tx) => T): Promise<T>;
}

interface PayCo {
  getCharge(id: string): Promise<Charge>;
}

interface Shipping {
  ship(orderId: string, opts?: { idempotencyKey?: string }): Promise<void>;
}

interface Ctx {
  db: Db;
  payco: PayCo;
  shipping: Shipping;
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
  customerId: string;
  refunded: number;
}

interface ShipmentState {
  completed: true;
}

interface Reconciliation {
  orderId: string;
  shouldShip: boolean;
}

function internalKey(kind: string, id: string): string {
  return `payco-webhook:v1:${kind}:${JSON.stringify(id)}`;
}

function requireSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer`);
  }
}

function validateCharge(charge: Charge): void {
  requireSafeInteger(charge.amount, "Charge amount");
  requireSafeInteger(charge.amountRefunded, "Refunded amount");

  if (
    !charge.id ||
    !charge.metadata?.orderId ||
    charge.status !== "succeeded" ||
    charge.amount < 0 ||
    charge.amountRefunded < 0 ||
    charge.amountRefunded > charge.amount
  ) {
    throw new Error("Invalid charge");
  }
}

function assertSameCharge(a: Charge, b: Charge): void {
  if (
    a.id !== b.id ||
    a.amount !== b.amount ||
    a.currency !== b.currency ||
    a.customerId !== b.customerId ||
    a.metadata.orderId !== b.metadata.orderId
  ) {
    throw new Error("Charge identity or immutable fields changed");
  }
}

/**
 * A refund event also proves that the original charge succeeded. Accounting
 * therefore does not depend on receiving charge.succeeded first.
 *
 * The ledger and balance move atomically to the greatest cumulative refund
 * observed, rather than treating each refund event as an independent debit.
 */
async function reconcile(
  charge: Charge,
  observedRefund: number,
  ctx: Ctx,
): Promise<Reconciliation> {
  const orderId = charge.metadata.orderId;
  const ledgerKey = internalKey("charge", charge.id);
  const shipmentKey = internalKey("shipment", orderId);

  return ctx.db.transaction((tx) => {
    const orderKey = `order:${orderId}`;
    const order = tx.get<Order>(orderKey);
    if (!order || order.id !== orderId) {
      throw new Error(`Order not found: ${orderId}`);
    }

    if (order.currency !== charge.currency) {
      // The supplied balance model has no currency dimension or FX mechanism.
      // Reject inconsistent data rather than silently mix currencies.
      throw new Error(`Charge currency does not match order: ${orderId}`);
    }

    const previous = tx.get<ChargeLedger>(ledgerKey);
    if (
      previous &&
      (previous.orderId !== orderId ||
        previous.sellerId !== order.sellerId ||
        previous.amount !== charge.amount ||
        previous.currency !== charge.currency ||
        previous.customerId !== charge.customerId)
    ) {
      throw new Error(`Charge accounting identity changed: ${charge.id}`);
    }

    const refunded = Math.max(
      observedRefund,
      charge.amountRefunded,
      previous?.refunded ?? 0,
    );

    const previousContribution = previous
      ? previous.amount - previous.refunded
      : 0;
    const contribution = charge.amount - refunded;
    const delta = contribution - previousContribution;

    const balanceKey = `balance:${order.sellerId}`;
    const balance = tx.get<number>(balanceKey) ?? 0;
    requireSafeInteger(balance, "Seller balance");
    const nextBalance = balance + delta;
    requireSafeInteger(nextBalance, "Updated seller balance");

    if (delta !== 0) {
      tx.set(balanceKey, nextBalance);
    }

    tx.set<ChargeLedger>(ledgerKey, {
      orderId,
      sellerId: order.sellerId,
      amount: charge.amount,
      currency: charge.currency,
      customerId: charge.customerId,
      refunded,
    });

    const fullyRefunded = refunded === charge.amount;
    // A stale success must never undo an already-observed full refund.
    const status: Order["status"] =
      fullyRefunded || order.status === "refunded" ? "refunded" : "paid";

    if (order.status !== status) {
      tx.set<Order>(orderKey, { ...order, status });
    }

    return {
      orderId,
      shouldShip:
        status === "paid" &&
        !tx.get<ShipmentState>(shipmentKey)?.completed,
    };
  });
}

export async function handleWebhook(
  event: PayCoEvent,
  ctx: Ctx,
): Promise<void> {
  if (
    event.type !== "charge.succeeded" &&
    event.type !== "charge.refunded"
  ) {
    throw new Error("Unsupported PayCo event type");
  }

  const snapshot = event.data.charge;
  validateCharge(snapshot);

  // Event payloads can be stale, including a success delivered after a refund.
  const current = await ctx.payco.getCharge(snapshot.id);
  validateCharge(current);
  assertSameCharge(snapshot, current);

  const observedRefund = Math.max(
    snapshot.amountRefunded,
    current.amountRefunded,
  );

  const initial = await reconcile(current, observedRefund, ctx);
  if (!initial.shouldShip) return;

  // Refresh immediately before shipping, and reconcile again so concurrent
  // handlers' recorded refunds also prevent shipment.
  const latest = await ctx.payco.getCharge(snapshot.id);
  validateCharge(latest);
  assertSameCharge(snapshot, latest);

  const ready = await reconcile(latest, observedRefund, ctx);
  if (!ready.shouldShip) return;

  /*
   * API limitation: PayCo refunds, Db transactions, and Shipping.ship cannot be
   * made atomic. A full refund can occur after our last check but before Shipping
   * creates the shipment. Nor can these APIs cancel a shipment already created.
   * Thus "never ship an already fully refunded charge" cannot be guaranteed
   * absolutely. We suppress every shipment for which a full refund is observed,
   * refresh immediately beforehand, and let subsequent events fix accounting.
   */
  await ctx.shipping.ship(ready.orderId, {
    idempotencyKey: internalKey("ship-order", ready.orderId),
  });

  // Mark completion only after success. If this write fails, or the process dies
  // after shipping, retrying uses the same durable, order-scoped Shipping key.
  // No in-progress lock can strand work when an instance dies.
  await ctx.db.transaction((tx) => {
    tx.set<ShipmentState>(
      internalKey("shipment", ready.orderId),
      { completed: true },
    );
  });

  // Errors intentionally propagate. In particular, an ambiguous shipping
  // timeout must be retried with the same key, not treated as completion.
}
