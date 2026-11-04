import { randomUUID } from "node:crypto";

type Order = {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
};

type ChargeRequest = {
  amount: number;
  currency: string;
  customerId: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
};

type Attempt = {
  request: ChargeRequest;
  status: "charging" | "paid" | "declined";
  chargeId?: string;
};

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function assertSameOrder(
  order: Order | undefined,
  orderId: string,
  request: ChargeRequest,
): asserts order is Order {
  if (
    !order ||
    order.id !== orderId ||
    order.customerId !== request.customerId ||
    order.amount !== request.amount ||
    order.currency !== request.currency
  ) {
    // Order edits cannot be coordinated with PayCo atomically. Keep the
    // existing attempt for reconciliation rather than charge again or mark
    // a changed order paid for the wrong amount/customer.
    throw new Error("Order changed during checkout; reconciliation required");
  }
}

export async function checkout(
  orderId: string,
  ctx: Ctx,
): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:charge-attempt:${orderId}`;

  // Generated outside the transaction so callback retries use the same value.
  const candidateKey = `checkout:${randomUUID()}`;

  const attempt = await ctx.db.transaction<Attempt | undefined>((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order || order.id !== orderId) {
      throw new Error("Order not found");
    }
    if (order.status === "paid") {
      return undefined;
    }

    const existing = tx.get<Attempt>(attemptKey);
    if (existing?.status === "charging") {
      assertSameOrder(order, orderId, existing.request);
      return existing;
    }
    if (existing?.status === "paid") {
      throw new Error("Inconsistent checkout state; reconciliation required");
    }

    // A recorded decline permits a NEW attempt: reusing the declined key
    // would replay the decline even after the saved card has been updated.
    const next: Attempt = {
      status: "charging",
      request: {
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId },
        idempotencyKey: candidateKey,
      },
    };

    // Persist before contacting PayCo. Concurrent requests join this attempt.
    tx.set(attemptKey, next);
    return next;
  });

  if (!attempt) {
    return "paid";
  }

  let outcome: "paid" | "declined";
  let chargeId: string | undefined;

  try {
    const charge = await ctx.payco.createCharge(attempt.request);
    chargeId = charge.id;
    outcome = "paid";
  } catch (error: unknown) {
    if (errorCode(error) !== "card_declined") {
      // A timeout or other error is not proof that no charge occurred.
      // Leave the durable attempt intact; subsequent requests replay exactly
      // the same key and parameters. An unrecoverable provider error may
      // require reconciliation, but must never cause a speculative new charge.
      throw error;
    }
    outcome = "declined";
  }

  await ctx.db.transaction((tx) => {
    const current = tx.get<Attempt>(attemptKey);

    if (
      !current ||
      current.request.idempotencyKey !== attempt.request.idempotencyKey
    ) {
      // Another caller can have finalized our decline and started a new
      // attempt while our PayCo response was still in flight.
      if (current && outcome === "declined") {
        return;
      }
      throw new Error("Checkout attempt changed; reconciliation required");
    }

    if (current.status !== "charging") {
      if (current.status !== outcome) {
        throw new Error("Conflicting payment results; reconciliation required");
      }
      // Another caller already committed this exact result atomically.
      return;
    }

    const order = tx.get<Order>(orderKey);
    assertSameOrder(order, orderId, current.request);

    if (order.status === "paid" && outcome === "declined") {
      throw new Error("Cannot decline an already paid order");
    }

    const completed: Attempt =
      outcome === "paid"
        ? { ...current, status: "paid", chargeId }
        : { ...current, status: "declined" };

    // Both records change together, including after recovery from a crash
    // between a successful PayCo operation and this transaction.
    tx.set<Order>(orderKey, { ...order, status: outcome });
    tx.set<Attempt>(attemptKey, completed);
  });

  return outcome;
}
