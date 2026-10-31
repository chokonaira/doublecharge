import { randomUUID } from "node:crypto";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface Ctx {
  db: Db;
  payco: PayCo;
  shipping: Shipping;
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

interface Shipping {
  [key: string]: unknown;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  // Store the active idempotency key in the DB so concurrent or retried calls
  // share the same key, preventing double-charging on timeouts or crashes.
  const idemRecordKey = `checkout:idem:${orderId}`;

  const state = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    if (order.status === "paid") {
      return { alreadyPaid: true as const };
    }

    let idempotencyKey = tx.get<string>(idemRecordKey);
    if (!idempotencyKey) {
      idempotencyKey = `order:${orderId}:attempt:${randomUUID()}`;
      tx.set(idemRecordKey, idempotencyKey);
    }

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
      // Record charge details for audit / reconciliation jobs
      tx.set(`order_charge:${orderId}`, charge.id);
    });

    return "paid";
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;

    if (code === "card_declined") {
      await ctx.db.transaction((tx) => {
        const currentOrder = tx.get<Order>(orderKey);
        if (currentOrder && currentOrder.status !== "paid") {
          tx.set<Order>(orderKey, { ...currentOrder, status: "declined" });
        }
        // Only clear the idempotency key if it is still the one that was declined.
        // This ensures the next attempt (after the user updates their card) gets a
        // fresh idempotency key instead of replaying the cached card_declined error.
        if (tx.get<string>(idemRecordKey) === idempotencyKey) {
          tx.delete(idemRecordKey);
        }
      });

      return "declined";
    }

    // For timeouts or transient failures, we leave `idemRecordKey` intact in the DB
    // so that when the caller or user retries, the exact same idempotencyKey is reused.
    throw err;
  }
}
