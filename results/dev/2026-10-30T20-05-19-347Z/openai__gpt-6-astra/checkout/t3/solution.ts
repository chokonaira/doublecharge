import { randomUUID } from "node:crypto";

// Structural subsets of the runtime interfaces; checkout does not use Shipping.
interface Ctx {
  db: {
    transaction<T>(fn: (tx: Tx) => T): Promise<T>;
  };
  payco: {
    createCharge(params: {
      amount: number;
      currency: string;
      customerId: string;
      idempotencyKey?: string;
    }): Promise<{ id: string; status: "succeeded" }>;
  };
}

interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
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
  customerId: string;
  amount: number;
  currency: string;
}

function requireOrder(tx: Tx, key: string, orderId: string): Order {
  const order = tx.get<Order>(key);
  if (!order) throw new Error(`Order not found: ${orderId}`);
  if (order.id !== orderId) throw new Error("Order ID mismatch");
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
  const attemptKey = `checkout:attempt:v1:${orderId}`;
  const candidateKey = `checkout:v1:${randomUUID()}`;

  const attempt = await ctx.db.transaction<Attempt | null>((tx) => {
    const order = requireOrder(tx, orderKey, orderId);
    if (order.status === "paid") return null;

    const existing = tx.get<Attempt>(attemptKey);
    if (existing) return existing;

    if (
      (order.status !== "pending" && order.status !== "declined") ||
      !Number.isSafeInteger(order.amount) ||
      order.amount < 0 ||
      typeof order.customerId !== "string" ||
      order.customerId.length === 0 ||
      typeof order.currency !== "string" ||
      order.currency.length === 0
    ) {
      throw new Error("Invalid order");
    }

    // Persist both the key and its exact parameters before contacting PayCo.
    const created: Attempt = {
      idempotencyKey: candidateKey,
      customerId: order.customerId,
      amount: order.amount,
      currency: order.currency,
    };
    tx.set(attemptKey, created);
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return created;
  });

  if (attempt === null) return "paid";

  let outcome: "paid" | "declined";
  try {
    // Concurrent callers and crash recovery may all make this call.
    // PayCo's durable idempotency, not an in-memory lock, prevents duplicates.
    await ctx.payco.createCharge({
      amount: attempt.amount,
      currency: attempt.currency,
      customerId: attempt.customerId,
      idempotencyKey: attempt.idempotencyKey,
    });
    outcome = "paid";
  } catch (error: unknown) {
    if (!isCardDeclined(error)) {
      // Never expire or replace an uncertain attempt: a charge may exist.
      // Unknown errors cannot safely be treated as declines with this API.
      // Retrying keeps the same key, even if that means a persistent provider
      // error requires operational intervention rather than another charge.
      throw error;
    }
    outcome = "declined";
  }

  // Keep database errors outside the PayCo catch: a failed acknowledgement
  // must not be mistaken for a failed payment.
  return ctx.db.transaction<"paid" | "declined">((tx) => {
    const order = requireOrder(tx, orderKey, orderId);
    if (order.status === "paid") return "paid";

    const current = tx.get<Attempt>(attemptKey);
    if (current?.idempotencyKey !== attempt.idempotencyKey) {
      // A concurrent caller already recorded this decline, and another Pay
      // request may have started. Never overwrite or delete its newer attempt.
      if (outcome === "declined") return "declined";
      throw new Error("Successful payment attempt unexpectedly replaced");
    }

    // Orders should not be edited during checkout. If another writer does so,
    // do not mark a different amount/customer/currency as paid or declined.
    if (
      order.customerId !== attempt.customerId ||
      order.amount !== attempt.amount ||
      order.currency !== attempt.currency
    ) {
      throw new Error("Order changed during checkout");
    }

    tx.set<Order>(orderKey, { ...order, status: outcome });
    tx.delete(attemptKey);

    // A confirmed decline moved no money, so the next invocation may safely
    // use a fresh key and charge the customer's updated saved card.
    // Without a caller-supplied request ID, a transport retry after a recorded
    // decline is indistinguishable from a new Pay click; both start anew.
    return outcome;
  });
}
