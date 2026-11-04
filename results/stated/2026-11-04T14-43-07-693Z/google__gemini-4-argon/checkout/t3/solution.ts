import { randomUUID } from "node:crypto";

declare global {
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
    createPayout(p: {
      amount: number;
      currency: string;
      destination: string;
      idempotencyKey?: string;
    }): Promise<Payout>;
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

  interface Payout {
    id: string;
    amount: number;
    currency: string;
    destination: string;
    created: number;
  }
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
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:${orderId}`;

  const prep = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }
    if (order.status === "paid") {
      return { alreadyPaid: true as const };
    }

    let attempt = tx.get<CheckoutAttempt>(attemptKey);
    if (!attempt?.idempotencyKey) {
      attempt = { idempotencyKey: `${orderId}:${randomUUID()}` };
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

  try {
    await ctx.payco.createCharge({
      amount: prep.order.amount,
      currency: prep.order.currency,
      customerId: prep.order.customerId,
      metadata: { orderId },
      idempotencyKey: prep.idempotencyKey,
    });
  } catch (err: unknown) {
    const code = (err as { code?: unknown })?.code;
    if (code === "card_declined") {
      const finalStatus = await ctx.db.transaction((tx) => {
        const order = tx.get<Order>(orderKey);
        if (order?.status === "paid") {
          return "paid" as const;
        }

        const attempt = tx.get<CheckoutAttempt>(attemptKey);
        if (attempt?.idempotencyKey === prep.idempotencyKey) {
          // Clear the attempt key so a subsequent attempt (after the customer updates
          // their card) gets a new idempotency key instead of replaying this decline.
          tx.delete(attemptKey);
          if (order) {
            tx.set<Order>(orderKey, { ...order, status: "declined" });
          }
        }
        return "declined" as const;
      });
      return finalStatus;
    }

    // For timeouts or other transient failures, leave the attempt key in place
    // so retries reuse the same idempotencyKey and never double-charge.
    throw err;
  }

  await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (order && order.status !== "paid") {
      tx.set<Order>(orderKey, { ...order, status: "paid" });
    }
  });

  return "paid";
}
