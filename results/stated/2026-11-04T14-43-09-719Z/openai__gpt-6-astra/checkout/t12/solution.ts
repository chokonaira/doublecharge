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
  key: string;
  orderId: string;
  customerId: string;
  amount: number;
  currency: string;
  phase: "pending" | "declined" | "paid";
  chargeId?: string;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function readOrder(tx: Tx, key: string, orderId: string): Order {
  const order = tx.get<Order>(key);
  if (!order) throw new Error(`Order not found: ${orderId}`);
  if (order.id !== orderId) throw new Error("Order ID mismatch");
  return order;
}

function assertSameTerms(order: Order, attempt: Attempt): void {
  if (
    order.id !== attempt.orderId ||
    order.customerId !== attempt.customerId ||
    order.amount !== attempt.amount ||
    order.currency !== attempt.currency
  ) {
    // Changing the payment terms of an unresolved attempt cannot safely start
    // another charge: the original charge might already have succeeded.
    throw new Error("Order payment terms changed during checkout");
  }
}

export async function checkout(
  orderId: string,
  ctx: Ctx,
): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:v1:${orderId}`;
  const candidateKey = `checkout:v1:${randomUUID()}`;

  const selected = await ctx.db.transaction<
    { kind: "paid" } | { kind: "attempt"; attempt: Attempt }
  >((tx) => {
    const order = readOrder(tx, orderKey, orderId);
    if (order.status === "paid") return { kind: "paid" };

    const existing = tx.get<Attempt>(attemptKey);

    if (existing) {
      assertSameTerms(order, existing);

      if (existing.phase === "paid") {
        throw new Error("Inconsistent checkout payment state");
      }

      if (existing.phase === "pending") {
        // Includes a charge whose response was lost, or whose caller died.
        // Never replace an unresolved attempt, regardless of its age.
        return { kind: "attempt", attempt: existing };
      }
    }

    if (
      !Number.isSafeInteger(order.amount) ||
      order.amount < 0 ||
      !order.currency ||
      !order.customerId
    ) {
      throw new Error("Invalid order payment terms");
    }

    // A recorded decline is conservatively treated as already reported.
    // A new invocation therefore gets a fresh key and can use an updated card.
    const attempt: Attempt = {
      key: candidateKey,
      orderId: order.id,
      customerId: order.customerId,
      amount: order.amount,
      currency: order.currency,
      phase: "pending",
    };

    tx.set(attemptKey, attempt);
    return { kind: "attempt", attempt };
  });

  if (selected.kind === "paid") return "paid";

  const attempt = selected.attempt;
  let charge: Charge;

  try {
    charge = await ctx.payco.createCharge({
      amount: attempt.amount,
      currency: attempt.currency,
      customerId: attempt.customerId,
      metadata: { orderId: attempt.orderId },
      idempotencyKey: attempt.key,
    });
  } catch (error: unknown) {
    if (errorCode(error) !== "card_declined") {
      // In particular, timeout does not authorize a new key. A retry joins
      // this durable attempt and obtains PayCo's original result.
      throw error;
    }

    return ctx.db.transaction<"paid" | "declined">((tx) => {
      const order = readOrder(tx, orderKey, orderId);

      // A concurrent successful checkout takes precedence over our decline.
      if (order.status === "paid") return "paid";

      assertSameTerms(order, attempt);
      const current = tx.get<Attempt>(attemptKey);
      if (!current) throw new Error("Missing checkout attempt");

      if (current.key === attempt.key) {
        if (current.phase === "paid") {
          throw new Error("Inconsistent checkout payment state");
        }

        tx.set<Attempt>(attemptKey, {
          ...current,
          phase: "declined",
        });
        tx.set<Order>(orderKey, { ...order, status: "declined" });
      } else {
        // Another caller has already recorded this attempt's decline and
        // started a later attempt. Do not overwrite that later attempt.
        if (current.phase === "paid" || order.status !== "declined") {
          throw new Error("Inconsistent checkout payment state");
        }
      }

      /*
       * This invocation selected its attempt while it was still pending.
       * Thus its decline had not been marked reported when this invocation
       * started. Concurrent invocations that selected the same pending
       * attempt may also report that decline.
       *
       * The DB commit and delivery of this return value cannot be atomic.
       * We mark the decline reported before returning, conservatively: a
       * crash here makes the next caller start a fresh attempt rather than
       * risk reporting an already-delivered decline. This is safe because
       * PayCo definitively declined this key; no charge can emerge from it.
       */
      return "declined";
    });
  }

  if (
    charge.status !== "succeeded" ||
    charge.amount !== attempt.amount ||
    charge.currency !== attempt.currency ||
    charge.customerId !== attempt.customerId
  ) {
    // Preserve the attempt for investigation/reconciliation, not a new charge.
    throw new Error("PayCo returned an unexpected charge");
  }

  return ctx.db.transaction<"paid">((tx) => {
    const order = readOrder(tx, orderKey, orderId);
    if (order.status === "paid") return "paid";

    assertSameTerms(order, attempt);
    const current = tx.get<Attempt>(attemptKey);

    if (
      !current ||
      current.key !== attempt.key ||
      current.phase !== "pending"
    ) {
      throw new Error("Inconsistent checkout payment state");
    }

    tx.set<Attempt>(attemptKey, {
      ...current,
      phase: "paid",
      chargeId: charge.id,
    });
    tx.set<Order>(orderKey, { ...order, status: "paid" });
    return "paid";
  });
}
