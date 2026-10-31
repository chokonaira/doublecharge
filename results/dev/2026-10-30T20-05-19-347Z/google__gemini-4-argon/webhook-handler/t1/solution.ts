interface Order {
  id: string;
  sellerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "refunded";
}

interface ChargeProcessState {
  credited: boolean;
  amountRefunded: number;
  shipped: boolean;
}

export async function handleWebhook(event: PayCoEvent, ctx: Ctx): Promise<void> {
  if (event.type !== "charge.succeeded" && event.type !== "charge.refunded") {
    return;
  }

  // Verify the event and get the latest authoritative state from PayCo.
  // This prevents spoofing and inherently solves out-of-order / concurrent event anomalies
  // by always converging our DB towards PayCo's current ground truth for this charge.
  const charge = await ctx.payco.getCharge(event.data.charge.id);
  if (charge.status !== "succeeded") {
    return;
  }

  const orderId = charge.metadata?.orderId;
  if (!orderId) {
    return;
  }

  const stateKey = `webhook:charge:${charge.id}`;
  const orderKey = `order:${orderId}`;

  const { shouldShip } = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    const state = tx.get<ChargeProcessState>(stateKey) ?? {
      credited: false,
      amountRefunded: 0,
      shipped: false,
    };

    const balanceKey = `balance:${order.sellerId}`;
    let balanceDelta = 0;

    // 1. Credit seller balance for the charge if not yet done
    if (!state.credited) {
      balanceDelta += charge.amount;
      state.credited = true;
    }

    // 2. Subtract newly refunded amount (monotonic even if events arrive out of order)
    if (charge.amountRefunded > state.amountRefunded) {
      balanceDelta -= charge.amountRefunded - state.amountRefunded;
      state.amountRefunded = charge.amountRefunded;
    }

    if (balanceDelta !== 0) {
      const currentBalance = tx.get<number>(balanceKey) ?? 0;
      tx.set(balanceKey, currentBalance + balanceDelta);
    }

    // 3. Transition order status
    const isFullyRefunded = state.amountRefunded >= charge.amount;
    const targetStatus: Order["status"] = isFullyRefunded ? "refunded" : "paid";

    if (order.status !== targetStatus && order.status !== "refunded") {
      tx.set<Order>(orderKey, { ...order, status: targetStatus });
    }

    tx.set<ChargeProcessState>(stateKey, state);

    return {
      shouldShip: !isFullyRefunded && !state.shipped,
    };
  });

  // 4. Ship order if needed and not fully refunded.
  // Note: If a full refund happens concurrently while `shipping.ship` is in flight,
  // external shipping cannot be atomically aborted with DB reads, but fetching fresh
  // charge state via `getCharge` above minimizes this window, and idempotencyKey ensures
  // at-most-once shipment creation across retries and concurrent deliveries.
  if (shouldShip) {
    await ctx.shipping.ship(orderId, { idempotencyKey: `ship:order:${orderId}` });

    await ctx.db.update<ChargeProcessState>(stateKey, (current) => {
      const state = current ?? {
        credited: true,
        amountRefunded: charge.amountRefunded,
        shipped: false,
      };
      return { ...state, shipped: true };
    });
  }
}
