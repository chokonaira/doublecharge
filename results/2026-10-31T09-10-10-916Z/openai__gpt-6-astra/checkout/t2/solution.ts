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
  amount: number;
  currency: string;
  customerId: string;
  status: "succeeded";
}

interface ChargeParams {
  amount: number;
  currency: string;
  customerId: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

interface PayCo {
  createCharge(params: ChargeParams): Promise<Charge>;
}

interface Ctx {
  db: Db;
  payco: PayCo;
  shipping: unknown;
}

type Result = "paid" | "declined";

interface Attempt {
  id: string;
  params: ChargeParams;
  status: "processing" | Result;
  chargeId?: string;
}

type Selection =
  | { kind: "paid" }
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
): Promise<Result> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:v1:attempt:${JSON.stringify(orderId)}`;

  // Generate outside the transaction so its callback remains side-effect-free.
  const candidateId = randomUUID();

  const selection = await ctx.db.transaction<Selection>((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    if (order.status === "paid") {
      return { kind: "paid" };
    }

    const previous = tx.get<Attempt>(attemptKey);

    if (previous?.status === "paid") {
      tx.set<Order>(orderKey, { ...order, status: "paid" });
      return { kind: "paid" };
    }

    if (previous?.status === "processing") {
      // Concurrent calls and crash recovery reuse exactly the same request.
      return { kind: "attempt", attempt: previous };
    }

    /*
     * A definitive decline ends an attempt. A subsequent call starts a fresh
     * one so PayCo can try the customer's updated saved card.
     *
     * Without a caller-supplied per-click identifier, a retry after a lost
     * decline response cannot be distinguished from a new press of Pay.
     * Both therefore start a new attempt. An uncertain charge never does.
     */
    const attempt: Attempt = {
      id: candidateId,
      status: "processing",
      params: {
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId, checkoutAttemptId: candidateId },
        idempotencyKey: `checkout:v1:${candidateId}`,
      },
    };

    // Persist the key and frozen parameters before contacting PayCo.
    tx.set<Attempt>(attemptKey, attempt);
    tx.set<Order>(orderKey, { ...order, status: "pending" });

    return { kind: "attempt", attempt };
  });

  if (selection.kind === "paid") {
    return "paid";
  }

  const attempt = selection.attempt;
  let outcome: Result;
  let chargeId: string | undefined;

  // Keep database errors outside this catch: only PayCo can declare a decline.
  try {
    const charge = await ctx.payco.createCharge(attempt.params);
    chargeId = charge.id;
    outcome = "paid";
  } catch (error: unknown) {
    if (!hasCode(error, "card_declined")) {
      // In particular, a timeout leaves the attempt unresolved. Retrying uses
      // its persisted key; it must not create a potentially duplicate charge.
      throw error;
    }
    outcome = "declined";
  }

  return ctx.db.transaction<Result>((tx) => {
    const order = tx.get<Order>(orderKey);
    const current = tx.get<Attempt>(attemptKey);

    if (!order || !current) {
      throw new Error(`Checkout state missing for order: ${orderId}`);
    }

    if (current.id !== attempt.id) {
      // A delayed response from an earlier declined attempt must never change
      // the state of a newer attempt.
      if (outcome === "paid") {
        throw new Error(`Checkout attempt invariant violated: ${orderId}`);
      }
      return order.status === "paid" ? "paid" : "declined";
    }

    if (current.status !== "processing" && current.status !== outcome) {
      throw new Error(`Conflicting payment outcomes for order: ${orderId}`);
    }

    if (order.status === "paid" && outcome !== "paid") {
      throw new Error(`Cannot decline an already-paid order: ${orderId}`);
    }

    const completed: Attempt =
      outcome === "paid"
        ? { ...current, status: "paid", chargeId }
        : { ...current, status: "declined" };

    // If this commit succeeds but its response is lost, both records still
    // agree. If it never commits, the persisted attempt safely replays PayCo.
    tx.set<Attempt>(attemptKey, completed);
    tx.set<Order>(orderKey, { ...order, status: outcome });
    return outcome;
  });
}
