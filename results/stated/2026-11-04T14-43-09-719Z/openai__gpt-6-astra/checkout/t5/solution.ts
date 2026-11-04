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
  generation: string;
  amount: number;
  currency: string;
  customerId: string;
  status: "pending" | "declined" | "paid";
  chargeId?: string;
}

type Decision =
  | { kind: "done"; result: "paid" | "declined" }
  | { kind: "attempt"; attempt: Attempt };

type Outcome =
  | { kind: "paid"; charge: Charge }
  | { kind: "declined" };

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function readOrder(tx: Tx, key: string, orderId: string): Order {
  const order = tx.get<Order>(key);
  if (!order) throw new Error("Order not found");
  if (order.id !== orderId) throw new Error("Order ID mismatch");
  return order;
}

function checkTerms(order: Order, attempt: Attempt): void {
  if (
    order.amount !== attempt.amount ||
    order.currency !== attempt.currency ||
    order.customerId !== attempt.customerId
  ) {
    // Never change the parameters of an unresolved payment attempt.
    throw new Error("Order payment details changed; reconciliation required");
  }
}

export async function checkout(
  orderId: string,
  ctx: Ctx,
): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:attempt:${orderId}`;

  /*
   * All checkout instances use this durable protocol. "paid" is terminal;
   * attempt records must not be deleted or their generations reset.
   *
   * We cannot atomically acknowledge delivery of an HTTP response. Instead,
   * a decline is persisted before returning it, and requests that subsequently
   * observe that decline start a NEW attempt. Consequently, a crash immediately
   * before returning a decline may cause another card attempt on retry, but
   * cannot cause a duplicate successful charge or replay an already-announced
   * decline to a newly started request.
   */
  let decision = await ctx.db.transaction<Decision>((tx) => {
    const order = readOrder(tx, orderKey, orderId);
    if (order.status === "paid") {
      return { kind: "done", result: "paid" };
    }

    const previous = tx.get<Attempt>(attemptKey);
    if (previous?.status === "paid") {
      throw new Error("Inconsistent paid state; reconciliation required");
    }

    if (previous?.status === "pending") {
      checkTerms(order, previous);
      return { kind: "attempt", attempt: previous };
    }

    if (
      !Number.isSafeInteger(order.amount) ||
      order.amount <= 0 ||
      !order.currency ||
      !order.customerId
    ) {
      throw new Error("Invalid order payment details");
    }

    const attempt: Attempt = {
      generation: previous
        ? (BigInt(previous.generation) + 1n).toString()
        : "1",
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      status: "pending",
    };

    tx.set(attemptKey, attempt);
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return { kind: "attempt", attempt };
  });

  while (decision.kind === "attempt") {
    const attempt = decision.attempt;
    let outcome: Outcome;

    try {
      const charge = await ctx.payco.createCharge({
        amount: attempt.amount,
        currency: attempt.currency,
        customerId: attempt.customerId,
        metadata: { orderId, checkoutAttempt: attempt.generation },
        // JSON encoding avoids ambiguous order-ID/generation concatenations.
        idempotencyKey: JSON.stringify([
          "checkout",
          "charge",
          orderId,
          attempt.generation,
        ]),
      });
      outcome = { kind: "paid", charge };
    } catch (error: unknown) {
      if (errorCode(error) !== "card_declined") {
        /*
         * In particular, a timeout leaves this attempt unresolved. A retry
         * must use the SAME key, even if PayCo already charged the customer.
         * Never interpret a transport error as a decline.
         */
        throw error;
      }
      outcome = { kind: "declined" };
    }

    if (
      outcome.kind === "paid" &&
      (outcome.charge.status !== "succeeded" ||
        !outcome.charge.id ||
        outcome.charge.amount !== attempt.amount ||
        outcome.charge.currency !== attempt.currency ||
        outcome.charge.customerId !== attempt.customerId)
    ) {
      throw new Error("Unexpected charge result; reconciliation required");
    }

    decision = await ctx.db.transaction<Decision>((tx) => {
      const order = readOrder(tx, orderKey, orderId);

      // Once this request reads "paid", it can never return "declined".
      if (order.status === "paid") {
        return { kind: "done", result: "paid" };
      }

      const current = tx.get<Attempt>(attemptKey);
      if (!current || current.status === "paid") {
        throw new Error("Inconsistent checkout state; reconciliation required");
      }
      checkTerms(order, current);

      if (current.generation !== attempt.generation) {
        if (outcome.kind === "paid") {
          // Impossible under this protocol: only a declined attempt advances.
          throw new Error("Successful attempt superseded; reconciliation required");
        }

        /*
         * A concurrent caller completed our decline and another Pay press
         * advanced the attempt. Resolve that newer attempt rather than
         * reporting a stale decline while a newer payment is unresolved.
         * This only joins an existing attempt; it does not allocate one.
         */
        return { kind: "attempt", attempt: current };
      }

      if (outcome.kind === "paid") {
        if (current.status === "declined") {
          throw new Error("Conflicting payment outcomes; reconciliation required");
        }

        tx.set<Attempt>(attemptKey, {
          ...current,
          status: "paid",
          chargeId: outcome.charge.id,
        });
        tx.set<Order>(orderKey, { ...order, status: "paid" });
        return { kind: "done", result: "paid" };
      }

      /*
       * The initial attempt was pending when this request joined it, or was
       * created by this request. Any subsequently joined attempt is newer.
       * No decline for these attempts could have been returned before this
       * request started, because returning requires persisting it first.
       */
      tx.set<Attempt>(attemptKey, { ...current, status: "declined" });
      tx.set<Order>(orderKey, { ...order, status: "declined" });
      return { kind: "done", result: "declined" };
    });
  }

  return decision.result;
}
