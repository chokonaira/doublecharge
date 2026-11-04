import { randomUUID } from "node:crypto";

interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
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
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}

interface PayCo {
  createCharge(params: ChargeParams): Promise<Charge>;
}

interface Ctx {
  db: Db;
  payco: PayCo;
  shipping: unknown;
}

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface Attempt {
  key: string;
  amount: number;
  currency: string;
  customerId: string;
  metadata: Record<string, string>;
  status: "pending" | "declined" | "paid";
  chargeId?: string;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function readOrder(tx: Tx, key: string, orderId: string): Order {
  const order = tx.get<Order>(key);
  if (!order) throw new Error(`Order not found: ${orderId}`);
  if (order.id !== orderId) throw new Error("Order identity mismatch");
  return order;
}

function assertSameTerms(order: Order, attempt: Attempt): void {
  if (
    order.customerId !== attempt.customerId ||
    order.amount !== attempt.amount ||
    order.currency !== attempt.currency
  ) {
    // These APIs cannot prevent an unrelated writer from editing an order
    // during a remote charge. Fail closed rather than charge again or mark
    // a changed order paid; reconciliation must resolve such an edit.
    throw new Error("Order payment terms changed during checkout");
  }
}

export async function checkout(
  orderId: string,
  ctx: Ctx,
): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:attempt:${orderId}`;
  const candidateKey = `checkout:${randomUUID()}`;

  const selection = await ctx.db.transaction<
    { kind: "paid" } | { kind: "attempt"; attempt: Attempt }
  >((tx) => {
    const order = readOrder(tx, orderKey, orderId);
    if (order.status === "paid") return { kind: "paid" };

    const current = tx.get<Attempt>(attemptKey);

    if (current?.status === "paid") {
      throw new Error("Paid checkout attempt has an inconsistent order");
    }

    if (current?.status === "pending") {
      assertSameTerms(order, current);
      return { kind: "attempt", attempt: current };
    }

    // Only a definitively declined attempt can be replaced. An ambiguous
    // timeout or a killed handler leaves the same pending key for retries.
    const attempt: Attempt = {
      key: candidateKey,
      customerId: order.customerId,
      amount: order.amount,
      currency: order.currency,
      metadata: { orderId },
      status: "pending",
    };

    tx.set(attemptKey, attempt);
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return { kind: "attempt", attempt };
  });

  if (selection.kind === "paid") return "paid";

  const attempt = selection.attempt;
  let outcome:
    | { kind: "paid"; chargeId: string }
    | { kind: "declined" };

  try {
    const charge = await ctx.payco.createCharge({
      amount: attempt.amount,
      currency: attempt.currency,
      customerId: attempt.customerId,
      metadata: attempt.metadata,
      idempotencyKey: attempt.key,
    });
    outcome = { kind: "paid", chargeId: charge.id };
  } catch (error) {
    if (errorCode(error) !== "card_declined") {
      // In particular, never treat timeout as a decline or release its key.
      throw error;
    }
    outcome = { kind: "declined" };
  }

  return ctx.db.transaction<"paid" | "declined">((tx) => {
    const order = readOrder(tx, orderKey, orderId);
    if (order.status === "paid") return "paid";

    const current = tx.get<Attempt>(attemptKey);
    if (!current) throw new Error("Checkout attempt unexpectedly missing");

    if (current.key !== attempt.key) {
      if (outcome.kind === "paid") {
        // With PayCo's guarantees, a successful attempt cannot have been
        // replaced: replacement requires a definitive decline on that key.
        throw new Error("Successful checkout attempt unexpectedly replaced");
      }

      // This request joined its attempt before that attempt's decline was
      // committed, so that decline could not have been returned before this
      // request started. Its own charge call also declined. Do not overwrite
      // a newer attempt's order state.
      return "declined";
    }

    assertSameTerms(order, attempt);

    if (outcome.kind === "paid") {
      tx.set<Attempt>(attemptKey, {
        ...current,
        status: "paid",
        chargeId: outcome.chargeId,
      });
      tx.set<Order>(orderKey, { ...order, status: "paid" });
      return "paid";
    }

    if (current.status === "paid") {
      throw new Error("PayCo returned inconsistent results for one key");
    }

    // Commit the decline before exposing it to the caller. Every later
    // checkout selects a fresh attempt, not this cached decline.
    //
    // Delivery to the customer cannot be atomic with this transaction.
    // If we die after committing, a retry may try the card again, but the
    // previous attempt definitively declined, so no charge is duplicated.
    tx.set<Attempt>(attemptKey, { ...current, status: "declined" });
    tx.set<Order>(orderKey, { ...order, status: "declined" });
    return "declined";
  });
}
