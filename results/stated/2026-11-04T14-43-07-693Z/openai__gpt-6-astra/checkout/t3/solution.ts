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
    createCharge(p: {
      amount: number;
      currency: string;
      customerId: string;
      metadata?: Record<string, string>;
      idempotencyKey?: string;
    }): Promise<{ id: string; status: "succeeded" }>;
  };
  shipping: unknown;
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
  idempotencyKey: string;
  orderId: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | Outcome;
  chargeId?: string;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function matchesOrder(attempt: Attempt, order: Order): boolean {
  return (
    attempt.orderId === order.id &&
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
  const attemptKey = `checkout-attempt:${orderId}`;
  const candidateKey = `checkout:${randomUUID()}`;

  // Persist the request parameters and key BEFORE contacting PayCo. Concurrent
  // callers and retries on other instances must use this same durable attempt.
  const selection = await ctx.db.transaction<
    { kind: "paid" } | { kind: "attempt"; attempt: Attempt }
  >((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) throw new Error(`Order not found: ${orderId}`);
    if (order.id !== orderId) throw new Error("Order ID mismatch");
    if (order.status === "paid") return { kind: "paid" };

    const existing = tx.get<Attempt>(attemptKey);
    if (existing?.status === "pending") {
      if (!matchesOrder(existing, order)) {
        throw new Error("Order changed during an unresolved payment attempt");
      }
      return { kind: "attempt", attempt: existing };
    }

    if (existing?.status === "paid") {
      throw new Error("Inconsistent paid order state");
    }

    // Only a definitively declined attempt permits a new payment key.
    // This allows the customer to update their saved card and try again.
    const attempt: Attempt = {
      idempotencyKey: candidateKey,
      orderId,
      customerId: order.customerId,
      amount: order.amount,
      currency: order.currency,
      status: "pending",
    };

    tx.set(attemptKey, attempt);
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return { kind: "attempt", attempt };
  });

  if (selection.kind === "paid") return "paid";
  const attempt = selection.attempt;

  const finish = (
    outcome: Outcome,
    chargeId?: string,
  ): Promise<Outcome> =>
    ctx.db.transaction<Outcome>((tx) => {
      const order = tx.get<Order>(orderKey);
      if (!order) throw new Error(`Order not found: ${orderId}`);

      if (order.status === "paid") return "paid";

      const current = tx.get<Attempt>(attemptKey);
      if (current?.idempotencyKey !== attempt.idempotencyKey) {
        // A delayed decline from an older attempt must not overwrite a newer
        // attempt. A successful attempt is never superseded by this module.
        if (outcome === "declined") return "declined";
        throw new Error("Successful payment attempt was unexpectedly superseded");
      }

      if (!matchesOrder(attempt, order)) {
        // External order edits cannot be made atomic with PayCo. Preserve the
        // payment record and leave such inconsistencies for reconciliation.
        throw new Error("Order changed during payment");
      }

      if (current.status !== "pending" && current.status !== outcome) {
        throw new Error("Conflicting payment outcomes");
      }

      tx.set<Attempt>(attemptKey, {
        ...current,
        status: outcome,
        ...(chargeId === undefined ? {} : { chargeId }),
      });
      tx.set<Order>(orderKey, { ...order, status: outcome });
      return outcome;
    });

  let charge: { id: string; status: "succeeded" };
  try {
    charge = await ctx.payco.createCharge({
      amount: attempt.amount,
      currency: attempt.currency,
      customerId: attempt.customerId,
      metadata: { orderId: attempt.orderId },
      idempotencyKey: attempt.idempotencyKey,
    });
  } catch (error: unknown) {
    if (errorCode(error) === "card_declined") {
      return finish("declined");
    }

    // Timeout and all other uncertain failures leave the attempt pending.
    // Never rotate its key: PayCo may already have charged the customer.
    throw error;
  }

  // If this transaction fails, or this instance dies before it completes,
  // the next caller replays the same PayCo request and safely finishes it.
  return finish("paid", charge.id);
}
