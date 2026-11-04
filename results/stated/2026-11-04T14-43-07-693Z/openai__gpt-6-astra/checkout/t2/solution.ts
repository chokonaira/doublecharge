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

interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
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
  }): Promise<Charge>;
}

// Only the capabilities used by checkout are required here.
// Shipping and payouts are not part of this operation.
interface Ctx {
  db: Db;
  payco: PayCo;
}

interface Attempt {
  id: string;
  idempotencyKey: string;
  customerId: string;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
  status: "pending" | "paid" | "declined";
  chargeId?: string;
}

type Outcome = "paid" | "declined";

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export async function checkout(
  orderId: string,
  ctx: Ctx,
): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:attempt:${orderId}`;
  const candidateId = randomUUID();

  const prepared = await ctx.db.transaction<
    { kind: "paid" } | { kind: "attempt"; attempt: Attempt }
  >((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) throw new Error(`Order not found: ${orderId}`);

    if (order.status === "paid") return { kind: "paid" };

    const previous = tx.get<Attempt>(attemptKey);

    if (previous?.status === "paid") {
      tx.set<Order>(orderKey, { ...order, status: "paid" });
      return { kind: "paid" };
    }

    if (previous?.status === "pending") {
      // Concurrent requests and retries share this exact payment request.
      // Never replace an attempt whose payment outcome is uncertain.
      return { kind: "attempt", attempt: previous };
    }

    // A known decline requires a fresh key: replaying its old key would
    // replay the decline even after the customer updates their saved card.
    //
    // The API supplies no caller request ID, so a retry after a committed
    // decline cannot be distinguished from another press of Pay. Both start
    // a new attempt; the previous attempt definitively created no charge.
    const attempt: Attempt = {
      id: candidateId,
      idempotencyKey: `checkout:${candidateId}`,
      customerId: order.customerId,
      amount: order.amount,
      currency: order.currency,
      metadata: {
        orderId,
        checkoutAttemptId: candidateId,
      },
      status: "pending",
    };

    // Persist immutable payment parameters before making any external call.
    tx.set<Attempt>(attemptKey, attempt);
    tx.set<Order>(orderKey, { ...order, status: "pending" });

    return { kind: "attempt", attempt };
  });

  if (prepared.kind === "paid") return "paid";

  const attempt = prepared.attempt;
  let outcome: Outcome;
  let chargeId: string | undefined;

  try {
    const charge = await ctx.payco.createCharge({
      amount: attempt.amount,
      currency: attempt.currency,
      customerId: attempt.customerId,
      metadata: attempt.metadata,
      idempotencyKey: attempt.idempotencyKey,
    });

    outcome = "paid";
    chargeId = charge.id;
  } catch (error: unknown) {
    if (!hasCode(error, "card_declined")) {
      // In particular, a timeout may have charged the card. Leave this
      // attempt pending so retries (or reconciliation) reuse its key.
      throw error;
    }
    outcome = "declined";
  }

  // Keep this outside the PayCo catch: a database failure must never be
  // interpreted as a payment decline.
  return ctx.db.transaction<Outcome>((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) throw new Error(`Order not found: ${orderId}`);

    const current = tx.get<Attempt>(attemptKey);
    if (!current) throw new Error("Checkout attempt is missing");

    if (current.id !== attempt.id) {
      // A delayed response from a declined attempt can arrive after another
      // request has started (or completed) the next attempt. Do not overwrite it.
      if (outcome === "paid") {
        throw new Error("A successful checkout attempt was unexpectedly replaced");
      }
      return order.status === "paid" ? "paid" : "declined";
    }

    if (current.status !== "pending" && current.status !== outcome) {
      throw new Error("Conflicting results for the same checkout attempt");
    }

    tx.set<Attempt>(attemptKey, {
      ...current,
      status: outcome,
      ...(outcome === "paid" ? { chargeId } : {}),
    });

    // A delayed decline must not undo a paid order, including one settled
    // by reconciliation.
    if (order.status === "paid") return "paid";

    tx.set<Order>(orderKey, { ...order, status: outcome });
    return outcome;
  });
}
