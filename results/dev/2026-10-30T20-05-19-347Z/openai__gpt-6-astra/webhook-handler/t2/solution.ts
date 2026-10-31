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

interface Order {
  id: string;
  sellerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "refunded";
}

interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
}

interface Db {
  transaction<T>(fn: (tx: Tx) => T): Promise<T>;
  set<T>(key: string, value: T): Promise<void>;
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

interface ChargeLedger {
  orderId: string;
  sellerId: string;
  amount: number;
  currency: string;
  refunded: number;
}

function internalKey(kind: string, id: string): string {
  return `payco-webhook:v1:${JSON.stringify([kind, id])}`;
}

function assertMinorUnits(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${name}: expected nonnegative safe integer`);
  }
}

/**
 * Financial effects are committed atomically with a per-charge ledger.
 * No event is marked "done" before its shipping work has succeeded:
 * retries resume shipping even when accounting was already committed.
 *
 * Limitation: the APIs cannot strictly guarantee "never ship a fully
 * refunded charge". A refund can happen after getCharge (or after shipping),
 * and Shipping cannot atomically check PayCo or cancel a shipment. We read
 * PayCo on every delivery, retain the highest observed refund total, and
 * suppress shipping whenever a full refund is known. Eliminating the
 * remaining race requires coordination between PayCo and Shipping.
 *
 * Internal ledger keys must be retained for as long as events can be retried.
 */
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
  if (!snapshot.id) {
    throw new Error("Missing charge ID");
  }

  // Event snapshots can be old, including a success delivered after a refund.
  // Failures propagate so the caller retries without losing pending work.
  const charge = await ctx.payco.getCharge(snapshot.id);

  if (
    charge.id !== snapshot.id ||
    charge.status !== "succeeded" ||
    charge.amount !== snapshot.amount ||
    charge.currency !== snapshot.currency ||
    charge.metadata.orderId !== snapshot.metadata.orderId
  ) {
    throw new Error("Inconsistent charge identity or immutable charge fields");
  }

  assertMinorUnits(charge.amount, "charge amount");
  assertMinorUnits(charge.amountRefunded, "current refunded amount");
  assertMinorUnits(snapshot.amountRefunded, "event refunded amount");

  // A trusted event is also evidence of a refund, even if a concurrent read
  // returns an older snapshot. Refund totals are cumulative, not increments.
  const observedRefunded = Math.max(
    charge.amountRefunded,
    snapshot.amountRefunded,
  );

  if (observedRefunded > charge.amount) {
    throw new Error("Refund total exceeds charge amount");
  }

  const orderId = charge.metadata.orderId;
  if (typeof orderId !== "string" || orderId.length === 0) {
    throw new Error("Charge has no order ID");
  }

  const orderKey = `order:${orderId}`;
  const ledgerKey = internalKey("charge", charge.id);
  const shippedKey = internalKey("shipped", orderId);
  const shippingIdempotencyKey = internalKey("shipment", orderId);

  const shouldShip = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order || order.id !== orderId) {
      throw new Error(`Order not found or inconsistent: ${orderId}`);
    }
    if (order.currency !== charge.currency) {
      // A single numeric balance cannot safely mix currencies.
      throw new Error(`Charge currency differs from order currency: ${orderId}`);
    }

    const previous = tx.get<ChargeLedger>(ledgerKey);
    if (
      previous &&
      (previous.orderId !== orderId ||
        previous.sellerId !== order.sellerId ||
        previous.amount !== charge.amount ||
        previous.currency !== charge.currency)
    ) {
      throw new Error(`Charge accounting identity changed: ${charge.id}`);
    }

    const refunded = Math.max(previous?.refunded ?? 0, observedRefunded);
    const previouslyCredited = previous
      ? previous.amount - previous.refunded
      : 0;
    const nowCredited = charge.amount - refunded;
    const delta = nowCredited - previouslyCredited;

    const balanceKey = `balance:${order.sellerId}`;
    const balance = tx.get<number>(balanceKey) ?? 0;
    const nextBalance = balance + delta;

    // Negative balances are valid: a refund may arrive after a seller payout.
    if (
      !Number.isSafeInteger(balance) ||
      !Number.isSafeInteger(nextBalance)
    ) {
      throw new Error(`Invalid or overflowing seller balance: ${order.sellerId}`);
    }

    if (delta !== 0) {
      tx.set(balanceKey, nextBalance);
    }

    tx.set<ChargeLedger>(ledgerKey, {
      orderId,
      sellerId: order.sellerId,
      amount: charge.amount,
      currency: charge.currency,
      refunded,
    });

    // A delayed success must never undo a previously recorded full refund.
    const status: Order["status"] =
      refunded === charge.amount || order.status === "refunded"
        ? "refunded"
        : "paid";

    if (order.status !== status) {
      tx.set<Order>(orderKey, { ...order, status });
    }

    return status === "paid" && tx.get<boolean>(shippedKey) !== true;
  });

  if (!shouldShip) {
    return;
  }

  // Concurrent deliveries and crashes after shipment creation are safe:
  // every attempt for this order uses the same durable, deterministic key.
  // In particular, a timeout must be retried with this SAME key.
  await ctx.shipping.ship(orderId, {
    idempotencyKey: shippingIdempotencyKey,
  });

  // If this write fails or the process dies first, the retry calls Shipping
  // with the same key rather than creating another shipment.
  await ctx.db.set(shippedKey, true);
}
