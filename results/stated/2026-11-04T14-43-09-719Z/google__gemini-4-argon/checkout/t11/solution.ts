interface Ctx {
  db: Db;
  payco: PayCo;
  shipping: unknown;
}

interface Db {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  insertIfAbsent<T>(key: string, value: T): Promise<boolean>;
  update<T>(key: string, fn: (current: T | undefined) => T): Promise<T>;
  transaction<T>(fn: (tx: Tx) => T): Promise<T>;
  delete(key: string): Promise<void>;
}

interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
}

interface PayCo {
  createCharge(p: {
    amount: number;
    currency: string;
    customerId: string;
    metadata?: Record<string, string>;
    idempotencyKey?: string;
  }): Promise<Charge>;
  getCharge(id: string): Promise<Charge>;
  listCharges(filter?: { customerId?: string }): Promise<Charge[]>;
  createPayout(p: {
    amount: number;
    currency: string;
    destination: string;
    idempotencyKey?: string;
  }): Promise<Payout>;
}

interface Charge {
  id: string;
  amount: number;
  currency: string;
  customerId: string;
  metadata: Record<string, string>;
  status: "succeeded";
  amountRefunded: number;
  created: number;
}

interface Payout {
  id: string;
  amount: number;
  currency: string;
  destination: string;
  created: number;
}

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface CheckoutMeta {
  attempt: number;
  chargeId?: string;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const metaKey = `checkout:${orderId}`;

  // Atomically inspect order and determine the active idempotency attempt.
  // If an attempt is already in flight, reuse its attempt number so PayCo deduplicates.
  // If no attempt is in flight (or the previous attempt finished in a decline), start a new attempt.
  const init = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }
    if (order.status === "paid") {
      return { alreadyPaid: true as const, order, attempt: 0 };
    }

    const meta = tx.get<CheckoutMeta>(metaKey);
    if (meta?.chargeId) {
      tx.set<Order>(orderKey, { ...order, status: "paid" });
      return { alreadyPaid: true as const, order, attempt: meta.attempt };
    }

    let attempt: number;
    if (!meta) {
      attempt = 1;
      tx.set<CheckoutMeta>(metaKey, { attempt });
    } else {
      attempt = meta.attempt;
    }

    return { alreadyPaid: false as const, order, attempt };
  });

  if (init.alreadyPaid) {
    return "paid";
  }

  const { order, attempt } = init;
  const idempotencyKey = `checkout:${orderId}:${attempt}`;

  try {
    const charge = await ctx.payco.createCharge({
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      metadata: { orderId },
      idempotencyKey,
    });

    await ctx.db.transaction((tx) => {
      const curOrder = tx.get<Order>(orderKey) ?? order;
      tx.set<Order>(orderKey, { ...curOrder, status: "paid" });
      tx.set<CheckoutMeta>(metaKey, { attempt, chargeId: charge.id });
    });

    return "paid";
  } catch (err: unknown) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "card_declined") {
      const outcome = await ctx.db.transaction((tx) => {
        const curOrder = tx.get<Order>(orderKey);
        const curMeta = tx.get<CheckoutMeta>(metaKey);

        // Never overwrite or contradict an already paid order
        if (curOrder?.status === "paid" || curMeta?.chargeId) {
          if (curOrder && curOrder.status !== "paid") {
            tx.set<Order>(orderKey, { ...curOrder, status: "paid" });
          }
          return "paid" as const;
        }

        // Only advance the attempt number and mark declined if our attempt is still current.
        // Advancing the attempt ensures the next "Pay" click (after updating the saved card)
        // uses a fresh idempotency key rather than replaying this decline.
        if (curMeta && curMeta.attempt === attempt) {
          tx.set<CheckoutMeta>(metaKey, { attempt: attempt + 1 });
          if (curOrder) {
            tx.set<Order>(orderKey, { ...curOrder, status: "declined" });
          }
          return "declined" as const;
        }

        // Another concurrent request already handled this attempt and advanced the counter.
        // We should only return "declined" once per declined attempt so a new retry doesn't
        // get told a stale decline before its new charge attempt finishes.
        return "concurrently_handled" as const;
      });

      if (outcome === "paid") {
        return "paid";
      }
      if (outcome === "declined") {
        return "declined";
      }
      throw err;
    }

    // For timeout or unexpected errors, leave the attempt counter unchanged so the next
    // retry safely reuses the same idempotencyKey.
    throw err;
  }
}
