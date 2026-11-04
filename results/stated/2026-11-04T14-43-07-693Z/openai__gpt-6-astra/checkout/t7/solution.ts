interface Ctx {
  db: Db;
  payco: PayCo;
  shipping: unknown;
}

// Only the portions of the runtime interfaces used by checkout are needed.
interface Db {
  transaction<T>(fn: (tx: Tx) => T): Promise<T>;
}

interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
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

type Outcome = "paid" | "declined";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | Outcome;
}

interface PaymentAttempt {
  number: number;
  status: "processing" | Outcome;
  // Freeze every request parameter so retries cannot cause an
  // idempotency_mismatch, even if the order is subsequently edited.
  request: {
    amount: number;
    currency: string;
    customerId: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  };
  chargeId?: string;
}

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
  const attemptKey = `checkout:payment-attempt:${orderId}`;

  const preparation = await ctx.db.transaction<
    { kind: "paid" } | { kind: "attempt"; attempt: PaymentAttempt }
  >((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    if (order.status === "paid") {
      return { kind: "paid" };
    }

    const previous = tx.get<PaymentAttempt>(attemptKey);

    // Concurrent requests and retries after a crash share this attempt.
    // There is no expiring lock: expiration cannot prove a charge failed.
    if (previous?.status === "processing") {
      return { kind: "attempt", attempt: previous };
    }

    if (previous?.status === "paid") {
      throw new Error("Inconsistent order and payment state");
    }

    if (
      !Number.isSafeInteger(order.amount) ||
      order.amount <= 0 ||
      !order.currency ||
      !order.customerId
    ) {
      throw new Error("Invalid order payment details");
    }

    const number = (previous?.number ?? 0) + 1;
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new Error("Payment attempt counter exhausted");
    }

    // A confirmed decline permits a new key, so an updated saved card
    // can be tried. The counter must remain durable for this order.
    const attempt: PaymentAttempt = {
      number,
      status: "processing",
      request: {
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId },
        idempotencyKey: `checkout:charge:${JSON.stringify([orderId, number])}`,
      },
    };

    tx.set(attemptKey, attempt);
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return { kind: "attempt", attempt };
  });

  if (preparation.kind === "paid") {
    return "paid";
  }

  const attempt = preparation.attempt;
  let outcome: Outcome;
  let chargeId: string | undefined;

  try {
    const charge = await ctx.payco.createCharge(attempt.request);
    chargeId = charge.id;
    outcome = "paid";
  } catch (error) {
    if (!hasCode(error, "card_declined")) {
      // A timeout or other error is not proof that no charge happened.
      // Leave the attempt intact; a retry uses exactly the same key.
      //
      // If PayCo permanently caches a non-decline error, these APIs do
      // not provide a safe general way to abandon that ambiguous attempt.
      // It must remain unresolved for reconciliation, not risk a new charge.
      throw error;
    }
    outcome = "declined";
  }

  // This transaction may itself fail or lose its response. Retrying is safe:
  // either its writes committed, or the same PayCo key recovers the result.
  return ctx.db.transaction<Outcome>((tx) => {
    const order = tx.get<Order>(orderKey);
    const current = tx.get<PaymentAttempt>(attemptKey);

    if (!order || !current) {
      throw new Error("Missing order or payment state");
    }

    if (order.status === "paid") {
      return "paid";
    }

    if (current.number !== attempt.number) {
      // Another caller recorded our decline and a subsequent checkout
      // started a new attempt. Never overwrite that newer attempt.
      if (outcome === "declined") {
        return "declined";
      }
      throw new Error("Unexpected successful superseded payment attempt");
    }

    if (current.status !== "processing") {
      if (current.status !== outcome || order.status !== outcome) {
        throw new Error("Inconsistent order and payment outcome");
      }
      return outcome;
    }

    const finished: PaymentAttempt = { ...current, status: outcome };
    if (chargeId !== undefined) {
      finished.chargeId = chargeId;
    }

    tx.set(attemptKey, finished);
    tx.set<Order>(orderKey, { ...order, status: outcome });
    return outcome;
  });
}
