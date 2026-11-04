import { randomUUID } from "node:crypto";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface PaymentAttempt {
  idempotencyKey: string;
  amount: number;
  currency: string;
  customerId: string;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout_attempt:${orderId}`;

  const state = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    if (order.status === "paid") {
      return { alreadyPaid: true as const };
    }

    let attempt = tx.get<PaymentAttempt>(attemptKey);
    if (
      !attempt ||
      attempt.amount !== order.amount ||
      attempt.currency !== order.currency ||
      attempt.customerId !== order.customerId
    ) {
      attempt = {
        idempotencyKey: randomUUID(),
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
      };
      tx.set(attemptKey, attempt);
    }

    return { alreadyPaid: false as const, order, attempt };
  });

  if (state.alreadyPaid) {
    return "paid";
  }

  const { order, attempt } = state;

  try {
    await ctx.payco.createCharge({
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      metadata: { orderId: order.id },
      idempotencyKey: attempt.idempotencyKey,
    });
  } catch (err: unknown) {
    const code = (err as { code?: unknown })?.code;
    if (code === "card_declined") {
      const finalStatus = await ctx.db.transaction((tx) => {
        const currentOrder = tx.get<Order>(orderKey);
        if (!currentOrder) {
          throw new Error(`Order not found: ${orderId}`);
        }
        if (currentOrder.status === "paid") {
          return "paid" as const;
        }

        const currentAttempt = tx.get<PaymentAttempt>(attemptKey);
        if (currentAttempt?.idempotencyKey === attempt.idempotencyKey) {
          tx.delete(attemptKey);
          tx.set<Order>(orderKey, { ...currentOrder, status: "declined" });
        }
        return "declined" as const;
      });
      return finalStatus;
    }
    throw err;
  }

  await ctx.db.transaction((tx) => {
    const currentOrder = tx.get<Order>(orderKey);
    if (!currentOrder) {
      throw new Error(`Order not found: ${orderId}`);
    }
    if (currentOrder.status !== "paid") {
      tx.set<Order>(orderKey, { ...currentOrder, status: "paid" });
    }
  });

  return "paid";
}
