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
  chargeId?: string;
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
  const candidateIdempotencyKey = `order:${orderId}:attempt:${randomUUID()}`;

  // Atomically read the order and ensure a persistent idempotency key exists for the active attempt.
  // Reusing the persisted key across crashes/timeouts prevents double charges, while clearing it
  // only after a definitive "card_declined" allows a fresh attempt after the user updates their card.
  const { order, idempotencyKey } = await ctx.db.transaction((tx) => {
    const currentOrder = tx.get<Order>(orderKey);
    if (!currentOrder) {
      throw new Error(`Order not found: ${orderId}`);
    }

    if (currentOrder.status === "paid") {
      return { order: currentOrder, idempotencyKey: "" };
    }

    let attempt = tx.get<CheckoutAttempt>(attemptKey);
    if (!attempt) {
      attempt = { idempotencyKey: candidateIdempotencyKey };
      tx.set(attemptKey, attempt);
    }

    return { order: currentOrder, idempotencyKey: attempt.idempotencyKey };
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
      const currentOrder = tx.get<Order>(orderKey);
      if (!currentOrder) {
        throw new Error(`Order not found: ${orderId}`);
      }
      tx.set<Order>(orderKey, {
        ...currentOrder,
        status: "paid",
      });
      tx.set<CheckoutAttempt>(attemptKey, {
        idempotencyKey,
        chargeId: charge.id,
      });
    });

    return "paid";
  } catch (err: unknown) {
    const code = (err as { code?: unknown })?.code;

    if (code === "card_declined") {
      return await ctx.db.transaction((tx) => {
        const currentOrder = tx.get<Order>(orderKey);
        if (!currentOrder) {
          throw new Error(`Order not found: ${orderId}`);
        }

        if (currentOrder.status === "paid") {
          return "paid" as const;
        }

        tx.set<Order>(orderKey, {
          ...currentOrder,
          status: "declined",
        });

        // Clear the attempt key so the next click (after the customer updates their card)
        // generates a new idempotency key instead of replaying the cached decline.
        const currentAttempt = tx.get<CheckoutAttempt>(attemptKey);
        if (currentAttempt && currentAttempt.idempotencyKey === idempotencyKey) {
          tx.delete(attemptKey);
        }

        return "declined" as const;
      });
    }

    // For timeouts or unexpected errors, leave `attemptKey` intact in the Db so
    // subsequent retries reuse the same idempotencyKey and never double-charge.
    throw err;
  }
}
