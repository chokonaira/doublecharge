// Local structural types: only the runtime APIs used by checkout are needed.
interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

interface Ctx {
  db: {
    transaction<T>(fn: (tx: Tx) => T): Promise<T>;
  };
  payco: {
    createCharge(p: {
      amount: number;
      currency: string;
      customerId: string;
      metadata?: Record<string, string>;
      idempotencyKey?: string;
    }): Promise<{ id: string; status: "succeeded" }>;
  };
}

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface Attempt {
  number: number;
  amount: number;
  currency: string;
  customerId: string;
  idempotencyKey: string;
  metadata: Record<string, string>;
}

interface CheckoutState {
  version: 1;
  attempt: Attempt;
  outcome: "pending" | "declined" | "paid";
  chargeId?: string;
}

type Plan = { kind: "paid" } | { kind: "charge"; attempt: Attempt };

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

export async function checkout(
  orderId: string,
  ctx: Ctx,
): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const stateKey = `checkout:v1:${orderId}`;

  function readOrder(tx: Tx): Order {
    const order = tx.get<Order>(orderKey);
    if (!order) throw new Error(`Order not found: ${orderId}`);
    if (order.id !== orderId) throw new Error("Order identity mismatch");
    return order;
  }

  function checkState(order: Order, state: CheckoutState): void {
    if (
      state.version !== 1 ||
      !Number.isSafeInteger(state.attempt.number) ||
      state.attempt.number < 1
    ) {
      throw new Error("Invalid checkout state");
    }

    // Freeze payment terms across retries. If another subsystem edits them,
    // fail safely rather than charge different parameters for this checkout.
    if (
      state.attempt.amount !== order.amount ||
      state.attempt.currency !== order.currency ||
      state.attempt.customerId !== order.customerId
    ) {
      throw new Error("Order payment terms changed during checkout");
    }

    if (state.outcome === "paid" && order.status !== "paid") {
      throw new Error("Inconsistent paid order state");
    }
  }

  const plan = await ctx.db.transaction<Plan>((tx) => {
    const order = readOrder(tx);

    // Paid is terminal. As with the supplied order data generally, an existing
    // "paid" status is assumed to have been written only after a real charge.
    if (order.status === "paid") return { kind: "paid" };

    const state = tx.get<CheckoutState>(stateKey);
    if (state) {
      checkState(order, state);

      if (state.outcome === "pending") {
        // Includes a charge whose response or subsequent DB write was lost.
        return { kind: "charge", attempt: state.attempt };
      }
    }

    const number = state ? state.attempt.number + 1 : 1;
    if (!Number.isSafeInteger(number)) {
      throw new Error("Checkout attempt counter exhausted");
    }

    const attempt: Attempt = {
      number,
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      metadata: { orderId },
      // Durable, order-scoped numbering; no process-local coordination.
      idempotencyKey: `checkout:v1:${encodeURIComponent(orderId)}:${number}`,
    };

    tx.set<CheckoutState>(stateKey, {
      version: 1,
      attempt,
      outcome: "pending",
    });
    tx.set<Order>(orderKey, { ...order, status: "pending" });

    return { kind: "charge", attempt };
  });

  if (plan.kind === "paid") return "paid";

  const attempt = plan.attempt;
  let result:
    | { outcome: "paid"; chargeId: string }
    | { outcome: "declined" };

  try {
    const charge = await ctx.payco.createCharge({
      amount: attempt.amount,
      currency: attempt.currency,
      customerId: attempt.customerId,
      metadata: attempt.metadata,
      idempotencyKey: attempt.idempotencyKey,
    });
    result = { outcome: "paid", chargeId: charge.id };
  } catch (error: unknown) {
    if (errorCode(error) !== "card_declined") {
      // In particular, a timeout is not a decline. Leave the attempt pending;
      // another request can safely replay its exact idempotent request.
      throw error;
    }
    result = { outcome: "declined" };
  }

  return ctx.db.transaction<"paid" | "declined">((tx) => {
    const order = readOrder(tx);
    if (order.status === "paid") return "paid";

    const state = tx.get<CheckoutState>(stateKey);
    if (!state) throw new Error("Checkout state disappeared");
    checkState(order, state);

    if (state.attempt.number !== attempt.number) {
      if (
        result.outcome !== "declined" ||
        state.attempt.number < attempt.number
      ) {
        throw new Error("Unexpected checkout attempt transition");
      }

      // A later attempt can exist only after this attempt was declined.
      // This request joined before that decline was marked as possibly told,
      // so the decline was not already told when this request started.
      // Its own charge call also returned card_declined. Do not overwrite a
      // newer attempt's status. The paid check above takes precedence.
      return "declined";
    }

    if (result.outcome === "paid") {
      if (state.outcome !== "pending") {
        throw new Error("Conflicting PayCo outcomes for one idempotency key");
      }

      tx.set<CheckoutState>(stateKey, {
        ...state,
        outcome: "paid",
        chargeId: result.chargeId,
      });
      tx.set<Order>(orderKey, { ...order, status: "paid" });
      return "paid";
    }

    /*
     * Persist "possibly told" before returning the decline. New requests
     * consequently start a fresh attempt, allowing an updated saved card to
     * be charged. Requests that already joined this attempt may still report
     * its decline: it had not been told when those requests started.
     *
     * Actual delivery of a response cannot be atomically committed with Db.
     * If this process dies after this transaction, the next request starts
     * a fresh attempt even though the customer might not have seen the
     * decline. This is safe because the preceding attempt cannot charge.
     * It also avoids ever replaying an already-told decline to a new request.
     */
    tx.set<CheckoutState>(stateKey, { ...state, outcome: "declined" });
    tx.set<Order>(orderKey, { ...order, status: "declined" });
    return "declined";
  });
}
