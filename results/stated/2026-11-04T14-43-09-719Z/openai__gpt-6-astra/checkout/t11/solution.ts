import { randomUUID } from "node:crypto";

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

interface Ctx {
  db: {
    transaction<T>(fn: (tx: Tx) => T): Promise<T>;
  };
  payco: {
    createCharge(params: {
      amount: number;
      currency: string;
      customerId: string;
      metadata?: Record<string, string>;
      idempotencyKey?: string;
    }): Promise<{
      id: string;
      status: "succeeded";
    }>;
  };
  shipping: unknown;
}

interface Attempt {
  idempotencyKey: string;
  params: {
    amount: number;
    currency: string;
    customerId: string;
    metadata: Record<string, string>;
  };
  status: "pending" | "paid" | "declined";
  chargeId?: string;
}

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
  const attemptKey = `checkout:v1:attempt:${orderId}`;
  const proposedIdempotencyKey = `checkout:v1:charge:${randomUUID()}`;

  const selection = await ctx.db.transaction<
    { kind: "paid" } | { kind: "attempt"; attempt: Attempt }
  >((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    if (order.status === "paid") {
      return { kind: "paid" };
    }

    const current = tx.get<Attempt>(attemptKey);

    if (current?.status === "paid") {
      // The durable successful charge also establishes that payment happened.
      tx.set<Order>(orderKey, { ...order, status: "paid" });
      return { kind: "paid" };
    }

    if (current?.status === "pending") {
      // Concurrent requests and crash recovery must resolve this exact attempt.
      return { kind: "attempt", attempt: current };
    }

    // A completed decline permits a fresh attempt, including after a card update.
    const attempt: Attempt = {
      idempotencyKey: proposedIdempotencyKey,
      params: {
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId },
      },
      status: "pending",
    };

    tx.set<Attempt>(attemptKey, attempt);
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return { kind: "attempt", attempt };
  });

  if (selection.kind === "paid") {
    return "paid";
  }

  const attempt = selection.attempt;
  let outcome: "paid" | "declined";
  let chargeId: string | undefined;

  try {
    const charge = await ctx.payco.createCharge({
      ...attempt.params,
      idempotencyKey: attempt.idempotencyKey,
    });
    chargeId = charge.id;
    outcome = "paid";
  } catch (error) {
    if (errorCode(error) !== "card_declined") {
      // In particular, a timeout is not a decline. Leave the durable attempt
      // unresolved so a retry uses the same key, even on a different instance.
      throw error;
    }
    outcome = "declined";
  }

  return ctx.db.transaction<"paid" | "declined">((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order disappeared: ${orderId}`);
    }

    if (order.status === "paid") {
      return "paid";
    }

    const current = tx.get<Attempt>(attemptKey);
    if (!current) {
      throw new Error(`Checkout attempt disappeared: ${orderId}`);
    }

    if (current.status === "paid") {
      tx.set<Order>(orderKey, { ...order, status: "paid" });
      return "paid";
    }

    if (current.idempotencyKey !== attempt.idempotencyKey) {
      if (outcome !== "declined") {
        throw new Error(`Successful checkout attempt was superseded: ${orderId}`);
      }

      // Only a confirmed decline allows an attempt to be superseded. This
      // request selected that attempt while it was pending, before its decline
      // could be reported. Its own charge request also returned that decline.
      // Do not overwrite a newer attempt's order status.
      return "declined";
    }

    if (outcome === "paid") {
      tx.set<Attempt>(attemptKey, {
        ...current,
        status: "paid",
        chargeId,
      });
      tx.set<Order>(orderKey, { ...order, status: "paid" });
      return "paid";
    }

    /*
     * Publishing a decline and delivering the response cannot be atomic with
     * these APIs. Conservatively make the decline eligible for a fresh attempt
     * before returning it. If this instance dies before delivery, the next
     * request makes a fresh attempt rather than replaying a possibly already
     * reported decline. An unresolved charge is never superseded.
     *
     * Requests that already selected this pending attempt may still report its
     * decline: it had not been reported when they selected it. Requests starting
     * after this transaction instead select a fresh attempt.
     */
    tx.set<Attempt>(attemptKey, { ...current, status: "declined" });
    tx.set<Order>(orderKey, { ...order, status: "declined" });
    return "declined";
  });
}
