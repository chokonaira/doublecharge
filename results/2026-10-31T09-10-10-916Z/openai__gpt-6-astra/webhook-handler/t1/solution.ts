type WebhookOrder = {
  id: string;
  sellerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "refunded";
};

type ChargeAccounting = {
  orderId: string;
  sellerId: string;
  amount: number;
  currency: string;
  amountRefunded: number;
};

type ShippingDecision = {
  orderId: string;
  shouldShip: boolean;
};

function shipmentKey(orderId: string): string {
  return `payco-webhook:v1:shipment:${orderId}`;
}

function assertMoney(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer`);
  }
}

/**
 * Atomically applies the charge's net contribution to the seller's balance.
 * Deduplication is by charge and cumulative refund total, not by event ID.
 */
async function reconcileCharge(
  charge: Charge,
  ctx: Ctx,
): Promise<ShippingDecision> {
  const orderId = charge.metadata.orderId;
  if (typeof orderId !== "string" || orderId.length === 0) {
    throw new Error(`Charge ${charge.id} has no orderId`);
  }

  assertMoney(charge.amount, "Charge amount");
  assertMoney(charge.amountRefunded, "Refunded amount");
  if (
    charge.amount < 0 ||
    charge.amountRefunded < 0 ||
    charge.amountRefunded > charge.amount
  ) {
    throw new Error(`Invalid amounts for charge ${charge.id}`);
  }

  const accountingKey = `payco-webhook:v1:charge:${charge.id}`;

  return ctx.db.transaction((tx) => {
    const orderKey = `order:${orderId}`;
    const order = tx.get<WebhookOrder>(orderKey);
    if (!order || order.id !== orderId) {
      // Do not acknowledge an event whose accounting cannot be applied.
      throw new Error(`Missing or invalid order ${orderId}`);
    }

    const previous = tx.get<ChargeAccounting>(accountingKey);
    if (
      previous &&
      (previous.orderId !== orderId ||
        previous.sellerId !== order.sellerId ||
        previous.amount !== charge.amount ||
        previous.currency !== charge.currency)
    ) {
      throw new Error(`Accounting identity changed for charge ${charge.id}`);
    }

    // Refund totals only increase. A stale event or concurrent stale read
    // must never restore refunded money.
    const amountRefunded = Math.max(
      previous?.amountRefunded ?? 0,
      charge.amountRefunded,
    );
    const previousContribution = previous
      ? previous.amount - previous.amountRefunded
      : 0;
    const contribution = charge.amount - amountRefunded;
    const delta = contribution - previousContribution;

    if (delta !== 0) {
      const balanceKey = `balance:${order.sellerId}`;
      const balance = tx.get<number>(balanceKey) ?? 0;
      assertMoney(balance, "Seller balance");
      const nextBalance = balance + delta;
      assertMoney(nextBalance, "Updated seller balance");
      // Negative balances are valid when previously credited funds are refunded.
      tx.set(balanceKey, nextBalance);
    }

    const fullyRefunded = amountRefunded === charge.amount;
    const status: WebhookOrder["status"] =
      fullyRefunded || order.status === "refunded" ? "refunded" : "paid";

    if (order.status !== status) {
      tx.set<WebhookOrder>(orderKey, { ...order, status });
    }

    tx.set<ChargeAccounting>(accountingKey, {
      orderId,
      sellerId: order.sellerId,
      amount: charge.amount,
      currency: charge.currency,
      amountRefunded,
    });

    return {
      orderId,
      shouldShip:
        status === "paid" &&
        !fullyRefunded &&
        tx.get<boolean>(shipmentKey(orderId)) !== true,
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
    throw new Error(`Unsupported webhook type: ${event.type}`);
  }

  // A refund can arrive before success. Accounting its net contribution
  // immediately handles that case without waiting for the success event.
  const initial = await reconcileCharge(event.data.charge, ctx);
  if (!initial.shouldShip) {
    return;
  }

  // The webhook snapshot may predate a full refund whose event has not arrived.
  // Fail closed if this authoritative read fails.
  const currentCharge = await ctx.payco.getCharge(event.data.charge.id);
  if (
    currentCharge.id !== event.data.charge.id ||
    currentCharge.metadata.orderId !== initial.orderId
  ) {
    throw new Error("PayCo returned an inconsistent charge");
  }

  // Also checks for refunds recorded by concurrent handlers since our first
  // transaction. Accounting and fulfillment eligibility use the same DB view.
  const current = await reconcileCharge(currentCharge, ctx);
  if (!current.shouldShip) {
    return;
  }

  /*
   * API limitation: PayCo can fully refund the charge after the read/check
   * above but before Shipping creates the shipment. No DB lock can prevent
   * that external race, and Shipping offers neither conditional shipping nor
   * cancellation. Strictly guaranteeing "never ship an already fully refunded
   * charge" requires additional coordination in those APIs. This implementation
   * refuses shipping whenever a full refund is observed and checks PayCo before
   * every attempt.
   *
   * Do not persist an exclusive "in progress" claim: a killed instance could
   * strand it. Concurrent calls and retries instead share a durable, stable
   * Shipping idempotency key.
   */
  await ctx.shipping.ship(current.orderId, {
    idempotencyKey: shipmentKey(current.orderId),
  });

  // Written only after Shipping acknowledges success. If shipping times out,
  // or the process dies before this write, the event retry safely repeats the
  // same idempotent call. Accounting already committed is not applied twice.
  await ctx.db.set<boolean>(shipmentKey(current.orderId), true);
}
