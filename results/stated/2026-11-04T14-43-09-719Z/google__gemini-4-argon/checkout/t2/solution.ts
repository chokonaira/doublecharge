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

interface Shipping {
  [key: string]: unknown;
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

interface Ctx {
  db: Db;
  payco: PayCo;
  shipping: Shipping;
}

interface AttemptState {
  idempotencyKey: string;
  chargeId?: string;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout_attempt:${orderId}`;

  // Atomically inspect the order and manage the active idempotency key.
  // Keeping the same idempotencyKey while an attempt is unresolved prevents
  // double-charging on retries after timeouts or crashes, while deleting it
  // upon a definite card decline allows a subsequent click (after card update)
  // to generate a fresh idempotencyKey.
  const init = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }
    if (order.status === "paid") {
      return { alreadyPaid: true as const, order, idempotencyKey: "" };
    }

    let attempt = tx.get<AttemptState>(attemptKey);
    if (!attempt) {
      attempt = { idempotencyKey: `charge:${orderId}:${randomUUID()}` };
      tx.set(attemptKey, attempt);
    }

    return {
      alreadyPaid: false as const,
      order,
      idempotencyKey: attempt.idempotencyKey,
      knownChargeId: attempt.chargeId,
    };
  });

  if (init.alreadyPaid) {
    return "paid";
  }

  const { order, idempotencyKey } = init;

  // Before charging (or re-sending the idempotent request), check if a charge
  // for this order already succeeded in PayCo (e.g. from an earlier attempt whose
  // DB write failed or timed out).
  if (init.knownChargeId) {
    await markOrderPaid(ctx.db, orderKey, attemptKey, init.knownChargeId);
    return "paid";
  }

  const existingCharges = await ctx.payco.listCharges({ customerId: order.customerId });
  const priorCharge = existingCharges.find((c) => c.metadata?.orderId === orderId && c.status === "succeeded");
  if (priorCharge) {
    await markOrderPaid(ctx.db, orderKey, attemptKey, priorCharge.id);
    return "paid";
  }

  try {
    const charge = await ctx.payco.createCharge({
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      metadata: { orderId },
      idempotencyKey,
    });

    await markOrderPaid(ctx.db, orderKey, attemptKey, charge.id);
    return "paid";
  } catch (err: any) {
    if (err && err.code === "card_declined") {
      const finalStatus = await ctx.db.transaction((tx) => {
        const currentOrder = tx.get<Order>(orderKey);
        if (!currentOrder) {
          throw new Error(`Order not found: ${orderId}`);
        }
        // Never overwrite "paid" or return "declined" if another request already marked it paid.
        if (currentOrder.status === "paid") {
          return "paid" as const;
        }

        const currentAttempt = tx.get<AttemptState>(attemptKey);
        if (currentAttempt?.chargeId) {
          tx.set<Order>(orderKey, { ...currentOrder, status: "paid" });
          return "paid" as const;
        }

        // Clear the declined attempt key only if it is still our attempt, so the
        // customer's next "Pay" click (after updating their card) gets a fresh key.
        if (currentAttempt && currentAttempt.idempotencyKey === idempotencyKey) {
          tx.delete(attemptKey);
        }

        tx.set<Order>(orderKey, { ...currentOrder, status: "declined" });
        return "declined" as const;
      });

      return finalStatus;
    }

    // For timeouts or any other unexpected errors, keep `attemptKey` in the DB
    // so retries reuse the same idempotencyKey, and surface the error.
    throw err;
  }
}

async function markOrderPaid(db: Db, orderKey: string, attemptKey: string, chargeId: string): Promise<void> {
  await db.transaction((tx) => {
    const currentOrder = tx.get<Order>(orderKey);
    if (currentOrder && currentOrder.status !== "paid") {
      tx.set<Order>(orderKey, { ...currentOrder, status: "paid" });
    }
    const currentAttempt = tx.get<AttemptState>(attemptKey);
    if (currentAttempt) {
      tx.set<AttemptState>(attemptKey, { ...currentAttempt, chargeId });
    } else {
      tx.set<AttemptState>(attemptKey, { idempotencyKey: `paid:${chargeId}`, chargeId });
    }
  });
}
