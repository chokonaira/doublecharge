interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
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
  createCharge(p: {
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
  sequence: string;
  status: "in_flight" | "declined" | "paid";
  customerId: string;
  amount: number;
  currency: string;
  chargeId?: string;
}

type Start =
  | { kind: "paid" }
  | { kind: "attempt"; attempt: Attempt };

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function readOrder(tx: Tx, key: string, orderId: string): Order {
  const order = tx.get<Order>(key);
  if (!order) throw new Error(`Order not found: ${orderId}`);
  if (order.id !== orderId) throw new Error("Order ID mismatch");
  return order;
}

function assertSamePayment(order: Order, attempt: Attempt): void {
  if (
    order.customerId !== attempt.customerId ||
    order.amount !== attempt.amount ||
    order.currency !== attempt.currency
  ) {
    // An unresolved payment must not silently become a payment for edited terms.
    throw new Error("Order payment details changed during checkout");
  }
}

export async function checkout(
  orderId: string,
  ctx: Ctx,
): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout-attempt:${orderId}`;

  const start = await ctx.db.transaction<Start>((tx) => {
    const order = readOrder(tx, orderKey, orderId);
    if (order.status === "paid") return { kind: "paid" };

    const previous = tx.get<Attempt>(attemptKey);
    if (previous?.status === "paid") {
      throw new Error("Inconsistent paid checkout state");
    }

    if (previous?.status === "in_flight") {
      assertSamePayment(order, previous);
      return { kind: "attempt", attempt: previous };
    }

    /*
     * A persisted decline has already been reserved for notification. A new
     * request must use a new key so an updated saved card can be charged.
     *
     * An unresolved attempt never expires: its key might already hold a charge.
     * All instances must recover it using exactly the same key and parameters.
     */
    const attempt: Attempt = {
      sequence: previous
        ? (BigInt(previous.sequence) + BigInt(1)).toString()
        : "1",
      status: "in_flight",
      customerId: order.customerId,
      amount: order.amount,
      currency: order.currency,
    };

    tx.set(attemptKey, attempt);
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return { kind: "attempt", attempt };
  });

  if (start.kind === "paid") return "paid";
  const attempt = start.attempt;

  // JSON encoding makes the order/sequence pair unambiguous. Never delete or
  // reset the attempt record, or reuse order IDs for different orders.
  const idempotencyKey = JSON.stringify([
    "checkout",
    "charge",
    orderId,
    attempt.sequence,
  ]);

  let charge: Charge | undefined;
  try {
    charge = await ctx.payco.createCharge({
      amount: attempt.amount,
      currency: attempt.currency,
      customerId: attempt.customerId,
      metadata: {
        orderId,
        checkoutAttempt: attempt.sequence,
      },
      idempotencyKey,
    });
  } catch (error) {
    if (errorCode(error) !== "card_declined") {
      /*
       * In particular, a timeout is not a decline. Leave the attempt recoverable
       * and propagate the error; a later request retries the same PayCo key.
       */
      throw error;
    }
  }

  if (
    charge !== undefined &&
    (charge.status !== "succeeded" ||
      charge.amount !== attempt.amount ||
      charge.currency !== attempt.currency ||
      charge.customerId !== attempt.customerId)
  ) {
    throw new Error("PayCo returned an unexpected charge");
  }

  return ctx.db.transaction<"paid" | "declined">((tx) => {
    const order = readOrder(tx, orderKey, orderId);

    // Never report a decline after observing a completed payment.
    if (order.status === "paid") return "paid";

    const current = tx.get<Attempt>(attemptKey);
    if (!current || current.sequence !== attempt.sequence) {
      /*
       * A newer attempt may already have charged the customer without its
       * result reaching the Db. Do not report this older attempt's decline.
       */
      throw new Error("Checkout attempt superseded; please retry");
    }

    assertSamePayment(order, attempt);
    assertSamePayment(order, current);

    if (charge !== undefined) {
      if (current.status === "declined") {
        throw new Error("PayCo returned conflicting idempotent outcomes");
      }

      tx.set<Attempt>(attemptKey, {
        ...current,
        status: "paid",
        chargeId: charge.id,
      });
      tx.set<Order>(orderKey, { ...order, status: "paid" });
      return "paid";
    }

    if (current.status === "paid") {
      throw new Error("Inconsistent paid checkout state");
    }

    /*
     * This request selected this attempt while it was unresolved, before any
     * notification reservation for its decline. Its own PayCo call also
     * definitively declined. Earlier attempts could advance only on declines,
     * so there cannot be an undiscovered earlier successful charge.
     *
     * Reserve notification atomically before returning. Actual delivery to the
     * customer cannot be committed atomically with the Db using these APIs.
     * If the process dies after this commit, a retry conservatively starts a
     * new attempt rather than risking replay of an already reported decline.
     *
     * Concurrent requests that selected this same unresolved attempt may also
     * report its decline, provided no newer attempt has since been installed.
     */
    tx.set<Attempt>(attemptKey, { ...current, status: "declined" });
    tx.set<Order>(orderKey, { ...order, status: "declined" });
    return "declined";
  });
}
