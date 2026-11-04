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
  delete(key: string): void;
}

interface ChargeParams {
  amount: number;
  currency: string;
  customerId: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

// Structural subsets of the runtime APIs used by this module.
interface Ctx {
  db: {
    transaction<T>(fn: (tx: Tx) => T): Promise<T>;
  };
  payco: {
    createCharge(params: ChargeParams): Promise<{ id: string }>;
  };
  shipping: unknown;
}

interface Attempt {
  id: string;
  status: "pending" | Outcome;
  params: ChargeParams;
  chargeId?: string;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export async function checkout(
  orderId: string,
  ctx: Ctx,
): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:attempt:${JSON.stringify(orderId)}`;
  const candidateId = randomUUID();

  const selection = await ctx.db.transaction<
    { kind: "paid" } | { kind: "attempt"; attempt: Attempt }
  >((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) throw new Error(`Order not found: ${orderId}`);
    if (order.status === "paid") return { kind: "paid" };

    const current = tx.get<Attempt>(attemptKey);

    // An uncertain outcome must always reuse the same key and exact parameters.
    // No lease is needed: concurrent calls to PayCo use its idempotency guarantee.
    if (current?.status === "pending") {
      return { kind: "attempt", attempt: current };
    }

    if (current?.status === "paid") {
      throw new Error(`Inconsistent checkout state for order: ${orderId}`);
    }

    /*
     * A definitively declined attempt needs a fresh key so the customer's
     * updated saved card can be charged.
     *
     * The API supplies no client attempt identifier, so a retry after a
     * durably recorded decline cannot be distinguished from a new Pay click.
     * Both start a new attempt; uncertain attempts never do.
     */
    const attempt: Attempt = {
      id: candidateId,
      status: "pending",
      params: {
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: {
          orderId,
          checkoutAttemptId: candidateId,
        },
        idempotencyKey: `checkout:${candidateId}`,
      },
    };

    // Persist the key and immutable parameters before contacting PayCo.
    tx.set(attemptKey, attempt);
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return { kind: "attempt", attempt };
  });

  if (selection.kind === "paid") return "paid";

  const { attempt } = selection;
  let outcome: Outcome;
  let chargeId: string | undefined;

  // Only errors from createCharge may be interpreted as a card decline.
  try {
    const charge = await ctx.payco.createCharge(attempt.params);
    chargeId = charge.id;
    outcome = "paid";
  } catch (error) {
    if (errorCode(error) !== "card_declined") {
      // Leave the attempt pending, including on timeout. A retry or the
      // reconciliation job can safely replay the persisted request.
      throw error;
    }
    outcome = "declined";
  }

  return ctx.db.transaction<Outcome>((tx) => {
    const order = tx.get<Order>(orderKey);
    const current = tx.get<Attempt>(attemptKey);

    if (!order || !current) {
      throw new Error(`Missing checkout state for order: ${orderId}`);
    }

    if (order.status === "paid") return "paid";

    if (current.id !== attempt.id) {
      // Another call already recorded this decline and a subsequent call
      // started a new attempt. Never overwrite that newer attempt's state.
      if (outcome === "declined") return "declined";
      throw new Error(`Unexpected checkout attempt change: ${orderId}`);
    }

    if (current.status !== "pending" && current.status !== outcome) {
      throw new Error(`Conflicting payment outcomes for order: ${orderId}`);
    }

    const completed: Attempt = { ...current, status: outcome };
    if (chargeId !== undefined) completed.chargeId = chargeId;

    // If the process dies before this commits, replaying createCharge with
    // the persisted key recovers the result without charging twice.
    tx.set(attemptKey, completed);
    tx.set<Order>(orderKey, { ...order, status: outcome });

    return outcome;
  });
}
