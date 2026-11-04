import { randomUUID } from "node:crypto";

// Structural subsets of the runtime interfaces used by checkout.
interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

interface Db {
  transaction<T>(fn: (tx: Tx) => T): Promise<T>;
}

interface ChargeRequest {
  amount: number;
  currency: string;
  customerId: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

interface PayCo {
  createCharge(p: ChargeRequest): Promise<{ status: "succeeded" }>;
}

interface Ctx {
  db: Db;
  payco: PayCo;
}

type Outcome = "paid" | "declined";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | Outcome;
}

interface Attempt {
  request: ChargeRequest;
  status: "pending" | Outcome;
}

type Prepared =
  | { kind: "paid" }
  | { kind: "attempt"; attempt: Attempt };

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function assertMatchingTerms(order: Order, request: ChargeRequest): void {
  if (
    order.customerId !== request.customerId ||
    order.amount !== request.amount ||
    order.currency !== request.currency
  ) {
    // An outstanding charge may already exist. Never replace its parameters
    // or issue another charge merely because someone edited the order.
    // Such edits require reconciliation; checkout cannot safely resolve them.
    throw new Error("Order payment terms changed during checkout");
  }
}

export async function checkout(
  orderId: string,
  ctx: Ctx,
): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:v1:${orderId}`;
  const candidateIdempotencyKey = `checkout:v1:${randomUUID()}`;

  const prepared = await ctx.db.transaction<Prepared>((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) throw new Error("Order not found");
    if (order.id !== orderId) throw new Error("Order ID mismatch");

    if (order.status === "paid") return { kind: "paid" };

    const previous = tx.get<Attempt>(attemptKey);

    if (previous?.status === "pending") {
      assertMatchingTerms(order, previous.request);
      return { kind: "attempt", attempt: previous };
    }

    if (previous?.status === "paid") {
      throw new Error("Inconsistent checkout state");
    }

    // Only a definitive, durably recorded decline permits a fresh attempt.
    // Its new key allows PayCo to try the customer's updated saved card.
    const attempt: Attempt = {
      status: "pending",
      request: {
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId },
        idempotencyKey: candidateIdempotencyKey,
      },
    };

    // Persist the exact request before contacting PayCo. A crash or timeout
    // thereafter must reuse this request and key, on any service instance.
    tx.set(attemptKey, attempt);
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return { kind: "attempt", attempt };
  });

  if (prepared.kind === "paid") return "paid";
  const attempt = prepared.attempt;

  async function finish(outcome: Outcome): Promise<Outcome> {
    return ctx.db.transaction<Outcome>((tx) => {
      const order = tx.get<Order>(orderKey);
      const current = tx.get<Attempt>(attemptKey);

      if (!order || !current) {
        throw new Error("Checkout state disappeared");
      }

      if (order.status === "paid") return "paid";

      if (
        current.request.idempotencyKey !== attempt.request.idempotencyKey
      ) {
        // Another caller already recorded this attempt's decline, and a
        // subsequent Pay started a new attempt. Do not overwrite that attempt.
        if (outcome === "declined") return "declined";
        throw new Error("Unexpected checkout attempt replacement");
      }

      if (current.status !== "pending" && current.status !== outcome) {
        throw new Error("Conflicting checkout outcomes");
      }

      assertMatchingTerms(order, attempt.request);
      tx.set<Attempt>(attemptKey, { ...current, status: outcome });
      tx.set<Order>(orderKey, { ...order, status: outcome });
      return outcome;
    });
  }

  // Concurrent callers may contact PayCo for this same attempt. Its durable
  // idempotency guarantee makes that safe without process-local locks or leases.
  try {
    await ctx.payco.createCharge(attempt.request);
  } catch (error: unknown) {
    if (errorCode(error) === "card_declined") {
      return finish("declined");
    }

    // Timeout and every other non-decline error leave the attempt pending.
    // A retry must not use a fresh key: the charge may already have succeeded.
    throw error;
  }

  // If this write fails or the instance dies, retrying the saved PayCo request
  // recovers its result and performs this transaction again.
  return finish("paid");
}
