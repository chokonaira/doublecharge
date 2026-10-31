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

interface Ctx {
  db: {
    transaction<T>(fn: (tx: Tx) => T): Promise<T>;
  };
  payco: {
    createCharge(p: {
      amount: number;
      currency: string;
      customerId: string;
      metadata?: Record<string, string>;
      idempotencyKey?: string;
    }): Promise<{
      id: string;
      status: "succeeded";
    }>;
  };
}

type Outcome = "paid" | "declined";

interface Attempt {
  number: number;
  status: "pending" | Outcome;
  request: {
    amount: number;
    currency: string;
    customerId: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  };
  chargeId?: string;
}

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
  // This namespace and its records must be reserved for checkout and retained:
  // deleting an attempt record could cause an idempotency key to be reused.
  const attemptKey = `checkout:attempt:${JSON.stringify(orderId)}`;

  const start = await ctx.db.transaction<
    { kind: "paid" } | { kind: "attempt"; attempt: Attempt }
  >((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) throw new Error(`Order not found: ${orderId}`);

    if (order.status === "paid") return { kind: "paid" };

    const previous = tx.get<Attempt>(attemptKey);

    // Concurrent callers and retries must join the unresolved attempt,
    // even if the original caller died or PayCo's response was lost.
    if (previous?.status === "pending") {
      return { kind: "attempt", attempt: previous };
    }

    if (previous?.status === "paid") {
      throw new Error("Checkout state is inconsistent with the order");
    }

    const number = (previous?.number ?? 0) + 1;
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new Error("Checkout attempt counter exhausted");
    }

    // Freeze all request parameters before contacting PayCo. Only a confirmed,
    // persisted decline permits a new key, allowing an updated saved card.
    const attempt: Attempt = {
      number,
      status: "pending",
      request: {
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId },
        idempotencyKey: JSON.stringify(["checkout", orderId, number]),
      },
    };

    tx.set(attemptKey, attempt);
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return { kind: "attempt", attempt };
  });

  if (start.kind === "paid") return "paid";

  const attempt = start.attempt;
  let outcome: Outcome;
  let chargeId: string | undefined;

  // Catch only payment errors, not failures to persist the payment result.
  try {
    const charge = await ctx.payco.createCharge(attempt.request);
    chargeId = charge.id;
    outcome = "paid";
  } catch (error) {
    if (errorCode(error) !== "card_declined") {
      // In particular, timeout is not a decline. Keep the attempt unresolved
      // so a later checkout or reconciliation retries exactly the same key.
      // The API exposes no safe way to rotate keys after other cached errors.
      throw error;
    }
    outcome = "declined";
  }

  return ctx.db.transaction<Outcome>((tx) => {
    const current = tx.get<Attempt>(attemptKey);
    if (!current) throw new Error("Checkout attempt is missing");

    if (current.number !== attempt.number) {
      // A slower caller can receive an old decline after another caller has
      // persisted it and a subsequent Pay click has started a newer attempt.
      // Never let that old response overwrite the newer order state.
      if (current.number > attempt.number && outcome === "declined") {
        return "declined";
      }
      throw new Error("Unexpected checkout attempt transition");
    }

    if (current.status !== "pending") {
      if (current.status !== outcome) {
        throw new Error("Conflicting results for an idempotent charge");
      }
      return current.status;
    }

    const order = tx.get<Order>(orderKey);
    if (!order) throw new Error(`Order not found: ${orderId}`);

    // Order payment fields must not change during checkout. If another writer
    // changes them, do not claim that a charge for the old values paid the new
    // order; leave the durable attempt available for reconciliation.
    if (
      order.customerId !== attempt.request.customerId ||
      order.amount !== attempt.request.amount ||
      order.currency !== attempt.request.currency
    ) {
      throw new Error("Order payment details changed during checkout");
    }

    if (order.status === "paid" && outcome === "declined") {
      throw new Error("Cannot decline an already paid order");
    }

    const settled: Attempt = { ...current, status: outcome };
    if (chargeId !== undefined) settled.chargeId = chargeId;

    tx.set(attemptKey, settled);
    tx.set<Order>(orderKey, { ...order, status: outcome });
    return outcome;
  });
}
