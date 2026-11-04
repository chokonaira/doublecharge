interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface CheckoutState {
  attempt: number;
  inFlight: boolean;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const stateKey = `checkout:${orderId}`;

  const txResult = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }
    if (order.status === "paid") {
      return { alreadyPaid: true as const };
    }

    const state = tx.get<CheckoutState>(stateKey);
    const attempt = state?.inFlight ? state.attempt : (state?.attempt ?? 0) + 1;

    if (!state?.inFlight) {
      tx.set<CheckoutState>(stateKey, { attempt, inFlight: true });
    }

    return {
      alreadyPaid: false as const,
      order,
      attempt,
    };
  });

  if (txResult.alreadyPaid) {
    return "paid";
  }

  const { order, attempt } = txResult;
  const idempotencyKey = `${orderId}:${attempt}:${order.customerId}:${order.amount}:${order.currency}`;

  try {
    await ctx.payco.createCharge({
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      metadata: { orderId },
      idempotencyKey,
    });
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "card_declined") {
      return await ctx.db.transaction((tx) => {
        const currentOrder = tx.get<Order>(orderKey);
        if (!currentOrder) {
          throw new Error(`Order not found: ${orderId}`);
        }
        if (currentOrder.status === "paid") {
          return "paid";
        }

        const currentState = tx.get<CheckoutState>(stateKey);
        if (currentState && currentState.attempt > attempt) {
          throw new Error("Checkout attempt was superseded by a newer attempt");
        }

        tx.set<Order>(orderKey, { ...currentOrder, status: "declined" });
        tx.set<CheckoutState>(stateKey, { attempt, inFlight: false });
        return "declined";
      });
    }
    throw err;
  }

  await ctx.db.transaction((tx) => {
    const currentOrder = tx.get<Order>(orderKey);
    if (currentOrder && currentOrder.status !== "paid") {
      tx.set<Order>(orderKey, { ...currentOrder, status: "paid" });
    }
    const currentState = tx.get<CheckoutState>(stateKey);
    if (!currentState || currentState.attempt <= attempt) {
      tx.set<CheckoutState>(stateKey, { attempt, inFlight: false });
    }
  });

  return "paid";
}
