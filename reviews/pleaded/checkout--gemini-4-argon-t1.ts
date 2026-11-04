// Checkout for the Pay button, serialised per order by a lease lock, with a rotating idempotency key.
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

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface AttemptState {
  idempotencyKey: string;
  status: "in_progress" | "paid" | "declined";
  chargeId?: string;
}

// 30 s lease: far longer than any checkout takes, so a lease never expires while its request is still
// running; a crashed holder's lease expires well before its caller retries a minute later.
const LOCK_TTL_MS = 30_000;
const POLL_INTERVAL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function checkout(
  orderId: string,
  ctx: Ctx
): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout_attempt:${orderId}`;
  const lockKey = `checkout_lock:${orderId}`;

  const lockId = randomUUID();

  // Coordinate concurrent requests (a double click) with the lease.
  while (true) {
    const now = Date.now();
    const lockAcquired = await ctx.db.transaction((tx) => {
      const order = tx.get<Order>(orderKey);
      if (order?.status === "paid") {
        return "already_paid" as const;
      }

      const existingLock = tx.get<{ id: string; expiresAt: number }>(lockKey);
      if (existingLock && existingLock.expiresAt > now) {
        return false;
      }

      tx.set(lockKey, { id: lockId, expiresAt: now + LOCK_TTL_MS });
      return true;
    });

    if (lockAcquired === "already_paid") {
      return "paid";
    }
    if (lockAcquired === true) {
      break;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  try {
    // Inspect the order and the current attempt atomically, rotating the key only after a definitive decline
    // so a new card can be charged; an attempt still in progress keeps its key, so a retry cannot double-charge.
    const prep = await ctx.db.transaction((tx) => {
      const order = tx.get<Order>(orderKey);
      if (!order) {
        throw new Error(`Order not found: ${orderId}`);
      }

      let attempt = tx.get<AttemptState>(attemptKey);

      if (order.status === "paid" || attempt?.status === "paid") {
        if (order.status !== "paid") {
          tx.set<Order>(orderKey, { ...order, status: "paid" });
        }
        return { done: true as const, result: "paid" as const };
      }

      if (!attempt || attempt.status === "declined") {
        attempt = {
          idempotencyKey: `checkout:${orderId}:${randomUUID()}`,
          status: "in_progress",
        };
        tx.set<AttemptState>(attemptKey, attempt);
      }

      return {
        done: false as const,
        order,
        idempotencyKey: attempt.idempotencyKey,
      };
    });

    if (prep.done) {
      return prep.result;
    }

    const { order, idempotencyKey } = prep;

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
        tx.set<AttemptState>(attemptKey, {
          idempotencyKey,
          status: "paid",
          chargeId: charge.id,
        });
      });

      return "paid";
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;

      // Record the decline under this attempt's key. We hold the lock, so no other attempt has run since we
      // read the attempt state, and this write cannot clobber a newer attempt.
      if (code === "card_declined") {
        await ctx.db.transaction((tx) => {
          const currentOrder = tx.get<Order>(orderKey) ?? order;
          if (currentOrder.status !== "paid") {
            tx.set<Order>(orderKey, { ...currentOrder, status: "declined" });
          }
          tx.set<AttemptState>(attemptKey, {
            idempotencyKey,
            status: "declined",
          });
        });

        return "declined";
      }

      throw err;
    }
  } finally {
    try {
      await ctx.db.transaction((tx) => {
        // Release the lock only if we still own it.
        const currentLock = tx.get<{ id: string; expiresAt: number }>(lockKey);
        if (currentLock && currentLock.id === lockId) {
          tx.delete(lockKey);
        }
      });
    } catch {
    }
  }
}
