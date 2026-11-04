import { randomUUID } from "node:crypto";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface CheckoutAttempt {
  idempotencyKey: string;
  amount: number;
  currency: string;
  customerId: string;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout_attempt:${orderId}`;

  // Step 1: Atomically inspect the order and ensure a persistent idempotency key
  // exists for the current charge attempt.
  //
  // Why persist a separate attempt record instead of using `orderId` directly as the idempotencyKey?
  // Because PayCo caches `card_declined` errors against the idempotencyKey. If a customer's card
  // is declined, they update their saved card and click "Pay" again. A new idempotencyKey is
  // required for that subsequent attempt so PayCo actually tries the new card instead of replaying
  // the previous decline. However, if an attempt fails due to a timeout or crash, we MUST reuse
  // the same idempotencyKey on retry to prevent double-charging.
  const state = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    if (order.status === "paid") {
      return { alreadyPaid: true as const };
    }

    let attempt = tx.get<CheckoutAttempt>(attemptKey);
    if (
      !attempt ||
      attempt.amount !== order.amount ||
      attempt.currency !== order.currency ||
      attempt.customerId !== order.customerId
    ) {
      attempt = {
        idempotencyKey: `charge:${orderId}:${randomUUID()}`,
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
      };
      tx.set(attemptKey, attempt);
    }

    return {
      alreadyPaid: false as const,
      order,
      attempt,
    };
  });

  if (state.alreadyPaid) {
    return "paid";
  }

  const { attempt } = state;

  // Step 2: Execute the charge with PayCo using the persisted idempotency key.
  try {
    await ctx.payco.createCharge({
      amount: attempt.amount,
      currency: attempt.currency,
      customerId: attempt.customerId,
      metadata: { orderId },
      idempotencyKey: attempt.idempotencyKey,
    });
  } catch (err: any) {
    if (err && typeof err === "object" && err.code === "card_declined") {
      // The card was definitively declined; no money moved.
      // Clear this attempt key (unless a concurrent call already rotated it) and mark order "declined",
      // unless a concurrent request somehow already paid the order.
      await ctx.db.transaction((tx) => {
        const currentAttempt = tx.get<CheckoutAttempt>(attemptKey);
        if (currentAttempt?.idempotencyKey === attempt.idempotencyKey) {
          tx.delete(attemptKey);
        }

        const currentOrder = tx.get<Order>(orderKey);
        if (currentOrder && currentOrder.status !== "paid") {
          tx.set<Order>(orderKey, { ...currentOrder, status: "declined" });
        }
      });

      return "declined";
    }

    // For timeouts, network errors, or other unexpected errors, leave `attemptKey` intact in Db
    // so that when the caller/user retries, the exact same `idempotencyKey` is reused.
    throw err;
  }

  // Step 3: Charge succeeded. Mark the order as "paid" and clean up the attempt record.
  await ctx.db.transaction((tx) => {
    const currentOrder = tx.get<Order>(orderKey);
    if (currentOrder && currentOrder.status !== "paid") {
      tx.set<Order>(orderKey, { ...currentOrder, status: "paid" });
    }

    const currentAttempt = tx.get<CheckoutAttempt>(attemptKey);
    if (currentAttempt?.idempotencyKey === attempt.idempotencyKey) {
      tx.delete(attemptKey);
    }
  });

  return "paid";
}
