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

interface ChargeParams {
  amount: number;
  currency: string;
  customerId: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

interface PayCo {
  createCharge(params: ChargeParams): Promise<{
    id: string;
    status: "succeeded";
  }>;
}

interface Ctx {
  db: Db;
  payco: PayCo;
  shipping: unknown;
}

interface Attempt {
  sequence: number;
  params: ChargeParams;
  status: "pending" | "paid" | "declined";
  chargeId?: string;
}

type Result = "paid" | "declined";

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

export async function checkout(
  orderId: string,
  ctx: Ctx,
): Promise<Result> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:attempt:${orderId}`;

  const selection = await ctx.db.transaction<
    { kind: "paid" } | { kind: "attempt"; attempt: Attempt }
  >((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) throw new Error(`Order not found: ${orderId}`);
    if (order.status === "paid") return { kind: "paid" };

    const previous = tx.get<Attempt>(attemptKey);

    if (previous?.status === "pending") {
      // Concurrent requests and crash recovery reuse the exact same request.
      return { kind: "attempt", attempt: previous };
    }

    if (previous?.status === "paid") {
      throw new Error("Inconsistent checkout state: paid attempt on unpaid order");
    }

    const sequence = (previous?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error("Checkout attempt sequence exhausted");
    }

    // Only a definitive decline permits a new attempt. This lets a customer
    // update their saved card and press Pay again without replaying that decline.
    const attempt: Attempt = {
      sequence,
      status: "pending",
      params: {
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: {
          orderId,
          checkoutAttempt: String(sequence),
        },
        idempotencyKey: `checkout:charge:${JSON.stringify([orderId, sequence])}`,
      },
    };

    // Persist the request before contacting PayCo. Keep this record durably:
    // deleting/resetting it could reuse an earlier attempt's idempotency key.
    tx.set(attemptKey, attempt);
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return { kind: "attempt", attempt };
  });

  if (selection.kind === "paid") return "paid";

  const attempt = selection.attempt;
  let result: Result;
  let chargeId: string | undefined;

  try {
    const charge = await ctx.payco.createCharge(attempt.params);
    chargeId = charge.id;
    result = "paid";
  } catch (error: unknown) {
    if (errorCode(error) !== "card_declined") {
      // A timeout or unknown error does not prove that no charge occurred.
      // Leave this attempt pending and propagate the error. Subsequent calls
      // replay its key, never start a potentially duplicate charge.
      //
      // If PayCo permanently replays an ambiguous error, these APIs cannot
      // guarantee progress; the separate reconciliation job must resolve it.
      throw error;
    }
    result = "declined";
  }

  // If the process dies before/during this transaction, replaying the persisted
  // PayCo request recovers its result. No process-local lock or lease is needed.
  return ctx.db.transaction<Result>((tx) => {
    const order = tx.get<Order>(orderKey);
    const current = tx.get<Attempt>(attemptKey);

    if (!order || !current) {
      throw new Error("Checkout state disappeared");
    }

    if (order.status === "paid") return "paid";

    if (current.sequence !== attempt.sequence) {
      // Another caller already recorded this decline and started a newer
      // attempt. Do not let this delayed response overwrite the newer state.
      if (
        result === "declined" &&
        current.sequence > attempt.sequence
      ) {
        return "declined";
      }
      throw new Error("Unexpected checkout attempt change");
    }

    if (current.status !== "pending" && current.status !== result) {
      throw new Error("Conflicting checkout outcomes");
    }

    const completed: Attempt =
      result === "paid"
        ? { ...current, status: "paid", chargeId }
        : { ...current, status: "declined" };

    tx.set(attemptKey, completed);
    tx.set<Order>(orderKey, { ...order, status: result });
    return result;
  });
}
