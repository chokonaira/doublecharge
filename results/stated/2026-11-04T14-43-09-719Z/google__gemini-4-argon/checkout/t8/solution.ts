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
  status: "in_flight" | "declined" | "paid";
  chargeId?: string;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const metaKey = `checkout_meta:${orderId}`;

  // Atomically inspect order & checkout metadata, claiming an idempotency key for this attempt.
  // If the previous attempt was already resolved as declined, advance to a new attempt key so
  // the customer can retry after updating their saved card.
  // If the previous attempt is still "in_flight" (e.g., due to a crash or timeout), reuse its
  // idempotency key to avoid double-charging the customer.
  const prep = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    if (order.status === "paid") {
      return { alreadyPaid: true as const };
    }

    let meta = tx.get<CheckoutMeta>(metaKey);
    if (!meta) {
      meta = { attempt: 1, status: "in_flight" };
      tx.set(metaKey, meta);
    } else if (meta.status === "paid") {
      tx.set<Order>(orderKey, { ...order, status: "paid" });
      return { alreadyPaid: true as const };
    } else if (meta.status === "declined") {
      meta = { attempt: meta.attempt + 1, status: "in_flight" };
      tx.set(metaKey, meta);
    }
    // If meta.status === "in_flight", we reuse the current attempt number and idempotency key.

    return {
      alreadyPaid: false as const,
      order,
      attempt: meta.attempt,
    };
  });

  if (prep.alreadyPaid) {
    return "paid";
  }

  const { order, attempt } = prep;
  const idempotencyKey = `order:${orderId}:attempt:${attempt}`;

  try {
    const charge = await ctx.payco.createCharge({
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      metadata: { orderId },
      idempotencyKey,
    });

    await ctx.db.transaction((tx) => {
      const curOrder = tx.get<Order>(orderKey);
      if (curOrder && curOrder.status !== "paid") {
        tx.set<Order>(orderKey, { ...curOrder, status: "paid" });
      }
      tx.set<CheckoutMeta>(metaKey, {
        attempt,
        status: "paid",
        chargeId: charge.id,
      });
    });

    return "paid";
  } catch (err: any) {
    if (err && err.code === "card_declined") {
      const outcome = await ctx.db.transaction((tx) => {
        const curOrder = tx.get<Order>(orderKey);
        const curMeta = tx.get<CheckoutMeta>(metaKey);

        // If another concurrent request succeeded and marked it paid, never overwrite or return "declined"
        if (curOrder?.status === "paid" || curMeta?.status === "paid") {
          if (curOrder && curOrder.status !== "paid") {
            tx.set<Order>(orderKey, { ...curOrder, status: "paid" });
          }
          return "paid" as const;
        }

        // Only advance state if our attempt is still the active one
        if (!curMeta || curMeta.attempt === attempt) {
          if (curOrder) {
            tx.set<Order>(orderKey, { ...curOrder, status: "declined" });
          }
          tx.set<CheckoutMeta>(metaKey, {
            attempt,
            status: "declined",
          });
        }

        return "declined" as const;
      });

      return outcome;
    }

    // For timeouts or any unexpected errors, leave meta.status as "in_flight" and rethrow
    // so the caller or user can safely retry with the same idempotency key.
    throw err;
  }
}
