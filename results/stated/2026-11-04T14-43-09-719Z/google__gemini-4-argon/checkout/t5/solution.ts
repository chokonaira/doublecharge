interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface CheckoutState {
  attempt: number;
  status: "in_progress" | "paid" | "declined";
  chargeId?: string;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const stateKey = `checkout:${orderId}`;

  const startInfo = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    const state = tx.get<CheckoutState>(stateKey);

    if (order.status === "paid" || state?.status === "paid") {
      if (order.status !== "paid") {
        tx.set<Order>(orderKey, { ...order, status: "paid" });
      }
      return { alreadyPaid: true as const };
    }

    let attempt: number;
    if (!state) {
      attempt = 1;
      tx.set<CheckoutState>(stateKey, { attempt, status: "in_progress" });
    } else if (state.status === "declined") {
      attempt = state.attempt + 1;
      tx.set<CheckoutState>(stateKey, { attempt, status: "in_progress" });
    } else {
      attempt = state.attempt;
    }

    return {
      alreadyPaid: false as const,
      attempt,
      order,
    };
  });

  if (startInfo.alreadyPaid) {
    return "paid";
  }

  const { attempt, order } = startInfo;
  const idempotencyKey = `checkout:${orderId}:attempt:${attempt}`;

  try {
    const charge = await ctx.payco.createCharge({
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      metadata: { orderId },
      idempotencyKey,
    });

    await ctx.db.transaction((tx) => {
      const currentOrder = tx.get<Order>(orderKey) ?? order;
      tx.set<Order>(orderKey, { ...currentOrder, status: "paid" });
      tx.set<CheckoutState>(stateKey, {
        attempt,
        status: "paid",
        chargeId: charge.id,
      });
    });

    return "paid";
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;
    if (code !== "card_declined") {
      throw err;
    }

    return await ctx.db.transaction((tx) => {
      const currentOrder = tx.get<Order>(orderKey) ?? order;
      const currentState = tx.get<CheckoutState>(stateKey);

      if (currentOrder.status === "paid" || currentState?.status === "paid") {
        if (currentOrder.status !== "paid") {
          tx.set<Order>(orderKey, { ...currentOrder, status: "paid" });
        }
        return "paid";
      }

      if (!currentState || currentState.attempt <= attempt) {
        tx.set<Order>(orderKey, { ...currentOrder, status: "declined" });
        tx.set<CheckoutState>(stateKey, {
          attempt,
          status: "declined",
        });
      } else if (currentState.status === "declined" && currentOrder.status !== "declined") {
        tx.set<Order>(orderKey, { ...currentOrder, status: "declined" });
      }

      return "declined";
    });
  }
}
