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

interface ChargeParams {
  amount: number;
  currency: string;
  customerId: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

interface PayCo {
  createCharge(params: ChargeParams): Promise<{ id: string }>;
}

interface Ctx {
  db: Db;
  payco: PayCo;
  shipping: unknown;
}

interface Attempt {
  params: ChargeParams;
  status: "pending" | Outcome;
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
  const attemptKey = `checkout:attempt:${orderId}`;
  const candidateIdempotencyKey = `checkout:${randomUUID()}`;

  const preparation = await ctx.db.transaction<
    { kind: "paid" } | { kind: "attempt"; attempt: Attempt }
  >((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    if (order.status === "paid") {
      return { kind: "paid" };
    }

    const previous = tx.get<Attempt>(attemptKey);

    // Concurrent calls and retries share both the key and the exact parameters.
    if (previous?.status === "pending") {
      return { kind: "attempt", attempt: previous };
    }

    if (previous?.status === "paid") {
      throw new Error("Inconsistent checkout state: paid attempt on unpaid order");
    }

    // Only a definitive decline permits a new attempt. A new key allows PayCo
    // to try the customer's saved card again rather than replay the decline.
    const attempt: Attempt = {
      status: "pending",
      params: {
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId },
        idempotencyKey: candidateIdempotencyKey,
      },
    };

    tx.set(attemptKey, attempt);
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return { kind: "attempt", attempt };
  });

  if (preparation.kind === "paid") {
    return "paid";
  }

  const { attempt } = preparation;
  let outcome: Outcome;
  let chargeId: string | undefined;

  try {
    const charge = await ctx.payco.createCharge(attempt.params);
    chargeId = charge.id;
    outcome = "paid";
  } catch (error: unknown) {
    if (!hasCode(error, "card_declined")) {
      // In particular, a timeout leaves the durable attempt pending. Even if
      // PayCo charged successfully, retrying this same key cannot charge again.
      throw error;
    }
    outcome = "declined";
  }

  // Keep DB failures outside the PayCo catch: they must never be interpreted
  // as payment failures. A crash here is recovered by replaying the same key.
  return ctx.db.transaction<Outcome>((tx) => {
    const order = tx.get<Order>(orderKey);
    const current = tx.get<Attempt>(attemptKey);

    if (!order || !current) {
      throw new Error("Checkout state disappeared");
    }

    if (
      current.params.idempotencyKey !== attempt.params.idempotencyKey
    ) {
      // Another caller already recorded this attempt's decline and started
      // a newer attempt. Never let an old response overwrite that newer state.
      if (outcome !== "declined") {
        throw new Error("Inconsistent checkout state: successful attempt replaced");
      }
      return order.status === "paid" ? "paid" : "declined";
    }

    if (current.status !== "pending" && current.status !== outcome) {
      throw new Error("Conflicting PayCo results for one idempotency key");
    }

    tx.set<Attempt>(attemptKey, {
      params: current.params,
      status: outcome,
      ...(chargeId === undefined ? {} : { chargeId }),
    });
    tx.set<Order>(orderKey, { ...order, status: outcome });

    return outcome;
  });

  // API limitation: after a persisted decline, a retry following a lost response
  // is indistinguishable from a deliberate new press of Pay. Both start a new
  // attempt. Distinguishing them would require a caller-provided attempt token.
}
