import { randomUUID } from "node:crypto";

interface Ctx {
  db: Db;
  payco: PayCo;
}

interface Db {
  transaction<T>(fn: (tx: Tx) => T): Promise<T>;
}

interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

interface PayCo {
  createCharge(p: ChargeRequest): Promise<Charge>;
}

interface ChargeRequest {
  amount: number;
  currency: string;
  customerId: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

interface Charge {
  id: string;
  status: "succeeded";
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
  request: ChargeRequest;
  status: "pending" | Result;
  chargeId?: string;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function assertSamePayment(order: Order, request: ChargeRequest): void {
  if (
    order.customerId !== request.customerId ||
    order.amount !== request.amount ||
    order.currency !== request.currency
  ) {
    // The APIs cannot atomically lock an order across a remote charge.
    // If another writer edits an in-flight order, leave it for reconciliation
    // rather than mark a different purchase paid or issue another charge.
    throw new Error("Order payment details changed during checkout");
  }
}

export async function checkout(
  orderId: string,
  ctx: Ctx,
): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:attempt:${orderId}`;
  const proposedIdempotencyKey = `checkout:charge:${randomUUID()}`;

  const attempt = await ctx.db.transaction<Attempt | undefined>((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order || order.id !== orderId) {
      throw new Error("Order not found or invalid");
    }

    if (order.status === "paid") return undefined;

    const previous = tx.get<Attempt>(attemptKey);

    if (previous?.status === "pending") {
      assertSamePayment(order, previous.request);
      return previous;
    }

    if (previous?.status === "paid") {
      throw new Error("Inconsistent paid checkout state");
    }

    // A declined key permanently replays its decline. A new Pay attempt must
    // therefore use a new key, while all retries of an unresolved attempt must
    // reuse its existing key and exact parameters.
    //
    // Without a caller-supplied submission ID, an invocation starting after a
    // persisted decline is indistinguishable from another press of Pay; both
    // are treated as a new attempt.
    const next: Attempt = {
      status: "pending",
      request: {
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId },
        idempotencyKey: proposedIdempotencyKey,
      },
    };

    tx.set(attemptKey, next);
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return next;
  });

  if (!attempt) return "paid";

  const settle = (
    result: Result,
    chargeId?: string,
  ): Promise<Result> =>
    ctx.db.transaction<Result>((tx) => {
      const order = tx.get<Order>(orderKey);
      const current = tx.get<Attempt>(attemptKey);

      if (!order || order.id !== orderId || !current) {
        throw new Error("Checkout state missing or invalid");
      }

      if (order.status === "paid") return "paid";

      if (
        current.request.idempotencyKey !== attempt.request.idempotencyKey
      ) {
        // Another invocation already recorded this attempt's decline, and a
        // subsequent Pay attempt has started. Never overwrite that attempt.
        if (result === "declined") return "declined";
        throw new Error("Successful checkout attempt was superseded");
      }

      assertSamePayment(order, attempt.request);

      if (current.status !== "pending" && current.status !== result) {
        throw new Error("Conflicting checkout results");
      }

      const completed: Attempt = { ...current, status: result };
      if (chargeId !== undefined) completed.chargeId = chargeId;

      tx.set(attemptKey, completed);
      tx.set<Order>(orderKey, { ...order, status: result });
      return result;
    });

  let charge: Charge;
  try {
    // Concurrent requests may make this call together. PayCo's shared
    // idempotency, not an in-memory lock or expiring lease, prevents duplicates.
    charge = await ctx.payco.createCharge(attempt.request);
  } catch (error) {
    if (errorCode(error) === "card_declined") {
      return settle("declined");
    }

    // A timeout or other error does not establish that no charge happened.
    // Preserve the attempt so retries/reconciliation use the same key.
    throw error;
  }

  // If the process dies before this commits, retrying createCharge recovers
  // the original charge and then retries this atomic settlement.
  return settle("paid", charge.id);
}
