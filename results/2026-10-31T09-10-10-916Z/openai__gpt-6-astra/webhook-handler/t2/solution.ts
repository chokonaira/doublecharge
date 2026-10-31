interface WebhookOrder {
  id: string;
  sellerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "refunded";
}

interface WebhookOrderState {
  chargeId: string;
  sellerId: string;
  amount: number;
  currency: string;
  amountRefunded: number;
  shipped: boolean;
}

export async function handleWebhook(
  event: PayCoEvent,
  ctx: Ctx,
): Promise<void> {
  const chargeId = event.data.charge.id;
  const orderId = event.data.charge.metadata.orderId;

  if (!chargeId || !orderId) {
    throw new Error("Webhook charge must identify a charge and an order");
  }

  const orderKey = `order:${orderId}`;
  const stateKey = `payco:webhook:order:${orderId}`;
  const shippingKey = JSON.stringify(["payco", "ship-order", orderId]);

  function validateCharge(charge: PayCoEvent["data"]["charge"]): void {
    if (
      charge.id !== chargeId ||
      charge.metadata.orderId !== orderId ||
      charge.status !== "succeeded" ||
      !Number.isSafeInteger(charge.amount) ||
      charge.amount < 0 ||
      !Number.isSafeInteger(charge.amountRefunded) ||
      charge.amountRefunded < 0 ||
      charge.amountRefunded > charge.amount
    ) {
      throw new Error("Invalid or inconsistent charge");
    }
  }

  validateCharge(event.data.charge);

  /**
   * A refund snapshot also proves that the original charge succeeded.
   * Account for its entire net value, even if its success event has not arrived.
   *
   * The refund high-water mark makes stale reads, duplicate events and
   * out-of-order events harmless. Accounting and its durable checkpoint
   * commit together.
   */
  async function reconcile(
    charge: PayCoEvent["data"]["charge"],
  ): Promise<boolean> {
    validateCharge(charge);

    if (
      charge.amount !== event.data.charge.amount ||
      charge.currency !== event.data.charge.currency
    ) {
      throw new Error("Charge's immutable fields changed");
    }

    return ctx.db.transaction((tx) => {
      const order = tx.get<WebhookOrder>(orderKey);
      if (!order || order.id !== orderId) {
        // Throw so a temporarily missing order does not lose its webhook.
        throw new Error(`Order not found: ${orderId}`);
      }

      const previous = tx.get<WebhookOrderState>(stateKey);

      // The task describes one charge per order. Reject conflicting bindings
      // rather than silently overwrite another charge's accounting.
      if (
        previous &&
        (previous.chargeId !== chargeId ||
          previous.sellerId !== order.sellerId ||
          previous.amount !== charge.amount ||
          previous.currency !== charge.currency)
      ) {
        throw new Error("Order's charge or accounting identity changed");
      }

      const amountRefunded = Math.max(
        previous?.amountRefunded ?? 0,
        event.data.charge.amountRefunded,
        charge.amountRefunded,
      );

      const previousNet = previous
        ? previous.amount - previous.amountRefunded
        : 0;
      const currentNet = charge.amount - amountRefunded;
      const delta = currentNet - previousNet;

      if (delta !== 0) {
        const balanceKey = `balance:${order.sellerId}`;
        const balance = tx.get<number>(balanceKey) ?? 0;
        const nextBalance = balance + delta;

        if (
          !Number.isSafeInteger(balance) ||
          !Number.isSafeInteger(nextBalance)
        ) {
          throw new Error("Seller balance exceeds safe integer accounting");
        }

        tx.set(balanceKey, nextBalance);
      }

      const fullyRefunded = amountRefunded === charge.amount;
      tx.set<WebhookOrder>(orderKey, {
        ...order,
        status: fullyRefunded ? "refunded" : "paid",
      });

      const next: WebhookOrderState = {
        chargeId,
        sellerId: order.sellerId,
        amount: charge.amount,
        currency: charge.currency,
        amountRefunded,
        shipped: previous?.shipped ?? false,
      };
      tx.set(stateKey, next);

      return !fullyRefunded && !next.shipped;
    });
  }

  // Do not trust an old success event as evidence that shipping is still safe.
  if (!(await reconcile(await ctx.payco.getCharge(chargeId)))) {
    return;
  }

  // Refresh immediately before shipping, and recheck the durable refund
  // high-water mark in case another handler has observed a newer refund.
  if (!(await reconcile(await ctx.payco.getCharge(chargeId)))) {
    return;
  }

  /*
   * API limitation: "never ship a fully refunded charge" cannot be guaranteed
   * absolutely. A refund can occur after the final check but before Shipping
   * creates the shipment; a timeout can also leave shipment creation in flight.
   * No Db transaction or lease can atomically coordinate PayCo and Shipping.
   *
   * This implements the closest safe behavior: never initiate shipping when
   * a full refund is observed, and check PayCo immediately beforehand. A strict
   * guarantee requires a provider-side conditional shipping/refund protocol.
   *
   * Do not mark shipped before this call. A crash or timeout must leave retries
   * able to finish, always using the same durable, order-scoped idempotency key.
   */
  await ctx.shipping.ship(orderId, { idempotencyKey: shippingKey });

  await ctx.db.update<WebhookOrderState>(stateKey, (current) => {
    if (!current || current.chargeId !== chargeId) {
      throw new Error("Missing or inconsistent shipment accounting state");
    }

    // Preserve any refund reconciliation committed while shipping was in flight.
    return { ...current, shipped: true };
  });
}
