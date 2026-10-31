import { randomUUID } from "node:crypto";

interface Ctx {
  db: Db;
  payco: PayCo;
  shipping: unknown;
}

interface Db {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  insertIfAbsent<T>(key: string, value: T): Promise<boolean>;
  update<T>(key: string, fn: (current: T | undefined) => T): Promise<T>;
  transaction<T>(fn: (tx: Tx) => T): Promise<T>;
  delete(key: string): Promise<void>;
}

interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
}

interface PayCo {
  createCharge(p: {
    amount: number;
    currency: string;
    customerId: string;
    metadata?: Record<string, string>;
    idempotencyKey?: string;
  }): Promise<Charge>;
  getCharge(id: string): Promise<Charge>;
  listCharges(filter?: { customerId?: string }): Promise<Charge[]>;
}

interface Charge {
  id: string;
  amount: number;
  currency: string;
  customerId: string;
  metadata: Record<string, string>;
  status: "succeeded";
  amountRefunded: number;
  created: number;
}

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface CheckoutAttempt {
  idempotencyKey: string;
   chargeId?: string;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout_attempt:${orderId}`;

  // Atomically inspect the order and ensure a persistent idempotency key exists for the current attempt.
  // Reusing the persisted key across crashes/timeouts prevents double charges, while rotating it only
  // after a definitive card_declined allows the customer to retry after updating their card.
  const state = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }
    if (order.status === "paid") {
      return { alreadyPaid: true as const, order, idempotencyKey: "" };
    }

    let attempt = tx.get<CheckoutAttempt>(attemptKey);
    if (!attempt) {
      attempt = { idempotencyKey: `order:${orderId}:${randomUUID()}` };
      tx.set(attemptKey, attempt);
    }

    return {
      alreadyPaid: false as const,
      order,
      idempotencyKey: attempt.idempotencyKey,
    };
  });

  if (state.alreadyPaid) {
    return "paid";
  }

  const { order, idempotencyKey } = state;

  try {
    const charge = await ctx.payco.createCharge({
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      metadata: { orderId: order.id },
      idempotencyKey,
    });

    await ctx.db.transaction((tx) => {
      const currentOrder = tx.get<Order>(orderKey) ?? order;
      if (currentOrder.status !== "paid") {
        tx.set<Order>(orderKey, { ...currentOrder, status: "paid" });
      }
      tx.set<CheckoutAttempt>(attemptKey, { idempotencyKey, chargeId: charge.id });
    });

    return "paid";
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;

    if (code === "card_declined") {
      return await ctx.db.transaction((tx) => {
        const currentOrder = tx.get<Order>(orderKey) ?? order;
        if (currentOrder.status === "paid") {
          return "paid";
        }
        tx.set<Order>(orderKey, { ...currentOrder, status: "declined" });

        // Clear the attempt key so the next click on "Pay" (after updating the card)
        // uses a fresh idempotency key instead of replaying the prior card_declined response.
        const currentAttempt = tx.get<CheckoutAttempt>(attemptKey);
        if (currentAttempt && currentAttempt.idempotencyKey === idempotencyKey) {
          tx.delete(attemptKey);
        }
        return "declined";
      });
    }

    // For timeouts or unexpected errors, keep attemptKey intact in Db so retries
    // reuse the same idempotencyKey.
    throw err;
  }
}
