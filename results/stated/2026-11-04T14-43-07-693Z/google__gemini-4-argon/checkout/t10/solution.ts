import { randomUUID } from "node:crypto";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface AttemptState {
  idempotencyKey: string;
  chargeId?: string;
}

export async function checkout(
  orderId: string,
  ctx: Ctx
): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:attempt:${orderId}`;

  // Atomically inspect order state and ensure an active idempotency key exists
  // for this payment attempt. If the order is already paid, we return immediately.
  // Keeping the same idempotencyKey across crashes/timeouts prevents double-charging,
  // while clearing/rotating it ONLY upon a confirmed `card_declined` allows the
  // customer to update their card and press Pay again for a fresh attempt.
  const prep = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    if (order.status === "paid") {
      return { alreadyPaid: true as const, order, idempotencyKey: "" };
    }

    let attempt = tx.get<AttemptState>(attemptKey);
    if (!attempt) {
      attempt = { idempotencyKey: `charge:${orderId}:${randomUUID()}` };
      tx.set(attemptKey, attempt);
    }

    return {
      alreadyPaid: false as const,
      order,
      idempotencyKey: attempt.idempotencyKey,
    };
  });

  if (prep.alreadyPaid) {
    return "paid";
  }

  const { order, idempotencyKey } = prep;

  try {
    const charge = await ctx.payco.createCharge({
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      metadata: { orderId: order.id },
      idempotencyKey,
    });

    await ctx.db.transaction((tx) => {
      const currentOrder = tx.get<Order>(orderKey);
      if (currentOrder && currentOrder.status !== "paid") {
        tx.set<Order>(orderKey, { ...currentOrder, status: "paid" });
      }
      tx.set<AttemptState>(attemptKey, {
        idempotencyKey,
        chargeId: charge.id,
      });
    });

    return "paid";
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;

    if (code === "card_declined") {
      // PayCo caches `card_declined` against the idempotencyKey.
      // Mark the order as "declined" and delete the attempt key (only if it still
      // matches this attempt and the order hasn't been paid concurrently) so that
      // when the customer updates their card and retries, a new key is generated.
      const finalStatus = await ctx.db.transaction((tx) => {
        const currentOrder = tx.get<Order>(orderKey);
        if (currentOrder?.status === "paid") {
          return "paid" as const;
        }
        if (currentOrder) {
          tx.set<Order>(orderKey, { ...currentOrder, status: "declined" });
        }
        const currentAttempt = tx.get<AttemptState>(attemptKey);
        if (currentAttempt?.idempotencyKey === idempotencyKey) {
          tx.delete(attemptKey);
        }
        return "declined" as const;
      });

      return finalStatus;
    }

    // For timeouts or any other transient failure, leave `attemptKey` intact in the Db
    // so the caller's or customer's retry reuses the exact same `idempotencyKey`.
    throw err;
  }
}
