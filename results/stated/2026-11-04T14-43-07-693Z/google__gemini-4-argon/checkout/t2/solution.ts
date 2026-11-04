import { randomUUID } from "node:crypto";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
  chargeId?: string;
}

interface PaymentAttempt {
  idempotencyKey: string;
}

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

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout_attempt:${orderId}`;
  const candidateIdempotencyKey = `charge:${orderId}:${randomUUID()}`;

  // Atomically read the order and ensure a persistent idempotency key exists for the current attempt.
  // Reusing the persisted idempotency key across crashes/timeouts prevents double charges, while
  // rotating it only after a confirmed `card_declined` allows the customer to retry after updating their card.
  const state = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    if (order.status === "paid") {
      return { alreadyPaid: true as const, order, idempotencyKey: "" };
    }

    let attempt = tx.get<PaymentAttempt>(attemptKey);
    if (!attempt) {
      attempt = { idempotencyKey: candidateIdempotencyKey };
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
      const current = tx.get<Order>(orderKey);
      if (!current) {
        throw new Error(`Order not found: ${orderId}`);
      }
      if (current.status !== "paid") {
        tx.set<Order>(orderKey, {
          ...current,
          status: "paid",
          chargeId: charge.id,
        });
      }
      tx.delete(attemptKey);
    });

    return "paid";
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;

    if (code === "card_declined") {
      // PayCo caches `card_declined` responses against the idempotencyKey.
      // Clear the attempt key so a subsequent "Pay" click (after updating the saved card)
      // generates a fresh idempotencyKey instead of replaying the cached decline.
      const finalStatus = await ctx.db.transaction((tx) => {
        const current = tx.get<Order>(orderKey);
        if (!current) {
          throw new Error(`Order not found: ${orderId}`);
        }
        if (current.status === "paid") {
          return "paid" as const;
        }

        tx.set<Order>(orderKey, {
          ...current,
          status: "declined",
        });

        const currentAttempt = tx.get<PaymentAttempt>(attemptKey);
        if (currentAttempt && currentAttempt.idempotencyKey === idempotencyKey) {
          tx.delete(attemptKey);
        }

        return "declined" as const;
      });

      return finalStatus;
    }

    // For timeout or unexpected errors, keep `attemptKey` intact in the Db so the next retry
    // reuses the same idempotencyKey and safely resolves without charging twice.
    throw err;
  }
}
