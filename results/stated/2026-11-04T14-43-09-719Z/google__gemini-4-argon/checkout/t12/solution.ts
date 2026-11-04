interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface CheckoutState {
  attempt: number;
  status: "in_flight" | "declined" | "paid";
}

function isErrorWithCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  );
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const stateKey = `checkout:${orderId}`;

  const init = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }
    const state = tx.get<CheckoutState>(stateKey);

    if (order.status === "paid" || state?.status === "paid") {
      if (order.status !== "paid") {
        tx.set<Order>(orderKey, { ...order, status: "paid" });
      }
      if (state?.status !== "paid") {
        tx.set<CheckoutState>(stateKey, { attempt: state?.attempt ?? 1, status: "paid" });
      }
      return { done: true as const, result: "paid" as const };
    }

    let attempt: number;
    if (!state) {
      attempt = 1;
      tx.set<CheckoutState>(stateKey, { attempt, status: "in_flight" });
    } else if (state.status === "in_flight") {
      attempt = state.attempt;
    } else {
      // Previous attempt was resolved and reported as declined; start a new attempt key
      // so an updated card can be charged.
      attempt = state.attempt + 1;
      tx.set<CheckoutState>(stateKey, { attempt, status: "in_flight" });
    }

    return {
      done: false as const,
      attempt,
      order,
    };
  });

  if (init.done) {
    return init.result;
  }

  let { attempt, order } = init;

  while (true) {
    const idempotencyKey = `checkout:${orderId}:${attempt}`;
    try {
      await ctx.payco.createCharge({
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId },
        idempotencyKey,
      });

      await ctx.db.transaction((tx) => {
        const currentOrder = tx.get<Order>(orderKey) ?? order;
        if (currentOrder.status !== "paid") {
          tx.set<Order>(orderKey, { ...currentOrder, status: "paid" });
        }
        const currentState = tx.get<CheckoutState>(stateKey);
        tx.set<CheckoutState>(stateKey, {
          attempt: Math.max(currentState?.attempt ?? 0, attempt),
          status: "paid",
        });
      });

      return "paid";
    } catch (err) {
      if (!isErrorWithCode(err, "card_declined")) {
        throw err;
      }

      const next = await ctx.db.transaction((tx) => {
        const currentOrder = tx.get<Order>(orderKey) ?? order;
        const currentState = tx.get<CheckoutState>(stateKey);

        if (currentOrder.status === "paid" || currentState?.status === "paid") {
          if (currentOrder.status !== "paid") {
            tx.set<Order>(orderKey, { ...currentOrder, status: "paid" });
          }
          return { done: true as const, result: "paid" as const };
        }

        if (!currentState || currentState.attempt === attempt) {
          tx.set<Order>(orderKey, { ...currentOrder, status: "declined" });
          tx.set<CheckoutState>(stateKey, { attempt, status: "declined" });
          return { done: true as const, result: "declined" as const };
        }

        // A concurrent request already resolved our attempt and started a newer one.
        if (currentState.status === "in_flight") {
          return {
            done: false as const,
            attempt: currentState.attempt,
            order: currentOrder,
          };
        }

        if (currentOrder.status !== "declined") {
          tx.set<Order>(orderKey, { ...currentOrder, status: "declined" });
        }
        return { done: true as const, result: "declined" as const };
      });

      if (next.done) {
        return next.result;
      }

      attempt = next.attempt;
      order = next.order;
    }
  }
}
