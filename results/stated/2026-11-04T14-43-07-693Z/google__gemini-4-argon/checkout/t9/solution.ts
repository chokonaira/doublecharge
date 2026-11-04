import { randomUUID } from "node:crypto";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface CheckoutState {
  status: "charging" | "paid" | "declined";
  attemptKey: string;
  chargeId?: string;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const stateKey = `checkout_state:${orderId}`;

  // Step 1: Atomically inspect the order and acquire or join an active charge attempt.
  const txResult = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    // If order is already paid, we are completely done.
    if (order.status === "paid") {
      return { done: true as const, result: "paid" as const };
    }

    const state = tx.get<CheckoutState>(stateKey);

    if (state) {
      if (state.status === "paid") {
        // Ensure order reflects paid status if a previous attempt crashed before updating both
        tx.set<Order>(orderKey, { ...order, status: "paid" });
        return { done: true as const, result: "paid" as const };
      }

      if (state.status === "charging") {
        // An attempt is already in progress (or crashed mid-flight).
        // Reuse the same attemptKey so PayCo's idempotency protects against double charging.
        return {
          done: false as const,
          attemptKey: state.attemptKey,
          order,
        };
      }
    }

    // Either no previous attempt exists, or the previous attempt ended in "declined"
    // and the customer is pressing Pay again (potentially after updating their saved card).
    // Generate a fresh idempotency key so PayCo does not replay the old `card_declined` error.
    const attemptKey = `charge:${orderId}:${randomUUID()}`;
    tx.set<CheckoutState>(stateKey, {
      status: "charging",
      attemptKey,
    });

    return {
      done: false as const,
      attemptKey,
      order,
    };
  });

  if (txResult.done) {
    return txResult.result;
  }

  const { attemptKey, order } = txResult;

  // Step 2: Execute the charge with PayCo using the persisted attemptKey.
  try {
    const charge = await ctx.payco.createCharge({
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      metadata: { orderId: order.id },
      idempotencyKey: attemptKey,
    });

    // Step 3a: Charge succeeded. Atomically mark both order and state as "paid".
    await ctx.db.transaction((tx) => {
      const currentOrder = tx.get<Order>(orderKey) ?? order;
      tx.set<Order>(orderKey, { ...currentOrder, status: "paid" });
      tx.set<CheckoutState>(stateKey, {
        status: "paid",
        attemptKey,
        chargeId: charge.id,
      });
    });

    return "paid";
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;

    if (code === "card_declined") {
      // Step 3b: Card was definitively declined.
      // Only transition to "declined" if this attemptKey is still the active one
      // and the order hasn't been paid in the meantime.
      const finalStatus = await ctx.db.transaction((tx) => {
        const currentOrder = tx.get<Order>(orderKey) ?? order;
        if (currentOrder.status === "paid") {
          return "paid" as const;
        }

        const currentState = tx.get<CheckoutState>(stateKey);
        if (currentState?.status === "paid") {
          tx.set<Order>(orderKey, { ...currentOrder, status: "paid" });
          return "paid" as const;
        }

        if (!currentState || currentState.attemptKey === attemptKey) {
          tx.set<Order>(orderKey, { ...currentOrder, status: "declined" });
          tx.set<CheckoutState>(stateKey, {
            status: "declined",
            attemptKey,
          });
        }

        return "declined" as const;
      });

      return finalStatus;
    }

    // For timeouts or any unexpected transient errors, leave `state.status === "charging"`
    // with the same `attemptKey` in Db and rethrow. When the caller or user retries,
    // the next call will reuse `attemptKey` and safely resolve the outcome without double-charging.
    throw err;
  }
}
