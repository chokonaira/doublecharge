interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface ChargeParams {
  amount: number;
  currency: string;
  customerId: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

interface Charge {
  id: string;
  amount: number;
  currency: string;
  customerId: string;
  status: "succeeded";
}

interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

interface Db {
  transaction<T>(fn: (tx: Tx) => T): Promise<T>;
}

interface PayCo {
  createCharge(params: ChargeParams): Promise<Charge>;
}

// Only the parts of the runtime interfaces used by checkout are required here.
interface Ctx {
  db: Db;
  payco: PayCo;
}

interface Attempt {
  sequence: number;
  status: "pending" | "declined" | "paid";
  params: ChargeParams;
  chargeId?: string;
}

type Start =
  | { kind: "paid" }
  | { kind: "attempt"; attempt: Attempt };

function readOrder(tx: Tx, key: string, orderId: string): Order {
  const order = tx.get<Order>(key);
  if (!order) throw new Error(`Order not found: ${orderId}`);
  if (order.id !== orderId) throw new Error("Order identity mismatch");
  return order;
}

function assertSameTerms(order: Order, params: ChargeParams): void {
  // Charging and editing an order cannot be coordinated through PayCo.
  // Freeze charge parameters and fail safely if an unresolved order was edited.
  if (
    order.customerId !== params.customerId ||
    order.amount !== params.amount ||
    order.currency !== params.currency
  ) {
    throw new Error("Order terms changed during an unresolved checkout");
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

export async function checkout(
  orderId: string,
  ctx: Ctx,
): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:attempt:${orderId}`;

  /*
   * This durable record must be retained, and order IDs must not be recycled.
   * Reserve the "checkout:charge:" PayCo key namespace for this implementation.
   *
   * An unresolved attempt is always replayed with its original parameters and
   * key. No locks or leases are needed, so an instance dying cannot strand it.
   */
  const start = await ctx.db.transaction<Start>((tx) => {
    const order = readOrder(tx, orderKey, orderId);
    if (order.status === "paid") return { kind: "paid" };

    const previous = tx.get<Attempt>(attemptKey);

    if (previous?.status === "paid") {
      throw new Error("Inconsistent paid checkout state");
    }

    if (previous?.status === "pending") {
      assertSameTerms(order, previous.params);
      return { kind: "attempt", attempt: previous };
    }

    // A recorded decline is conservatively considered already reported.
    // A later invocation gets a fresh key, allowing an updated card to be used.
    const sequence = previous ? previous.sequence + 1 : 1;
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error("Checkout attempt sequence exhausted");
    }

    const attempt: Attempt = {
      sequence,
      status: "pending",
      params: {
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId },
        idempotencyKey: `checkout:charge:${JSON.stringify(orderId)}:${sequence}`,
      },
    };

    tx.set(attemptKey, attempt);
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return { kind: "attempt", attempt };
  });

  if (start.kind === "paid") return "paid";

  const attempt = start.attempt;
  let outcome:
    | { kind: "paid"; charge: Charge }
    | { kind: "declined" };

  try {
    const charge = await ctx.payco.createCharge({
      ...attempt.params,
      metadata: { ...attempt.params.metadata },
    });
    outcome = { kind: "paid", charge };
  } catch (error: unknown) {
    if (errorCode(error) !== "card_declined") {
      // In particular, timeout is NOT a decline. Leave the attempt unresolved;
      // a retry safely recovers PayCo's result using the same idempotency key.
      throw error;
    }
    outcome = { kind: "declined" };
  }

  if (
    outcome.kind === "paid" &&
    (outcome.charge.status !== "succeeded" ||
      outcome.charge.amount !== attempt.params.amount ||
      outcome.charge.currency !== attempt.params.currency ||
      outcome.charge.customerId !== attempt.params.customerId)
  ) {
    throw new Error("PayCo returned a charge with unexpected terms");
  }

  return ctx.db.transaction<"paid" | "declined">((tx) => {
    const order = readOrder(tx, orderKey, orderId);

    // Never report a decline after observing payment.
    if (order.status === "paid") return "paid";

    const current = tx.get<Attempt>(attemptKey);
    if (
      !current ||
      current.sequence !== attempt.sequence ||
      current.params.idempotencyKey !== attempt.params.idempotencyKey
    ) {
      /*
       * Another request advanced to a newer attempt. It might already have
       * charged the customer without recording that result yet. Do not report
       * this request's stale decline; let a retry recover the newer attempt.
       */
      throw new Error("Checkout attempt was superseded; please retry");
    }

    assertSameTerms(order, attempt.params);

    if (outcome.kind === "paid") {
      if (current.status === "declined") {
        throw new Error("PayCo returned contradictory results for one key");
      }

      tx.set<Attempt>(attemptKey, {
        ...current,
        status: "paid",
        chargeId: outcome.charge.id,
      });
      tx.set<Order>(orderKey, { ...order, status: "paid" });
      return "paid";
    }

    if (current.status === "paid") {
      throw new Error("Inconsistent paid checkout state");
    }

    /*
     * This invocation joined while this attempt was pending, before any
     * checkout could have reported its decline. Its own charge call declined,
     * and no newer attempt exists at this final check.
     *
     * Response delivery cannot be atomic with a DB commit. Treat the decline
     * as reported before returning, even if this instance dies immediately
     * afterward. A retry then uses a fresh key, but only after a definite
     * decline, never after an uncertain or successful charge.
     */
    tx.set<Attempt>(attemptKey, { ...current, status: "declined" });
    tx.set<Order>(orderKey, { ...order, status: "declined" });
    return "declined";
  });
}
