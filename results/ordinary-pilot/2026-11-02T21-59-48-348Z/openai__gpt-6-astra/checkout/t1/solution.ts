import { randomUUID } from "node:crypto";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

interface Db {
  transaction<T>(fn: (tx: Tx) => T): Promise<T>;
}

interface Charge {
  id: string;
  status: "succeeded";
}

interface PayCo {
  createCharge(params: {
    amount: number;
    currency: string;
    customerId: string;
    metadata?: Record<string, string>;
    idempotencyKey?: string;
  }): Promise<Charge>;
}

interface Ctx {
  db: Db;
  payco: PayCo;
  shipping: unknown;
}

interface Attempt {
  idempotencyKey: string;
  orderId: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
  chargeId?: string;
}

type Result = "paid" | "declined";

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

export async function checkout(
  orderId: string,
  ctx: Ctx,
): Promise<Result> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:attempt:${orderId}`;
  const proposedIdempotencyKey = `checkout:${randomUUID()}`;

  const start = await ctx.db.transaction<
    { paid: true } | { paid: false; attempt: Attempt }
  >((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) throw new Error(`Order not found: ${orderId}`);
    if (order.id !== orderId) throw new Error("Order ID mismatch");

    if (order.status === "paid") return { paid: true };

    const existing = tx.get<Attempt>(attemptKey);
    if (existing?.status === "pending") {
      // Concurrent calls and retries must use exactly the same parameters/key.
      return { paid: false, attempt: existing };
    }
    if (existing?.status === "paid") {
      throw new Error("Inconsistent paid checkout state");
    }

    // A definitive decline ends an attempt. A subsequent Pay click gets a
    // fresh key, allowing PayCo to try the customer's updated saved card.
    const attempt: Attempt = {
      idempotencyKey: proposedIdempotencyKey,
      orderId,
      customerId: order.customerId,
      amount: order.amount,
      currency: order.currency,
      status: "pending",
    };
    tx.set(attemptKey, attempt);
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return { paid: false, attempt };
  });

  if (start.paid) return "paid";
  const attempt = start.attempt;

  let outcome: Result;
  let chargeId: string | undefined;

  try {
    const charge = await ctx.payco.createCharge({
      amount: attempt.amount,
      currency: attempt.currency,
      customerId: attempt.customerId,
      metadata: { orderId: attempt.orderId },
      idempotencyKey: attempt.idempotencyKey,
    });
    outcome = "paid";
    chargeId = charge.id;
  } catch (error: unknown) {
    if (errorCode(error) !== "card_declined") {
      // Timeouts and other ambiguous failures must NOT rotate the key.
      // A later call safely retries the durable attempt.
      throw error;
    }
    outcome = "declined";
  }

  // PayCo and Db cannot commit atomically. If this transaction fails (or the
  // process dies), the durable pending attempt lets retries recover PayCo's
  // original result. The separate reconciliation job handles abandoned calls.
  return ctx.db.transaction<Result>((tx) => {
    const order = tx.get<Order>(orderKey);
    const current = tx.get<Attempt>(attemptKey);

    if (!order) throw new Error(`Order not found: ${orderId}`);
    if (order.status === "paid") return "paid";

    if (!current) throw new Error("Checkout attempt disappeared");

    if (current.idempotencyKey !== attempt.idempotencyKey) {
      // Another caller already recorded this decline and a new Pay click
      // started another attempt. Never overwrite that newer attempt.
      if (outcome === "declined") return "declined";
      throw new Error("Successful checkout attempt was unexpectedly replaced");
    }

    if (current.status !== "pending" && current.status !== outcome) {
      throw new Error("Conflicting checkout outcomes");
    }

    // An order changed externally while payment was in flight must be
    // reconciled rather than silently marking different purchase terms paid.
    if (
      order.id !== attempt.orderId ||
      order.customerId !== attempt.customerId ||
      order.amount !== attempt.amount ||
      order.currency !== attempt.currency
    ) {
      throw new Error("Order changed during checkout; reconciliation required");
    }

    const completed: Attempt = { ...current, status: outcome };
    if (chargeId !== undefined) completed.chargeId = chargeId;

    tx.set(attemptKey, completed);
    tx.set<Order>(orderKey, { ...order, status: outcome });
    return outcome;
  });
}
