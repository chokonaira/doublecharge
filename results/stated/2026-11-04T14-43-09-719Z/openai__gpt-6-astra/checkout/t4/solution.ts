import { randomUUID } from "node:crypto";

type CheckoutOrder = {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
};

type CheckoutAttempt = {
  request: {
    amount: number;
    currency: string;
    customerId: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  };
  outcome: "open" | "declined" | "paid";
  chargeId?: string;
};

type CheckoutStart =
  | { kind: "paid" }
  | { kind: "attempt"; attempt: CheckoutAttempt };

function isCardDecline(error: unknown): boolean {
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
  const newIdempotencyKey = `checkout:${randomUUID()}`;

  const start = await ctx.db.transaction<CheckoutStart>((tx) => {
    const order = tx.get<CheckoutOrder>(orderKey);
    if (!order) throw new Error(`Order not found: ${orderId}`);

    if (order.status === "paid") return { kind: "paid" };

    const existing = tx.get<CheckoutAttempt>(attemptKey);
    if (existing?.outcome === "paid") {
      throw new Error(`Inconsistent payment state for order: ${orderId}`);
    }

    if (existing?.outcome === "open") {
      // An unresolved attempt may already have charged the customer.
      // All requests must reuse its exact parameters and key.
      return { kind: "attempt", attempt: existing };
    }

    // Only a definitive decline permits replacing an existing attempt.
    const attempt: CheckoutAttempt = {
      request: {
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId },
        idempotencyKey: newIdempotencyKey,
      },
      outcome: "open",
    };

    tx.set(attemptKey, attempt);
    tx.set<CheckoutOrder>(orderKey, { ...order, status: "pending" });
    return { kind: "attempt", attempt };
  });

  if (start.kind === "paid") return "paid";

  const attempt = start.attempt;
  let charge: { id: string };

  try {
    charge = await ctx.payco.createCharge(attempt.request);
  } catch (error: unknown) {
    // In particular, a timeout never authorizes a new key. A later checkout
    // replays this persisted request to discover its definitive outcome.
    if (!isCardDecline(error)) throw error;

    return ctx.db.transaction<"paid" | "declined">((tx) => {
      const order = tx.get<CheckoutOrder>(orderKey);
      if (!order) throw new Error(`Order not found: ${orderId}`);

      // Never report a decline after observing payment.
      if (order.status === "paid") return "paid";

      const current = tx.get<CheckoutAttempt>(attemptKey);
      if (!current || current.outcome === "paid") {
        throw new Error(`Inconsistent payment state for order: ${orderId}`);
      }

      if (
        current.request.idempotencyKey === attempt.request.idempotencyKey
      ) {
        /*
         * Committing this decline also marks it as offered to the customer.
         * The APIs cannot atomically commit and deliver an HTTP response.
         * If we die before delivery, a retry uses a fresh attempt rather than
         * risk returning an already-reported decline.
         */
        tx.set<CheckoutAttempt>(attemptKey, {
          ...current,
          outcome: "declined",
        });
        tx.set<CheckoutOrder>(orderKey, { ...order, status: "declined" });
      }

      /*
       * This attempt was open when this request selected it, so its decline
       * could not have been reported before this request started. Our own
       * charge call definitively declined as well.
       *
       * If another request has since advanced to a newer attempt, do not
       * overwrite its state. Any payment from that newer attempt necessarily
       * happened after this request started; payment already visible above
       * takes precedence.
       */
      return "declined";
    });
  }

  await ctx.db.transaction<void>((tx) => {
    const order = tx.get<CheckoutOrder>(orderKey);
    if (!order) throw new Error(`Order not found: ${orderId}`);

    if (order.status === "paid") return;

    const current = tx.get<CheckoutAttempt>(attemptKey);
    if (
      !current ||
      current.request.idempotencyKey !== attempt.request.idempotencyKey ||
      current.outcome !== "open"
    ) {
      throw new Error(`Inconsistent payment state for order: ${orderId}`);
    }

    tx.set<CheckoutAttempt>(attemptKey, {
      ...current,
      outcome: "paid",
      chargeId: charge.id,
    });
    tx.set<CheckoutOrder>(orderKey, { ...order, status: "paid" });
  });

  return "paid";
}
