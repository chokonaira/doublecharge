import { randomUUID } from "node:crypto";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface PaymentState {
  idempotencyKey: string;
  chargeId?: string;
  inFlightUntil?: number;
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

const LOCK_TTL_MS = 30_000;

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const stateKey = `checkout_state:${orderId}`;
  const now = Date.now();

  // Atomically inspect order status and acquire/reuse an idempotency key for this payment attempt.
  // Keeping the same idempotency key across crashes/timeouts prevents double-charging, while
  // rotating it after a confirmed decline allows retrying with an updated card.
  const prep = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    if (order.status === "paid") {
      return { alreadyPaid: true as const, order, idempotencyKey: "" };
    }

    const existingState = tx.get<PaymentState>(stateKey);
    if (existingState?.inFlightUntil && existingState.inFlightUntil > now) {
      const err = new Error("Checkout already in progress for this order") as Error & { code?: string };
      err.code = "concurrent_checkout";
      throw err;
    }

    const idempotencyKey = existingState?.idempotencyKey ?? `checkout:${orderId}:${randomUUID()}`;
    tx.set<PaymentState>(stateKey, {
      idempotencyKey,
      chargeId: existingState?.chargeId,
      inFlightUntil: now + LOCK_TTL_MS,
    });

    return { alreadyPaid: false as const, order, idempotencyKey };
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
      const currentOrder = tx.get<Order>(orderKey) ?? order;
      tx.set<Order>(orderKey, {
        ...currentOrder,
        status: "paid",
      });
      tx.set<PaymentState>(stateKey, {
        idempotencyKey,
        chargeId: charge.id,
      });
    });

    return "paid";
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;

    if (code === "card_declined") {
      // Card was definitively declined. Mark the order as "declined" and delete the
      // saved idempotencyKey so that when the customer updates their card and clicks
      // Pay again, a fresh idempotencyKey is generated instead of replaying the decline.
      await ctx.db.transaction((tx) => {
        const currentOrder = tx.get<Order>(orderKey) ?? order;
        if (currentOrder.status !== "paid") {
          tx.set<Order>(orderKey, {
            ...currentOrder,
            status: "declined",
          });
          tx.delete(stateKey);
        }
      });
      return "declined";
    }

    // For timeouts or unexpected errors, keep the idempotencyKey in `stateKey` so the next retry
    // safely queries the outcome of this exact attempt without double-charging, and release the lock.
    try {
      await ctx.db.transaction((tx) => {
        const st = tx.get<PaymentState>(stateKey);
        if (st && st.idempotencyKey === idempotencyKey) {
          tx.set<PaymentState>(stateKey, {
            idempotencyKey: st.idempotencyKey,
            chargeId: st.chargeId,
          });
        }
      });
    } catch {
      // Ignore cleanup errors; lock will expire after LOCK_TTL_MS if the DB is unreachable.
    }

    throw err;
  }
}
