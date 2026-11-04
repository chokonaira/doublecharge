import { randomUUID } from "node:crypto";

interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

interface Db {
  transaction<T>(fn: (tx: Tx) => T): Promise<T>;
}

interface ChargeParams {
  amount: number;
  currency: string;
  customerId: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

interface PayCo {
  createCharge(params: ChargeParams): Promise<{
    id: string;
    status: "succeeded";
  }>;
}

interface Ctx {
  db: Db;
  payco: PayCo;
  shipping: unknown;
}

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface Attempt {
  id: string;
  status: "processing" | "paid" | "declined";
  params: ChargeParams;
  chargeId?: string;
}

type Start =
  | { kind: "already-paid" }
  | { kind: "attempt"; attempt: Attempt };

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

export async function checkout(
  orderId: string,
  ctx: Ctx,
): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:attempt:${orderId}`;
  const candidateId = randomUUID();

  // Persist the exact payment request before contacting PayCo. Concurrent
  // callers and callers recovering after a crash all reuse this request.
  const start = await ctx.db.transaction<Start>((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order || order.id !== orderId) {
      throw new Error("Order not found or invalid");
    }

    if (order.status === "paid") {
      return { kind: "already-paid" };
    }

    const previous = tx.get<Attempt>(attemptKey);
    if (previous?.status === "processing") {
      return { kind: "attempt", attempt: previous };
    }
    if (previous?.status === "paid") {
      throw new Error("Inconsistent checkout state");
    }

    // A definitive decline permits a new key, so an updated saved card can
    // be charged. Without a caller-supplied request ID, a delayed call arriving
    // after a recorded decline cannot be distinguished from a new Pay click.
    const attempt: Attempt = {
      id: candidateId,
      status: "processing",
      params: {
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: {
          orderId,
          checkoutAttemptId: candidateId,
        },
        idempotencyKey: `checkout:charge:${candidateId}`,
      },
    };

    tx.set(attemptKey, attempt);
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return { kind: "attempt", attempt };
  });

  if (start.kind === "already-paid") {
    return "paid";
  }

  const attempt = start.attempt;
  let outcome: "paid" | "declined";
  let chargeId: string | undefined;

  try {
    const charge = await ctx.payco.createCharge(attempt.params);
    outcome = "paid";
    chargeId = charge.id;
  } catch (error: unknown) {
    if (errorCode(error) !== "card_declined") {
      // In particular, a timeout never releases the attempt or rotates its
      // key: PayCo may already have charged the customer. A retry safely
      // repeats the same request, even if this process dies immediately.
      throw error;
    }
    outcome = "declined";
  }

  // Payment and Db cannot commit atomically. The persisted request plus
  // PayCo's idempotency makes the intervening crash window recoverable.
  // Reconciliation should use this same attempt record and frozen parameters.
  return ctx.db.transaction<"paid" | "declined">((tx) => {
    const order = tx.get<Order>(orderKey);
    const current = tx.get<Attempt>(attemptKey);

    if (!order || order.id !== orderId) {
      throw new Error("Order disappeared or became invalid during checkout");
    }

    if (order.status === "paid") {
      return "paid";
    }

    if (!current) {
      throw new Error("Checkout attempt disappeared");
    }

    if (current.id !== attempt.id) {
      // Another caller already committed this decline and started a new
      // attempt. This late response must not overwrite the newer attempt.
      if (outcome === "declined") {
        return "declined";
      }
      throw new Error("Successful checkout attempt was unexpectedly replaced");
    }

    if (current.status !== "processing" && current.status !== outcome) {
      throw new Error("Conflicting payment outcomes");
    }

    const completed: Attempt =
      outcome === "paid"
        ? { ...current, status: "paid", chargeId }
        : { ...current, status: "declined" };

    tx.set(attemptKey, completed);
    tx.set<Order>(orderKey, { ...order, status: outcome });
    return outcome;
  });
}
