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

interface AttemptRecord {
  idempotencyKey: string;
  status: "in_flight" | "declined" | "succeeded";
  startedAt: number;
  chargeId?: string;
}

const LOCK_TTL_MS = 30_000;

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout_attempt:${orderId}`;
  const now = Date.now();
  const freshIdempotencyKey = `order:${orderId}:${randomUUID()}`;

  // Atomically inspect order & attempt state, and acquire/reuse an idempotency key.
  const txResult = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    if (order.status === "paid") {
      return { action: "already_paid" as const };
    }

    const attempt = tx.get<AttemptRecord>(attemptKey);

    if (attempt) {
      if (attempt.status === "succeeded") {
        // A previous attempt succeeded but order wasn't marked paid (or was overwritten).
        tx.set<Order>(orderKey, { ...order, status: "paid" });
        return { action: "already_paid" as const };
      }

      if (attempt.status === "in_flight") {
        // If another request is very recently in flight, avoid double-submitting concurrently.
        // If it's older (e.g. timed out or crashed, or client retried ~1 min later), reuse the
        // EXACT same idempotencyKey so PayCo returns the prior result or processes it once.
        if (now - attempt.startedAt < LOCK_TTL_MS) {
          throw Object.assign(new Error("Checkout already in progress"), { code: "concurrent_request" });
        }
        const reusedAttempt: AttemptRecord = {
          idempotencyKey: attempt.idempotencyKey,
          status: "in_flight",
          startedAt: now,
        };
        tx.set<AttemptRecord>(attemptKey, reusedAttempt);
        return { action: "charge" as const, order, idempotencyKey: reusedAttempt.idempotencyKey };
      }

      // If previous attempt was "declined", the customer may have updated their saved card
      // and pressed Pay again. Because PayCo caches `card_declined` per idempotencyKey,
      // we MUST generate a new idempotencyKey for this new attempt after a confirmed decline.
    }

    const newAttempt: AttemptRecord = {
      idempotencyKey: freshIdempotencyKey,
      status: "in_flight",
      startedAt: now,
    };
    tx.set<AttemptRecord>(attemptKey, newAttempt);
    return { action: "charge" as const, order, idempotencyKey: newAttempt.idempotencyKey };
  });

  if (txResult.action === "already_paid") {
    return "paid";
  }

  const { order, idempotencyKey } = txResult;

  try {
    const charge = await ctx.payco.createCharge({
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      metadata: { orderId },
      idempotencyKey,
    });

    await ctx.db.transaction((tx) => {
      const currentOrder = tx.get<Order>(orderKey) ?? order;
      tx.set<Order>(orderKey, { ...currentOrder, status: "paid" });
      tx.set<AttemptRecord>(attemptKey, {
        idempotencyKey,
        status: "succeeded",
        startedAt: now,
        chargeId: charge.id,
      });
    });

    return "paid";
  } catch (err: any) {
    if (err && err.code === "card_declined") {
      await ctx.db.transaction((tx) => {
        const currentOrder = tx.get<Order>(orderKey) ?? order;
        if (currentOrder.status !== "paid") {
          tx.set<Order>(orderKey, { ...currentOrder, status: "declined" });
        }
        const currentAttempt = tx.get<AttemptRecord>(attemptKey);
        if (!currentAttempt || currentAttempt.idempotencyKey === idempotencyKey) {
          tx.set<AttemptRecord>(attemptKey, {
            idempotencyKey,
            status: "declined",
            startedAt: now,
          });
        }
      });
      return "declined";
    }

    // For timeout or any other error: keep attempt record in_flight with the same idempotencyKey
    // (updating startedAt to 0 so an immediate retry is allowed and will reuse the idempotencyKey).
    await ctx.db.transaction((tx) => {
      const currentAttempt = tx.get<AttemptRecord>(attemptKey);
      if (currentAttempt && currentAttempt.idempotencyKey === idempotencyKey && currentAttempt.status === "in_flight") {
        tx.set<AttemptRecord>(attemptKey, {
          ...currentAttempt,
          startedAt: 0,
        });
      }
    }).catch(() => {
      // Ignore DB cleanup errors so we surface the original error
    });

    throw err;
  }
}
