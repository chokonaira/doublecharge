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

interface CheckoutState {
  idempotencyKey: string;
  inFlight: boolean;
  startedAt: number;
  chargeId?: string;
}

// Callers retry after ~1 minute, and an instance can be killed at any time.
// A lock older than this is assumed to belong to a dead instance.
const LOCK_TTL_MS = 45_000;

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const stateKey = `checkout_state:${orderId}`;
  const now = Date.now();
  const candidateKey = `order:${orderId}:attempt:${randomUUID()}`;

  // Atomically check order status, reuse any unfinished attempt's idempotencyKey
  // (to prevent double-charging after a timeout or crash), or allocate a fresh key
  // (so a retry after a card decline and card update makes a new charge attempt).
  const prep = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    if (order.status === "paid") {
      return { action: "already_paid" as const };
    }

    const state = tx.get<CheckoutState>(stateKey);
    if (state?.chargeId) {
      // A previous execution recorded a succeeded charge before crashing.
      tx.set<Order>(orderKey, { ...order, status: "paid" });
      return { action: "already_paid" as const };
    }

    if (state?.inFlight && now - state.startedAt < LOCK_TTL_MS) {
      // Another live instance is currently charging this order; fail fast so we
      // don't race and overwrite a new idempotency key after a decline.
      const err = new Error("Checkout already in progress") as Error & { code: string };
      err.code = "concurrent_checkout";
      throw err;
    }

    // Reuse existing idempotencyKey if a previous attempt crashed/timed out before
    // recording a definitive outcome; otherwise use the newly generated key.
    const idempotencyKey = state?.idempotencyKey ?? candidateKey;
    tx.set<CheckoutState>(stateKey, {
      idempotencyKey,
      inFlight: true,
      startedAt: now,
    });

    return {
      action: "charge" as const,
      order,
      idempotencyKey,
    };
  });

  if (prep.action === "already_paid") {
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
      tx.set<Order>(orderKey, { ...currentOrder, status: "paid" });
      tx.set<CheckoutState>(stateKey, {
        idempotencyKey,
        inFlight: false,
        startedAt: now,
        chargeId: charge.id,
      });
    });

    return "paid";
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;

    if (code === "card_declined") {
      // PayCo guarantees no charge was created. Clear the stored idempotencyKey
      // so that once the customer updates their card and presses Pay again,
      // a fresh idempotencyKey is used instead of replaying this cached decline.
      await ctx.db.transaction((tx) => {
        const currentOrder = tx.get<Order>(orderKey) ?? order;
        if (currentOrder.status !== "paid") {
          tx.set<Order>(orderKey, { ...currentOrder, status: "declined" });
        }
        const currentState = tx.get<CheckoutState>(stateKey);
        if (currentState && currentState.idempotencyKey === idempotencyKey && !currentState.chargeId) {
          tx.delete(stateKey);
        }
      });
      return "declined";
    }

    // For timeout or any unexpected error, PayCo may or may not have processed the charge.
    // Keep `idempotencyKey` in `stateKey` so the next retry safely replays the same key,
    // but release `inFlight` so the user/caller can retry immediately.
    try {
      await ctx.db.transaction((tx) => {
        const currentState = tx.get<CheckoutState>(stateKey);
        if (currentState && currentState.idempotencyKey === idempotencyKey) {
          tx.set<CheckoutState>(stateKey, {
            ...currentState,
            inFlight: false,
          });
        }
      });
    } catch {
      // Ignore cleanup failure; the lock TTL will expire before the caller retries.
    }

    throw err;
  }
}
