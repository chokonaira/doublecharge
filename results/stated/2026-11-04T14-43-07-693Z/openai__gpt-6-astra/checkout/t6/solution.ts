import { randomUUID } from "node:crypto";

// Local structural declarations for the runtime APIs used by checkout.
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
  metadata: Record<string, string>;
  status: "succeeded";
  amountRefunded: number;
  created: number;
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

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | Result;
}

interface Attempt {
  id: string;
  params: ChargeParams;
  status: "pending" | Result;
  chargeId?: string;
}

type Start =
  | { kind: "paid" }
  | { kind: "attempt"; attempt: Attempt };

type Outcome =
  | { status: "paid"; chargeId: string }
  | { status: "declined" };

function readOrder(tx: Tx, key: string, orderId: string): Order {
  const order = tx.get<Order>(key);
  if (!order) throw new Error(`Order not found: ${orderId}`);
  if (order.id !== orderId) throw new Error("Order ID does not match its key");
  return order;
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

  // Generated outside the callback so transaction retries use the same value.
  const candidateId = randomUUID();

  const start = await ctx.db.transaction<Start>((tx) => {
    const order = readOrder(tx, orderKey, orderId);
    if (order.status === "paid") return { kind: "paid" };

    const current = tx.get<Attempt>(attemptKey);

    if (current?.status === "pending") {
      // Concurrent callers and crash recovery must use exactly these parameters.
      return { kind: "attempt", attempt: current };
    }

    if (current?.status === "paid") {
      throw new Error("Checkout state is inconsistent with the order");
    }

    // Only a definitively declined attempt may be replaced. Reusing its key
    // would replay the decline even after the customer updates their saved card.
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

    tx.set(attemptKey, attempt);
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return { kind: "attempt", attempt };
  });

  if (start.kind === "paid") return "paid";

  const { attempt } = start;
  let outcome: Outcome;

  // No lock or lease is necessary: duplicate calls use PayCo's idempotency.
  // If this process dies after charging, a retry recovers the same charge.
  try {
    const charge = await ctx.payco.createCharge(attempt.params);
    outcome = { status: "paid", chargeId: charge.id };
  } catch (error: unknown) {
    if (!isCardDeclined(error)) {
      // Timeouts and unknown errors do not prove that no charge occurred.
      // Leave the attempt pending; retries must never use a fresh key.
      throw error;
    }
    outcome = { status: "declined" };
  }

  return ctx.db.transaction<Result>((tx) => {
    const order = readOrder(tx, orderKey, orderId);
    const current = tx.get<Attempt>(attemptKey);

    if (order.status === "paid") return "paid";

    if (!current) {
      throw new Error("Checkout attempt is missing");
    }

    if (current.id !== attempt.id) {
      // A slow response from a previously declined attempt must not overwrite
      // a newer attempt's order status.
      if (outcome.status === "declined") return "declined";
      throw new Error("A successful checkout attempt was unexpectedly replaced");
    }

    if (current.status !== "pending") {
      if (current.status !== outcome.status || order.status !== current.status) {
        throw new Error("Checkout outcome is inconsistent");
      }
      return current.status;
    }

    // Other order writers must not change payment details during checkout.
    // The APIs cannot atomically charge PayCo and prevent such external edits;
    // refuse to mark an edited order paid and leave recovery to reconciliation.
    if (
      order.amount !== attempt.params.amount ||
      order.currency !== attempt.params.currency ||
      order.customerId !== attempt.params.customerId
    ) {
      throw new Error("Order payment details changed during checkout");
    }

    tx.set<Attempt>(attemptKey, {
      ...current,
      status: outcome.status,
      ...(outcome.status === "paid" ? { chargeId: outcome.chargeId } : {}),
    });
    tx.set<Order>(orderKey, { ...order, status: outcome.status });

    // There is no client request ID: a call arriving after a recorded decline
    // is treated as another Pay click. This is safe because that attempt
    // definitively created no charge.
    return outcome.status;
  });
}
