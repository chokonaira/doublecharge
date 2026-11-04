import { randomUUID } from "node:crypto";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
  chargeId?: string;
}

interface CheckoutAttempt {
  idempotencyKey: string;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout_attempt:${orderId}`;

  // Atomically read the order and ensure a stable idempotency key exists for the current attempt.
  // Reusing the persisted key across crashes/timeouts prevents double charges, while clearing it
  // only upon a confirmed decline allows subsequent retries (after updating a card) to create a new charge.
  const { order, idempotencyKey } = await ctx.db.transaction((tx) => {
    const existingOrder = tx.get<Order>(orderKey);
    if (!existingOrder) {
      throw new Error(`Order not found: ${orderId}`);
    }

    if (existingOrder.status === "paid") {
      return { order: existingOrder, idempotencyKey: "" };
    }

    let attempt = tx.get<CheckoutAttempt>(attemptKey);
    if (!attempt) {
      attempt = { idempotencyKey: `checkout:${orderId}:${randomUUID()}` };
      tx.set(attemptKey, attempt);
    }

    return { order: existingOrder, idempotencyKey: attempt.idempotencyKey };
  });

  if (order.status === "paid") {
    return "paid";
  }

  try {
    const charge = await ctx.payco.createCharge({
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      metadata: { orderId: order.id },
      idempotencyKey,
    });

    await ctx.db.transaction((tx) => {
      const current = tx.get<Order>(orderKey);
      if (current && current.status !== "paid") {
        tx.set<Order>(orderKey, {
          ...current,
          status: "paid",
          chargeId: charge.id,
        });
      }
    });

    return "paid";
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;

    if (code === "card_declined") {
      await ctx.db.transaction((tx) => {
        const current = tx.get<Order>(orderKey);
        if (current && current.status === "paid") {
          return;
        }
        if (current) {
          tx.set<Order>(orderKey, {
            ...current,
            status: "declined",
          });
        }
        // Only clear the attempt if it still matches the key that was declined,
        // so the customer's next click after updating their card gets a fresh idempotency key.
        const currentAttempt = tx.get<CheckoutAttempt>(attemptKey);
        if (currentAttempt?.idempotencyKey === idempotencyKey) {
          tx.delete(attemptKey);
        }
      });

      const latest = await ctx.db.get<Order>(orderKey);
      if (latest?.status === "paid") {
        return "paid";
      }
      return "declined";
    }

    // For timeouts or unexpected errors, keep the attempt key intact so retries reuse
    // the same idempotencyKey and never double-charge the customer.
    throw err;
  }
}
