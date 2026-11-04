import { randomUUID } from "node:crypto";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface CheckoutState {
  idempotencyKey: string;
  chargeId?: string;
}

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

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const stateKey = `checkout:${orderId}`;
  const candidateKey = `${orderId}:${randomUUID()}`;

  // Atomically read the order and ensure a stable idempotencyKey exists for the current attempt.
  // If a previous attempt crashed or timed out before receiving a definitive result,
  // we reuse the existing idempotencyKey so PayCo never double-charges.
  const prep = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }
    if (order.status === "paid") {
      return { done: true as const, status: "paid" as const };
    }

    let state = tx.get<CheckoutState>(stateKey);
    if (!state) {
      state = { idempotencyKey: candidateKey };
      tx.set(stateKey, state);
    }

    return {
      done: false as const,
      order,
      idempotencyKey: state.idempotencyKey,
    };
  });

  if (prep.done) {
    return prep.status;
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
      const currentState = tx.get<CheckoutState>(stateKey);
      if (currentState) {
        tx.set<CheckoutState>(stateKey, { ...currentState, chargeId: charge.id });
      }
    });

    return "paid";
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;

    if (code === "card_declined") {
      const nextKey = `${orderId}:${randomUUID()}`;
      return await ctx.db.transaction((tx) => {
        const currentOrder = tx.get<Order>(orderKey);
        if (currentOrder?.status === "paid") {
          return "paid" as const;
        }
        if (currentOrder) {
          tx.set<Order>(orderKey, { ...currentOrder, status: "declined" });
        }
        // Rotate the idempotency key so that when the customer updates their card
        // and presses Pay again, PayCo runs a fresh charge attempt instead of
        // replaying the cached card_declined response.
        const currentState = tx.get<CheckoutState>(stateKey);
        if (!currentState || currentState.idempotencyKey === idempotencyKey) {
          tx.set<CheckoutState>(stateKey, { idempotencyKey: nextKey });
        }
        return "declined" as const;
      });
    }

    // For timeout or unexpected errors, leave stateKey untouched so the next retry
    // reuses the same idempotencyKey.
    throw err;
  }
}
