import { randomUUID } from "node:crypto";

interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
}

interface Ctx {
  db: {
    transaction<T>(fn: (tx: Tx) => T): Promise<T>;
  };
  payco: {
    createCharge(params: {
      amount: number;
      currency: string;
      customerId: string;
      metadata?: Record<string, string>;
      idempotencyKey?: string;
    }): Promise<{ id: string; status: "succeeded" }>;
  };
  shipping: unknown;
}

type Result = "paid" | "declined";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | Result;
}

interface Attempt {
  idempotencyKey: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | Result;
  chargeId?: string;
}

type Preparation =
  | { kind: "paid" }
  | { kind: "attempt"; attempt: Attempt };

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function requireOrder(tx: Tx, key: string, orderId: string): Order {
  const order = tx.get<Order>(key);
  if (!order) throw new Error(`Order not found: ${orderId}`);
  if (order.id !== orderId) throw new Error("Order ID mismatch");
  return order;
}

function matchesOrder(attempt: Attempt, order: Order): boolean {
  return (
    attempt.customerId === order.customerId &&
    attempt.amount === order.amount &&
    attempt.currency === order.currency
  );
}

export async function checkout(
  orderId: string,
  ctx: Ctx,
): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:attempt:${orderId}`;

  // Generated outside the transaction so a transaction callback replay uses
  // the same candidate. Only the candidate actually committed may be used.
  const candidateKey = `checkout:${randomUUID()}`;

  const preparation = await ctx.db.transaction<Preparation>((tx) => {
    const order = requireOrder(tx, orderKey, orderId);
    if (order.status === "paid") return { kind: "paid" };

    const existing = tx.get<Attempt>(attemptKey);

    if (existing?.status === "pending") {
      // Uncertain outcomes must keep their original parameters and key,
      // regardless of how long ago the request started.
      if (!matchesOrder(existing, order)) {
        throw new Error("Order changed while its payment was unresolved");
      }
      return { kind: "attempt", attempt: existing };
    }

    if (existing?.status === "paid") {
      // This cannot occur when these records are written only by checkout.
      throw new Error("Inconsistent paid order state");
    }

    if (
      !Number.isSafeInteger(order.amount) ||
      typeof order.customerId !== "string" ||
      typeof order.currency !== "string" ||
      (order.status !== "pending" && order.status !== "declined")
    ) {
      throw new Error("Invalid order");
    }

    // A definitive decline permits a new attempt with a fresh key; otherwise
    // PayCo would replay the old decline even after the saved card changes.
    //
    // The API provides no client invocation ID, so a request arriving after a
    // committed decline cannot be distinguished from an intentional new click.
    // Both start a new attempt. Successful payments are never restarted.
    const attempt: Attempt = {
      idempotencyKey: candidateKey,
      customerId: order.customerId,
      amount: order.amount,
      currency: order.currency,
      status: "pending",
    };

    tx.set(attemptKey, attempt);
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return { kind: "attempt", attempt };
  });

  if (preparation.kind === "paid") return "paid";

  const attempt = preparation.attempt;
  let result: Result;
  let chargeId: string | undefined;

  try {
    const charge = await ctx.payco.createCharge({
      amount: attempt.amount,
      currency: attempt.currency,
      customerId: attempt.customerId,
      idempotencyKey: attempt.idempotencyKey,
    });
    result = "paid";
    chargeId = charge.id;
  } catch (error: unknown) {
    if (errorCode(error) !== "card_declined") {
      // In particular, a timeout does not authorize another payment attempt.
      // Leave the durable attempt pending so any instance can retry its key.
      throw error;
    }
    result = "declined";
  }

  return ctx.db.transaction<Result>((tx) => {
    const order = requireOrder(tx, orderKey, orderId);
    const current = tx.get<Attempt>(attemptKey);

    if (order.status === "paid") return "paid";

    if (!current) throw new Error("Payment attempt is missing");

    if (current.idempotencyKey !== attempt.idempotencyKey) {
      // Another caller committed this attempt's decline and a later caller
      // started a new attempt. Never overwrite that newer attempt.
      if (result === "declined") return "declined";
      throw new Error("Successful payment attempt was unexpectedly replaced");
    }

    if (!matchesOrder(attempt, order)) {
      // No API can atomically freeze external order edits together with a
      // PayCo charge. Order amounts/customer/currency must remain immutable
      // while payment is unresolved; refuse to mark a changed order paid.
      throw new Error("Order changed while its payment was unresolved");
    }

    if (current.status !== "pending" && current.status !== result) {
      throw new Error("Conflicting payment outcomes");
    }

    tx.set<Attempt>(attemptKey, {
      ...current,
      status: result,
      ...(chargeId !== undefined ? { chargeId } : {}),
    });
    tx.set<Order>(orderKey, { ...order, status: result });

    return result;
  });
}
