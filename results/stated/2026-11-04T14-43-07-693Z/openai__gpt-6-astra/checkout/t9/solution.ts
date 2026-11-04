import { randomUUID } from "node:crypto";

// Only the runtime capabilities needed by checkout are declared here.
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
}

interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
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
  status: "active" | "paid" | "declined";
  chargeId?: string;
}

type Result = "paid" | "declined";

function readOrder(tx: Tx, key: string, orderId: string): Order {
  const order = tx.get<Order>(key);
  if (!order) throw new Error(`Order not found: ${orderId}`);
  if (order.id !== orderId) throw new Error("Order ID mismatch");
  return order;
}

function assertSameTerms(order: Order, attempt: Attempt): void {
  // Changing an order while payment is unresolved cannot safely be handled
  // with these APIs (there is no cancellation/refund operation). Leave the
  // durable attempt intact for reconciliation rather than charge again.
  if (
    order.id !== attempt.orderId ||
    order.customerId !== attempt.customerId ||
    order.amount !== attempt.amount ||
    order.currency !== attempt.currency
  ) {
    throw new Error("Order payment details changed during checkout");
  }
}

function isCardDeclined(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "card_declined"
  );
}

export async function checkout(
  orderId: string,
  ctx: Ctx,
): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:attempt:${orderId}`;
  const candidateKey = `checkout:${randomUUID()}`;

  const prepared = await ctx.db.transaction<
    { paid: true } | { paid: false; attempt: Attempt }
  >((tx) => {
    const order = readOrder(tx, orderKey, orderId);
    if (order.status === "paid") return { paid: true };

    const existing = tx.get<Attempt>(attemptKey);
    if (existing?.status === "active") {
      assertSameTerms(order, existing);
      return { paid: false, attempt: existing };
    }

    if (existing?.status === "paid") {
      throw new Error("Inconsistent paid order state");
    }

    // A confirmed decline ends an attempt. A subsequent invocation gets a
    // fresh key, allowing PayCo to try the customer's updated saved card.
    const attempt: Attempt = {
      idempotencyKey: candidateKey,
      orderId,
      customerId: order.customerId,
      amount: order.amount,
      currency: order.currency,
      status: "active",
    };

    tx.set(attemptKey, attempt);
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return { paid: false, attempt };
  });

  if (prepared.paid) return "paid";

  const attempt = prepared.attempt;
  let outcome: Result;
  let chargeId: string | undefined;

  try {
    // Persisting the key and all parameters BEFORE this call makes concurrent
    // calls and retries after crashes safe, even if the response is lost.
    const charge = await ctx.payco.createCharge({
      amount: attempt.amount,
      currency: attempt.currency,
      customerId: attempt.customerId,
      metadata: { orderId: attempt.orderId },
      idempotencyKey: attempt.idempotencyKey,
    });
    chargeId = charge.id;
    outcome = "paid";
  } catch (error: unknown) {
    if (!isCardDeclined(error)) {
      // A timeout is not a decline. Keep this attempt active so a retry uses
      // exactly the same key. Never replace it on an ambiguous failure.
      throw error;
    }
    outcome = "declined";
  }

  return ctx.db.transaction<Result>((tx) => {
    const order = readOrder(tx, orderKey, orderId);
    if (order.status === "paid") return "paid";

    const current = tx.get<Attempt>(attemptKey);
    if (!current) throw new Error("Missing checkout attempt");

    if (current.idempotencyKey !== attempt.idempotencyKey) {
      // Another invocation already recorded this attempt's decline and
      // started a new attempt. A late response must not overwrite that work.
      if (outcome === "declined") return "declined";
      throw new Error("Successful checkout attempt was unexpectedly replaced");
    }

    assertSameTerms(order, attempt);

    if (current.status !== "active" && current.status !== outcome) {
      throw new Error("Conflicting checkout outcome");
    }

    const completed: Attempt =
      outcome === "paid"
        ? { ...current, status: "paid", chargeId }
        : { ...current, status: "declined" };

    // Both writes commit together; no lock or process-local state is needed.
    tx.set(attemptKey, completed);
    tx.set<Order>(orderKey, { ...order, status: outcome });
    return outcome;
  });
}
