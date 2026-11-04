// Checkout for the Pay button: one persisted attempt per order, a fresh key only after a definitive decline.
import { randomUUID } from "node:crypto";

interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

interface Db {
  transaction<T>(fn: (tx: Tx) => T): Promise<T>;
}

interface PayCo {
  createCharge(p: {
    amount: number;
    currency: string;
    customerId: string;
    metadata?: Record<string, string>;
    idempotencyKey?: string;
  }): Promise<{ id: string; status: "succeeded" }>;
}

interface Ctx {
  db: Db;
  payco: PayCo;
}

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface Attempt {
  idempotencyKey: string;
  orderId: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function assertSameOrder(order: Order, attempt: Attempt): void {
  if (
    order.id !== attempt.orderId ||
    order.customerId !== attempt.customerId ||
    order.amount !== attempt.amount ||
    order.currency !== attempt.currency
  ) {
    throw new Error("Order payment details changed during checkout");
  }
}

export async function checkout(
  orderId: string,
  ctx: Ctx,
): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:attempt:${orderId}`;

  // Generated outside the transaction so its callback has no side effects.
  const candidateKey = `checkout:${randomUUID()}`;

  const attempt = await ctx.db.transaction<Attempt | null>((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order || order.id !== orderId) {
      throw new Error("Order not found or invalid");
    }

    if (order.status === "paid") return null;

    const previous = tx.get<Attempt>(attemptKey);

    if (previous?.status === "pending") {
      assertSameOrder(order, previous);
      return previous;
    }

    if (previous?.status === "paid") {
      throw new Error("Inconsistent checkout state");
    }

    if (
      !Number.isSafeInteger(order.amount) ||
      order.amount < 0 ||
      typeof order.currency !== "string" ||
      order.currency.length === 0 ||
      typeof order.customerId !== "string" ||
      order.customerId.length === 0 ||
      (order.status !== "pending" && order.status !== "declined")
    ) {
      throw new Error("Invalid order");
    }

    const next: Attempt = {
      idempotencyKey: candidateKey,
      orderId: order.id,
      customerId: order.customerId,
      amount: order.amount,
      currency: order.currency,
      status: "pending",
    };

    // Persist the exact request before contacting PayCo. Concurrent callers and retries after a crash reuse this attempt.
    tx.set(attemptKey, next);
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return next;
  });

  if (attempt === null) return "paid";

  let outcome: "paid" | "declined";

  try {
    await ctx.payco.createCharge({
      amount: attempt.amount,
      currency: attempt.currency,
      customerId: attempt.customerId,
      metadata: { orderId: attempt.orderId },
      idempotencyKey: attempt.idempotencyKey,
    });
    outcome = "paid";
  } catch (error: unknown) {
    if (errorCode(error) !== "card_declined") {
      // An ambiguous failure must never cause a fresh payment key. Leave the attempt pending, so any instance can retry it.
      throw error;
    }
    outcome = "declined";
  }

  await ctx.db.transaction<void>((tx) => {
    const order = tx.get<Order>(orderKey);
    const current = tx.get<Attempt>(attemptKey);

    if (!order || !current) {
      throw new Error("Checkout state is missing");
    }

    // A later checkout has replaced this attempt: it recorded our decline and started a new one, possibly
    // with a new card. Our outcome is still the truth about this attempt, so report it; the order's status
    // now belongs to the newer attempt and is left alone. (A replaced attempt can only be a declined one:
    // a successful charge is never replaced, so nothing here can tell a paying customer "declined".)
    if (current.idempotencyKey !== attempt.idempotencyKey) {
      if (outcome === "declined") return;
      throw new Error("Unexpected replacement of a successful payment attempt");
    }

    assertSameOrder(order, attempt);

    if (current.status !== "pending" && current.status !== outcome) {
      throw new Error("Conflicting payment outcomes");
    }

    // Every path that could tell a paying customer "declined" ends here.
    if (order.status === "paid" && outcome !== "paid") {
      throw new Error("Cannot decline an already paid order");
    }

    tx.set<Attempt>(attemptKey, { ...current, status: outcome });
    tx.set<Order>(orderKey, { ...order, status: outcome });
  });

  // A call arriving after a persisted decline starts a fresh attempt, so a changed saved card can be charged.
  return outcome;
}
