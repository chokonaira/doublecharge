import { randomUUID } from "node:crypto";

export interface Ctx {
  db: Db;
  payco: PayCo;
  shipping: Shipping;
}

export interface Db {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  insertIfAbsent<T>(key: string, value: T): Promise<boolean>;
  update<T>(key: string, fn: (current: T | undefined) => T): Promise<T>;
  transaction<T>(fn: (tx: Tx) => T): Promise<T>;
  delete(key: string): Promise<void>;
}

export interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
}

export interface PayCo {
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

export interface Charge {
  id: string;
  amount: number;
  currency: string;
  customerId: string;
  metadata: Record<string, string>;
  status: "succeeded";
  amountRefunded: number;
  created: number;
}

export interface Payout {
  id: string;
  amount: number;
  currency: string;
  destination: string;
  created: number;
}

export type Shipping = unknown;

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

export async function checkout(
  orderId: string,
  ctx: Ctx
): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout_attempt:${orderId}`;

  // Atomically read the order and ensure a persistent idempotency key exists
  // for the current payment attempt before contacting PayCo.
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
      const currentOrder = tx.get<Order>(orderKey);
      if (!currentOrder) {
        throw new Error(`Order not found: ${orderId}`);
      }
      if (currentOrder.status !== "paid") {
        tx.set<Order>(orderKey, { ...currentOrder, status: "paid" });
      }
      tx.set<CheckoutAttempt>(attemptKey, {
        idempotencyKey,
        chargeId: charge.id,
      });
    });

    return "paid";
  } catch (err: unknown) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;

    if (code === "card_declined") {
      // PayCo permanently caches `card_declined` against this idempotencyKey.
      // Clear the attempt key so that when the customer updates their card and
      // presses Pay again, a fresh idempotencyKey will be used.
      const finalStatus = await ctx.db.transaction((tx) => {
        const currentOrder = tx.get<Order>(orderKey);
        if (!currentOrder) {
          throw new Error(`Order not found: ${orderId}`);
        }
        if (currentOrder.status === "paid") {
          return "paid" as const;
        }

        tx.set<Order>(orderKey, { ...currentOrder, status: "declined" });

        const currentAttempt = tx.get<CheckoutAttempt>(attemptKey);
        if (
          currentAttempt &&
          currentAttempt.idempotencyKey === idempotencyKey
        ) {
          tx.delete(attemptKey);
        }

        return "declined" as const;
      });

      return finalStatus;
    }

    // For timeouts or any other error, keep `attemptKey` in the Db so the next
    // retry reuses the same idempotencyKey and never double-charges.
    throw err;
  }
}
