interface Order {
  id: string;
  sellerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "refunded";
}

interface ChargeState {
  credited: boolean;
  amountRefunded: number;
  shipped: boolean;
}

export async function handleWebhook(event: PayCoEvent, ctx: Ctx): Promise<void> {
  if (event.type !== "charge.succeeded" && event.type !== "charge.refunded") {
    return;
  }

  const eventCharge = event.data?.charge;
  if (!eventCharge?.id) {
    return;
  }

  // Fetch the latest authoritative state from PayCo.
  // This protects against out-of-order webhooks (e.g., charge.refunded arriving before
  // charge.succeeded, or multiple partial refunds arriving out of order) and forged events.
  const charge = await ctx.payco.getCharge(eventCharge.id);
  if (charge.status !== "succeeded") {
    return;
  }

  const orderId = charge.metadata?.orderId;
  if (!orderId) {
    return;
  }

  const stateKey = `webhook_charge_state:${charge.id}`;
  const orderKey = `order:${orderId}`;

  const shouldShip = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      return false;
    }

    const state: ChargeState = tx.get<ChargeState>(stateKey) ?? {
      credited: false,
      amountRefunded: 0,
      shipped: false,
    };

    const balanceKey = `balance:${order.sellerId}`;
    let balanceDelta = 0;
    let stateChanged = false;

    // 1. Ensure the seller has been credited for the succeeded charge
    if (!state.credited) {
      balanceDelta += charge.amount;
      state.credited = true;
      stateChanged = true;
    }

    // 2. Ensure any new refund delta is subtracted from the seller's balance.
    // Using Math.max(state.amountRefunded, ...) guarantees monotonic progress
    // even if a slightly stale charge snapshot were ever observed.
    const latestRefunded = Math.max(state.amountRefunded, charge.amountRefunded);
    if (latestRefunded > state.amountRefunded) {
      balanceDelta -= latestRefunded - state.amountRefunded;
      state.amountRefunded = latestRefunded;
      stateChanged = true;
    }

    if (balanceDelta !== 0) {
      const currentBalance = tx.get<number>(balanceKey) ?? 0;
      tx.set(balanceKey, currentBalance + balanceDelta);
    }

    // 3. Reconcile order status
    const isFullyRefunded = state.amountRefunded >= charge.amount;
    const targetStatus: Order["status"] = isFullyRefunded ? "refunded" : "paid";

    if (order.status !== targetStatus) {
      tx.set(orderKey, { ...order, status: targetStatus });
    }

    if (stateChanged) {
      tx.set(stateKey, state);
    }

    // Ship only if the charge succeeded, has not been fully refunded, and hasn't shipped yet
    return !isFullyRefunded && !state.shipped;
  });

  if (shouldShip) {
    // Re-check PayCo right before calling shipping to minimize the window where a full
    // refund happens concurrently with a charge.succeeded webhook.
    // Note: Because Shipping and PayCo are separate external services without distributed
    // transactions, a refund occurring at PayCo after this check while `shipping.ship` is
    // in flight cannot be prevented.
    const freshCharge = await ctx.payco.getCharge(charge.id);
    if (freshCharge.amountRefunded >= freshCharge.amount) {
      // A full refund occurred concurrently; reconcile DB and abort shipping.
      await ctx.db.transaction((tx) => {
        const order = tx.get<Order>(orderKey);
        const state = tx.get<ChargeState>(stateKey);
        if (!order || !state) return;

        const latestRefunded = Math.max(state.amountRefunded, freshCharge.amountRefunded);
        if (latestRefunded > state.amountRefunded) {
          const diff = latestRefunded - state.amountRefunded;
          const balanceKey = `balance:${order.sellerId}`;
          const currentBalance = tx.get<number>(balanceKey) ?? 0;
          tx.set(balanceKey, currentBalance - diff);
          state.amountRefunded = latestRefunded;
          tx.set(stateKey, state);
        }

        if (order.status !== "refunded") {
          tx.set(orderKey, { ...order, status: "refunded" });
        }
      });
      return;
    }

    await ctx.shipping.ship(orderId, { idempotencyKey: `ship:${orderId}` });

    await ctx.db.update<ChargeState | undefined>(stateKey, (current) => {
      if (!current) {
        return {
          credited: true,
          amountRefunded: freshCharge.amountRefunded,
          shipped: true,
        };
      }
      return { ...current, shipped: true };
    });
  }
}
