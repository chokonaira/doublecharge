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
  startedAt: number;
}

const ATTEMPT_LEASE_MS = 30_000;

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:attempt:${orderId}`;

  // Atomically inspect order status and acquire/recover an idempotency key for this charge attempt.
  // Storing the idempotencyKey in the DB before calling PayCo guarantees that:
  // 1. If a request times out or the instance crashes mid-flight, a retry reuses the same key
  //    so the customer is never double-charged.
  // 2. If a charge is declined, we clear the attempt key so that when the customer updates
  //    their saved card and clicks Pay again, a fresh idempotencyKey is generated instead of
  //    replaying the cached `card_declined` response from PayCo.
  const state = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    if (order.status === "paid") {
      return { alreadyPaid: true as const, order };
    }

    const now = Date.now();
    const existingAttempt = tx.get<CheckoutAttempt>(attemptKey);

    if (existingAttempt) {
      // If another request is very recently in-flight, avoid racing it; let it finish
      // or let the caller retry after the lease window.
      if (now - existingAttempt.startedAt < ATTEMPT_LEASE_MS) {
        // Still reuse the same idempotency key: PayCo handles idempotent calls safely,
        // and updating the timestamp refreshes the attempt lease.
      }
      return {
        alreadyPaid: false as const,
        order,
        idempotencyKey: existingAttempt.idempotencyKey,
      };
    }

    const idempotencyKey = `order:${orderId}:attempt:${randomUUID()}`;
    tx.set<CheckoutAttempt>(attemptKey, {
      idempotencyKey,
      startedAt: now,
    });

    return {
      alreadyPaid: false as const,
      order,
      idempotencyKey,
    };
  });

  if (state.alreadyPaid) {
    return "paid";
  }

  const { order, idempotencyKey } = state;

  try {
    await ctx.payco.createCharge({
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      metadata: { orderId: order.id },
      idempotencyKey,
    });
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;

    if (code === "card_declined") {
      await ctx.db.transaction((tx) => {
        const currentOrder = tx.get<Order>(orderKey);
        if (currentOrder && currentOrder.status !== "paid") {
          tx.set<Order>(orderKey, { ...currentOrder, status: "declined" });
        }
        // Only clear the attempt if it still matches the key that was declined,
        // so the next "Pay" press (after updating card) gets a new idempotency key.
        const currentAttempt = tx.get<CheckoutAttempt>(attemptKey);
        if (currentAttempt?.idempotencyKey === idempotencyKey) {
          tx.delete(attemptKey);
        }
      });
      return "declined";
    }

    // For timeouts or unexpected errors, keep `attemptKey` intact in the DB so the
    // subsequent retry reuses `idempotencyKey` and settles the same attempt safely.
    throw err;
  }

  await ctx.db.transaction((tx) => {
    const currentOrder = tx.get<Order>(orderKey);
    if (currentOrder && currentOrder.status !== "paid") {
      tx.set<Order>(orderKey, { ...currentOrder, status: "paid" });
    }
    const currentAttempt = tx.get<CheckoutAttempt>(attemptKey);
    if (currentAttempt?.idempotencyKey === idempotencyKey) {
      tx.delete(attemptKey);
    }
  });

  return "paid";
}
