import { randomUUID } from "node:crypto";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
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

interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
}

interface Db {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  insertIfAbsent<T>(key: string, value: T): Promise<boolean>;
  update<T>(key: string, fn: (current: T | undefined) => T): Promise<T>;
  transaction<T>(fn: (tx: Tx) => T): Promise<T>;
  delete(key: string): Promise<void>;
}

interface Shipping {
  [key: string]: unknown;
}

interface Ctx {
  db: Db;
  payco: PayCo;
  shipping: Shipping;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  // Separate key to persist the active idempotency key across crashes/timeouts
  // without polluting the order record schema.
  const idempKeyKey = `checkout:idempotency:${orderId}`;
  const newAttemptKey = randomUUID();

  // Atomically read the order and establish or retrieve the current attempt's idempotency key.
  // If a previous attempt timed out or crashed mid-flight, its idempotencyKey is still in Db,
  // so we reuse it to prevent double-charging.
  // If a previous attempt was declined, it deleted the idempotencyKey, so a fresh key is used
  // (allowing the customer to retry after updating their saved card, since PayCo caches declined keys).
  const state = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }
    if (order.status === "paid") {
      return { alreadyPaid: true as const, order };
    }

    let idempotencyKey = tx.get<string>(idempKeyKey);
    if (!idempotencyKey) {
      idempotencyKey = newAttemptKey;
      tx.set(idempKeyKey, idempotencyKey);
    }

    return { alreadyPaid: false as const, order, idempotencyKey };
  });

  if (state.alreadyPaid) {
    return "paid";
  }

  const { order, idempotencyKey } = state;

  try {
    await ctx.payco.createCharge({
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      metadata: { orderId: order.id },
      idempotencyKey,
    });
  } catch (err: any) {
    if (err && err.code === "card_declined") {
      await ctx.db.transaction((tx) => {
        const currentOrder = tx.get<Order>(orderKey);
        if (!currentOrder || currentOrder.status === "paid") {
          return;
        }
        // Only rotate/clear the idempotency key if it still matches the declined attempt
        if (tx.get<string>(idempKeyKey) === idempotencyKey) {
          tx.delete(idempKeyKey);
        }
        tx.set<Order>(orderKey, { ...currentOrder, status: "declined" });
      });

      // Check in case a concurrent attempt already paid the order
      const latestOrder = await ctx.db.get<Order>(orderKey);
      if (latestOrder?.status === "paid") {
        return "paid";
      }
      return "declined";
    }

    // For timeout or any other error: keep idempKeyKey in Db so the next retry
    // reuses the exact same idempotencyKey with PayCo.
    throw err;
  }

  await ctx.db.transaction((tx) => {
    const currentOrder = tx.get<Order>(orderKey);
    if (currentOrder && currentOrder.status !== "paid") {
      tx.set<Order>(orderKey, { ...currentOrder, status: "paid" });
    }
  });

  return "paid";
}
