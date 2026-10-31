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

interface Ctx {
  db: {
    transaction<T>(fn: (tx: Tx) => T): Promise<T>;
  };
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

/**
 * Durable accounting and shipment receipt. These records must not expire:
 * delayed event deliveries must not credit an order or ship it again.
 */
interface Receipt {
  chargeId: string;
  sellerId: string;
  amount: number;
  currency: string;
  refunded: number;
  shipped: boolean;
}

function receiptKey(orderId: string): string {
  return `payco-webhook:v1:order:${JSON.stringify(orderId)}`;
}

function shipmentKey(orderId: string): string {
  return `payco-webhook:v1:shipment:${JSON.stringify(orderId)}`;
}

function validateCharge(charge: Charge): string {
  const orderId = charge.metadata?.orderId;
  if (
    typeof charge.id !== "string" ||
    charge.id.length === 0 ||
    typeof orderId !== "string" ||
    orderId.length === 0 ||
    charge.status !== "succeeded" ||
    !Number.isSafeInteger(charge.amount) ||
    charge.amount < 0 ||
    !Number.isSafeInteger(charge.amountRefunded) ||
    charge.amountRefunded < 0 ||
    charge.amountRefunded > charge.amount
  ) {
    throw new Error("Invalid order charge");
  }
  return orderId;
}

/**
 * Atomically reconciles cumulative accounting, independently of event order.
 * Returns whether shipping still needs to be attempted.
 */
async function reconcile(
  charge: Charge,
  orderId: string,
  ctx: Ctx,
): Promise<boolean> {
  if (validateCharge(charge) !== orderId) {
    throw new Error("Charge order identity changed");
  }

  return ctx.db.transaction((tx) => {
    const orderKey = `order:${orderId}`;
    const order = tx.get<Order>(orderKey);
    if (!order || order.id !== orderId) {
      throw new Error(`Order not found: ${orderId}`);
    }

    const key = receiptKey(orderId);
    const previous = tx.get<Receipt>(key);

    // The task describes one charge per order. A second distinct charge needs
    // a business rule for fulfillment/status that these APIs do not specify;
    // reject it rather than silently overwrite the original charge's ledger.
    if (
      previous &&
      (previous.chargeId !== charge.id ||
        previous.sellerId !== order.sellerId ||
        previous.amount !== charge.amount ||
        previous.currency !== charge.currency)
    ) {
      throw new Error(`Conflicting charge or order identity: ${orderId}`);
    }

    if (charge.currency !== order.currency) {
      throw new Error(`Charge currency does not match order: ${orderId}`);
    }

    const refunded = Math.max(
      previous?.refunded ?? 0,
      charge.amountRefunded,
    );
    const previousNet = previous
      ? previous.amount - previous.refunded
      : 0;
    const nextNet = charge.amount - refunded;
    const delta = nextNet - previousNet;

    if (delta !== 0) {
      const balanceKey = `balance:${order.sellerId}`;
      const balance = tx.get<number>(balanceKey) ?? 0;
      const nextBalance = balance + delta;
      if (
        !Number.isSafeInteger(balance) ||
        !Number.isSafeInteger(nextBalance)
      ) {
        throw new Error(`Invalid or overflowing balance: ${order.sellerId}`);
      }
      tx.set(balanceKey, nextBalance);
    }

    const fullyRefunded = refunded === charge.amount;
    const status: Order["status"] = fullyRefunded ? "refunded" : "paid";

    if (order.status !== status) {
      tx.set<Order>(orderKey, { ...order, status });
    }

    const receipt: Receipt = {
      chargeId: charge.id,
      sellerId: order.sellerId,
      amount: charge.amount,
      currency: charge.currency,
      refunded,
      shipped: previous?.shipped ?? false,
    };
    tx.set(key, receipt);

    return !fullyRefunded && !receipt.shipped;
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
  const orderId = validateCharge(snapshot);

  // Credit and refunds are accounted together. Thus a refund arriving before
  // success credits only the remaining net amount, and older events cannot
  // undo refunds. No event-ID deduplication may bypass unfinished shipping.
  if (!(await reconcile(snapshot, orderId, ctx))) {
    return;
  }

  // The webhook snapshot may predate a full refund whose event has not arrived.
  // Fetch current PayCo state before attempting fulfillment.
  const current = await ctx.payco.getCharge(snapshot.id);
  if (
    current.id !== snapshot.id ||
    current.amount !== snapshot.amount ||
    current.currency !== snapshot.currency ||
    current.customerId !== snapshot.customerId
  ) {
    throw new Error("PayCo returned a conflicting charge");
  }

  // This transaction also observes refunds recorded by concurrent handlers.
  if (!(await reconcile(current, orderId, ctx))) {
    return;
  }

  /*
   * API limitation: strictly prohibiting shipping after a full refund is
   * impossible here. PayCo can refund between the last check and ship(), or
   * while this request is paused. No Db lock makes those external operations
   * atomic. This implementation avoids shipping every full refund it observes;
   * an absolute guarantee requires provider-side coordination/conditional
   * fulfillment. A shipment already created also cannot be cancelled here.
   *
   * Do not mark shipped before this call. If it times out or the process dies,
   * a retry uses the same durable, order-scoped key, preventing a second
   * shipment even when the first call actually succeeded.
   */
  await ctx.shipping.ship(orderId, {
    idempotencyKey: shipmentKey(orderId),
  });

  await ctx.db.transaction((tx) => {
    const key = receiptKey(orderId);
    const receipt = tx.get<Receipt>(key);
    if (!receipt || receipt.chargeId !== snapshot.id) {
      throw new Error(`Missing or conflicting receipt: ${orderId}`);
    }

    // Preserve any refund accounting committed while shipping was in flight.
    if (!receipt.shipped) {
      tx.set<Receipt>(key, { ...receipt, shipped: true });
    }
  });
}
