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
  attemptId: string;
  startedAt: number;
  chargeId?: string;
}

const LOCK_LEASE_MS = 45_000;

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const stateKey = `checkout_state:${orderId}`;

  // 1. Coordinate access and determine the idempotency key for this payment attempt.
  //    We persist the attemptId before calling PayCo so that if the process crashes or
  //    PayCo times out, the retry uses the exact same idempotency key.
  //    If a charge is declined, we transition state to "declined" so a subsequent click
  //    (after the user updates their saved card) generates a fresh attemptId.
  const { order, attemptId, alreadyPaid } = await ctx.db.transaction((tx) => {
    const ord = tx.get<Order>(orderKey);
    if (!ord) {
      throw new Error(`Order not found: ${orderId}`);
    }

    if (ord.status === "paid") {
      return { order: ord, attemptId: "", alreadyPaid: true };
    }

    const state = tx.get<CheckoutState>(stateKey);
    if (state?.status === "paid") {
      ord.status = "paid";
      tx.set(orderKey, ord);
      return { order: ord, attemptId: state.attemptId, alreadyPaid: true };
    }

    const now = Date.now();

    if (state?.status === "charging") {
      if (now - state.startedAt < LOCK_LEASE_MS) {
        // Another request is actively processing this order (e.g. double-click).
        // Throw so the duplicate call fails safely while the first completes, or retries later.
        const err = new Error("Checkout already in progress for this order") as Error & { code?: string };
        err.code = "concurrent_checkout";
        throw err;
      }
      // Previous attempt timed out or its instance died mid-flight.
      // Reuse the same attemptId to safely query/retry PayCo idempotently.
      state.startedAt = now;
      tx.set(stateKey, state);
      return { order: ord, attemptId: state.attemptId, alreadyPaid: false };
    }

    // No prior state, or previous attempt resulted in "declined".
    // Start a brand-new attempt with a new idempotency key so PayCo tries the card again.
    const newAttemptId = randomUUID();
    tx.set<CheckoutState>(stateKey, {
      status: "charging",
      attemptId: newAttemptId,
      startedAt: now,
    });

    return { order: ord, attemptId: newAttemptId, alreadyPaid: false };
  });

  if (alreadyPaid) {
    return "paid";
  }

  // 2. Call PayCo with the persisted idempotency key.
  try {
    const charge = await ctx.payco.createCharge({
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      metadata: { orderId: order.id, attemptId },
      idempotencyKey: `checkout:${order.id}:${attemptId}`,
    });

    // 3a. Charge succeeded: atomically mark both order and state as "paid".
    await ctx.db.transaction((tx) => {
      const ord = tx.get<Order>(orderKey) ?? order;
      ord.status = "paid";
      tx.set(orderKey, ord);
      tx.set<CheckoutState>(stateKey, {
        status: "paid",
        attemptId,
        startedAt: Date.now(),
        chargeId: charge.id,
      });
    });

    return "paid";
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;

    if (code === "card_declined") {
      // 3b. Card was declined: atomically mark order and state as "declined"
      //     (unless a concurrent retry already succeeded).
      const finalStatus = await ctx.db.transaction((tx) => {
        const ord = tx.get<Order>(orderKey) ?? order;
        const currentState = tx.get<CheckoutState>(stateKey);

        if (ord.status === "paid" || currentState?.status === "paid") {
          ord.status = "paid";
          tx.set(orderKey, ord);
          return "paid" as const;
        }

        ord.status = "declined";
        tx.set(orderKey, ord);

        if (!currentState || currentState.attemptId === attemptId) {
          tx.set<CheckoutState>(stateKey, {
            status: "declined",
            attemptId,
            startedAt: Date.now(),
          });
        }
        return "declined" as const;
      });

      return finalStatus;
    }

    // 3c. Transient/unknown error (e.g., `timeout`).
    //     Keep `stateKey` in "charging" with the same `attemptId`, but clear `startedAt`
    //     so the user's immediate retry is not blocked by the lease and reuses `attemptId`.
    try {
      await ctx.db.transaction((tx) => {
        const currentState = tx.get<CheckoutState>(stateKey);
        if (currentState && currentState.attemptId === attemptId && currentState.status === "charging") {
          currentState.startedAt = 0;
          tx.set(stateKey, currentState);
        }
      });
    } catch {
      // Ignore cleanup errors; lease expiration will still allow retries after LOCK_LEASE_MS.
    }

    throw err;
  }
}
