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

interface ChargeRequest {
  amount: number;
  currency: string;
  customerId: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

interface PayCo {
  createCharge(params: ChargeRequest): Promise<Charge>;
}

interface Ctx {
  db: Db;
  payco: PayCo;
  shipping: unknown;
}

interface Attempt {
  params: ChargeRequest;
  outcome: "pending" | "declined" | "paid";
  chargeId?: string;
}

function readOrder(tx: Tx, key: string, orderId: string): Order {
  const order = tx.get<Order>(key);
  if (!order) throw new Error(`Order not found: ${orderId}`);
  if (order.id !== orderId) throw new Error("Order ID mismatch");
  return order;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code: unknown }).code
    : undefined;
}

export async function checkout(
  orderId: string,
  ctx: Ctx,
): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:attempt:${orderId}`;
  const candidateIdempotencyKey = `checkout:charge:${randomUUID()}`;

  const selected = await ctx.db.transaction<
    { kind: "paid" } | { kind: "charge"; params: ChargeRequest }
  >((tx) => {
    const order = readOrder(tx, orderKey, orderId);

    // An existing paid order is authoritative. Never downgrade it.
    if (order.status === "paid") return { kind: "paid" };

    const existing = tx.get<Attempt>(attemptKey);

    if (existing?.outcome === "paid") {
      // Normally both records were committed together.
      tx.set<Order>(orderKey, { ...order, status: "paid" });
      return { kind: "paid" };
    }

    if (existing?.outcome === "pending") {
      // This may already have succeeded or declined at PayCo. Replay exactly
      // the persisted request; never replace an unresolved attempt.
      return { kind: "charge", params: existing.params };
    }

    if (
      !Number.isSafeInteger(order.amount) ||
      order.amount <= 0 ||
      typeof order.customerId !== "string" ||
      order.customerId.length === 0 ||
      typeof order.currency !== "string" ||
      order.currency.length === 0
    ) {
      throw new Error("Invalid order payment details");
    }

    // A completed decline gets a new key, allowing an updated saved card
    // to be charged. Concurrent requests join this new pending attempt.
    const params: ChargeRequest = {
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      metadata: { orderId },
      idempotencyKey: candidateIdempotencyKey,
    };

    tx.set<Attempt>(attemptKey, { params, outcome: "pending" });
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return { kind: "charge", params };
  });

  if (selected.kind === "paid") return "paid";

  const params = selected.params;
  let charge: Charge;

  try {
    charge = await ctx.payco.createCharge(params);
  } catch (error: unknown) {
    if (errorCode(error) !== "card_declined") {
      // In particular, a timeout leaves the attempt unresolved. A retry uses
      // the same key, including after a process crash or on another instance.
      throw error;
    }

    return ctx.db.transaction<"paid" | "declined">((tx) => {
      const order = readOrder(tx, orderKey, orderId);
      const current = tx.get<Attempt>(attemptKey);

      if (order.status === "paid") return "paid";

      if (!current) throw new Error("Checkout attempt disappeared");

      if (current.outcome === "paid") {
        tx.set<Order>(orderKey, { ...order, status: "paid" });
        return "paid";
      }

      if (current.params.idempotencyKey === params.idempotencyKey) {
        tx.set<Attempt>(attemptKey, {
          ...current,
          outcome: "declined",
        });
        tx.set<Order>(orderKey, { ...order, status: "declined" });
      }
      // Otherwise a newer attempt exists. Do not overwrite its progress.

      /*
       * This request selected its attempt while it was pending (or created
       * it). No handler can tell the customer that attempt declined until
       * committing its transition out of pending. Therefore this decline
       * had not been reported when this request started. This request's own
       * charge call also definitively declined, and the transaction above
       * has checked for a subsequently recorded payment.
       *
       * Committing and delivering the response cannot be atomic. If we die
       * after this commit, a retry may create a fresh attempt even though
       * the customer never received this decline. That is safe: the old
       * attempt definitively declined, and any new decline is fresh.
       */
      return "declined";
    });
  }

  if (
    charge.status !== "succeeded" ||
    charge.amount !== params.amount ||
    charge.currency !== params.currency ||
    charge.customerId !== params.customerId
  ) {
    // Keep the original key unresolved rather than risk another charge.
    throw new Error("PayCo returned an unexpected charge");
  }

  return ctx.db.transaction<"paid">((tx) => {
    const order = readOrder(tx, orderKey, orderId);
    const current = tx.get<Attempt>(attemptKey);

    if (order.status === "paid") return "paid";

    if (
      !current ||
      current.params.idempotencyKey !== params.idempotencyKey ||
      current.outcome === "declined"
    ) {
      // Impossible under PayCo's idempotency contract and this protocol.
      throw new Error("Checkout attempt changed after a successful charge");
    }

    tx.set<Attempt>(attemptKey, {
      ...current,
      outcome: "paid",
      chargeId: charge.id,
    });
    tx.set<Order>(orderKey, { ...order, status: "paid" });
    return "paid";
  });
}
