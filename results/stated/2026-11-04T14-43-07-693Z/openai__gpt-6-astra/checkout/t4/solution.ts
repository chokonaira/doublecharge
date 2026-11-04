import { randomUUID } from "node:crypto";

type Outcome = "paid" | "declined";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | Outcome;
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
  amount: number;
  currency: string;
  customerId: string;
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
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | Outcome;
  chargeId?: string;
}

type Plan =
  | { kind: "already-paid" }
  | { kind: "attempt"; attempt: Attempt };

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
  const proposedAttemptId = randomUUID();

  // Persist the exact payment parameters and key before contacting PayCo.
  // No process-local lock or expiring lease is needed: concurrent workers
  // submit the same pending attempt using PayCo's durable idempotency.
  const plan = await ctx.db.transaction<Plan>((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) throw new Error(`Order not found: ${orderId}`);

    if (order.status === "paid") return { kind: "already-paid" };

    const existing = tx.get<Attempt>(attemptKey);
    if (existing?.status === "pending") {
      if (order.status !== "pending") {
        throw new Error("Inconsistent checkout state");
      }
      return { kind: "attempt", attempt: existing };
    }

    if (existing && existing.status !== order.status) {
      throw new Error("Inconsistent checkout state");
    }

    // A terminal decline permits a NEW attempt, so an updated saved card
    // is not trapped behind PayCo's cached card_declined response.
    //
    // The API has no client action/request ID. Consequently, an automatic
    // retry after a committed decline cannot be distinguished from a new
    // Pay click. Both start a new attempt; unresolved attempts never do.
    const attempt: Attempt = {
      id: proposedAttemptId,
      customerId: order.customerId,
      amount: order.amount,
      currency: order.currency,
      status: "pending",
    };

    tx.set(attemptKey, attempt);
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return { kind: "attempt", attempt };
  });

  if (plan.kind === "already-paid") return "paid";

  const { attempt } = plan;
  let outcome: Outcome;
  let chargeId: string | undefined;

  try {
    const charge = await ctx.payco.createCharge({
      amount: attempt.amount,
      currency: attempt.currency,
      customerId: attempt.customerId,
      metadata: {
        orderId,
        checkoutAttemptId: attempt.id,
      },
      idempotencyKey: `checkout:charge:${attempt.id}`,
    });

    outcome = "paid";
    chargeId = charge.id;
  } catch (error: unknown) {
    if (!hasCode(error, "card_declined")) {
      // In particular, a timeout is NOT a decline. Keep the attempt pending
      // and propagate the error. A later caller safely reuses the same key,
      // including if PayCo charged the card before this process died.
      throw error;
    }
    outcome = "declined";
  }

  return ctx.db.transaction<Outcome>((tx) => {
    const order = tx.get<Order>(orderKey);
    const current = tx.get<Attempt>(attemptKey);

    if (!order || !current) {
      throw new Error("Checkout state disappeared");
    }

    if (current.id !== attempt.id) {
      // A delayed response from an older declined attempt must not overwrite
      // a newer attempt. Successful attempts can never be superseded by us.
      if (outcome === "paid") {
        throw new Error("Successful checkout attempt was superseded");
      }
      return order.status === "paid" ? "paid" : "declined";
    }

    if (current.status !== "pending") {
      if (current.status !== outcome || order.status !== outcome) {
        throw new Error("Inconsistent checkout outcome");
      }
      return outcome;
    }

    // Payment parameters are pinned for the lifetime of an attempt.
    // External order editors must not modify an order during checkout:
    // these APIs cannot atomically coordinate such edits with PayCo.
    // If that happens, leave the attempt recoverable for reconciliation.
    if (
      order.status !== "pending" ||
      order.customerId !== attempt.customerId ||
      order.amount !== attempt.amount ||
      order.currency !== attempt.currency
    ) {
      throw new Error("Order changed during checkout");
    }

    tx.set<Attempt>(attemptKey, {
      ...current,
      status: outcome,
      ...(chargeId === undefined ? {} : { chargeId }),
    });
    tx.set<Order>(orderKey, { ...order, status: outcome });

    return outcome;
  });
}
