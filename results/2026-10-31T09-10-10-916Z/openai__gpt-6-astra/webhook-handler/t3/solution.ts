type OrderRecord = {
  id: string;
  sellerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "refunded";
};

type ChargeSnapshot = PayCoEvent["data"]["charge"];

type ChargeLedger = {
  orderId: string;
  sellerId: string;
  amount: number;
  currency: string;
  customerId: string;
  amountRefunded: number;
};

type ShipmentWork = {
  orderId: string;
  markerKey: string;
  idempotencyKey: string;
};

const PREFIX = "payco-webhook:v1:";

function chargeLedgerKey(chargeId: string): string {
  return `${PREFIX}charge:${encodeURIComponent(chargeId)}`;
}

function shipmentKey(orderId: string): string {
  return `${PREFIX}shipment:${encodeURIComponent(orderId)}`;
}

function assertInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer`);
  }
}

function validateCharge(charge: ChargeSnapshot): void {
  assertInteger(charge.amount, "Charge amount");
  assertInteger(charge.amountRefunded, "Refunded amount");

  if (
    !charge.id ||
    !charge.customerId ||
    !charge.currency ||
    charge.status !== "succeeded" ||
    typeof charge.metadata?.orderId !== "string" ||
    charge.metadata.orderId.length === 0 ||
    charge.amount < 0 ||
    charge.amountRefunded < 0 ||
    charge.amountRefunded > charge.amount
  ) {
    throw new Error("Invalid order charge");
  }
}

function assertSameCharge(
  eventCharge: ChargeSnapshot,
  currentCharge: ChargeSnapshot,
): void {
  if (
    eventCharge.id !== currentCharge.id ||
    eventCharge.amount !== currentCharge.amount ||
    eventCharge.currency !== currentCharge.currency ||
    eventCharge.customerId !== currentCharge.customerId ||
    eventCharge.metadata.orderId !== currentCharge.metadata.orderId
  ) {
    throw new Error("Charge identity or immutable payment details changed");
  }
}

/**
 * Reconciles cumulative financial state, rather than counting webhook events.
 * A refund delivered before the success event therefore works identically to
 * an in-order delivery. All accounting changes and their checkpoint are atomic.
 */
async function reconcile(
  eventCharge: ChargeSnapshot,
  ctx: Ctx,
): Promise<ShipmentWork | undefined> {
  const charge = await ctx.payco.getCharge(eventCharge.id);
  validateCharge(charge);
  assertSameCharge(eventCharge, charge);

  const orderId = charge.metadata.orderId;
  const ledgerKey = chargeLedgerKey(charge.id);
  const markerKey = shipmentKey(orderId);

  return ctx.db.transaction<ShipmentWork | undefined>((tx) => {
    const orderKey = `order:${orderId}`;
    const order = tx.get<OrderRecord>(orderKey);

    if (!order) {
      // Throw so delivery is retried if order creation has not committed yet.
      throw new Error(`Order not found: ${orderId}`);
    }
    if (
      order.id !== orderId ||
      !order.sellerId ||
      order.currency !== charge.currency
    ) {
      throw new Error(`Order/payment mismatch: ${orderId}`);
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
      throw new Error(`Recorded charge ownership or details changed: ${charge.id}`);
    }

    // Refund totals only increase. A slower request must never undo a newer
    // request's refund, even if it fetched its PayCo snapshot earlier.
    const amountRefunded = Math.max(
      eventCharge.amountRefunded,
      charge.amountRefunded,
      previous?.amountRefunded ?? 0,
    );

    const previousContribution = previous
      ? previous.amount - previous.amountRefunded
      : 0;
    const currentContribution = charge.amount - amountRefunded;
    const delta = currentContribution - previousContribution;

    if (delta !== 0) {
      const balanceKey = `balance:${order.sellerId}`;
      const balance = tx.get<number>(balanceKey) ?? 0;
      assertInteger(balance, "Seller balance");

      const nextBalance = balance + delta;
      assertInteger(nextBalance, "Updated seller balance");
      tx.set(balanceKey, nextBalance);
    }

    tx.set<ChargeLedger>(ledgerKey, {
      orderId,
      sellerId: order.sellerId,
      amount: charge.amount,
      currency: charge.currency,
      customerId: charge.customerId,
      amountRefunded,
    });

    // A completed refund is terminal; stale success deliveries cannot revive it.
    const status: OrderRecord["status"] =
      amountRefunded === charge.amount || order.status === "refunded"
        ? "refunded"
        : "paid";

    if (order.status !== status) {
      tx.set<OrderRecord>(orderKey, { ...order, status });
    }

    if (status === "refunded" || tx.get<boolean>(markerKey) === true) {
      return undefined;
    }

    return {
      orderId,
      markerKey,
      idempotencyKey: markerKey,
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

  validateCharge(event.data.charge);

  let shipment = await reconcile(event.data.charge, ctx);
  if (!shipment) return;

  // Refresh immediately before shipping, reconciling any newly observed refund.
  shipment = await reconcile(event.data.charge, ctx);
  if (!shipment) return;

  /*
   * API limitation: the absolute no-shipping-after-full-refund requirement
   * cannot be guaranteed. PayCo can finish a refund after our final check but
   * before Shipping processes ship(). Neither a Db lock nor another read closes
   * that cross-service race. Strict enforcement requires an atomic conditional
   * shipping operation coordinated with PayCo, which these APIs do not provide.
   *
   * We never ship a known fully refunded order. Concurrent attempts and crashes
   * are safe because every attempt uses the same durable, order-specific key.
   */
  await ctx.shipping.ship(shipment.orderId, {
    idempotencyKey: shipment.idempotencyKey,
  });

  // Record completion only after Shipping acknowledges it. If the process dies
  // before this write, the next delivery safely repeats the idempotent call.
  // All errors, including ambiguous timeouts, propagate to trigger a retry.
  await ctx.db.set(shipment.markerKey, true);
}
