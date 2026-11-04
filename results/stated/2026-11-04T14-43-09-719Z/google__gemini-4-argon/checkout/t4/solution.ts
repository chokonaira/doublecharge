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

interface AttemptState {
  version: number;
  idempotencyKey: string;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout_attempt:${orderId}`;

  // Step 1: Read or initialize the current idempotency attempt in the DB.
  // An idempotency key is retained across timeouts/crashes until PayCo definitively declines
  // it and we rotate the key so the customer can retry after updating their card.
  const initResult = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    if (order.status === "paid") {
      return { alreadyPaid: true as const, order, attempt: undefined };
    }

    let attempt = tx.get<AttemptState>(attemptKey);
    if (!attempt) {
      attempt = {
        version: 1,
        idempotencyKey: `order:${orderId}:v1`,
      };
      tx.set(attemptKey, attempt);
    }

    return { alreadyPaid: false as const, order, attempt };
  });

  if (initResult.alreadyPaid) {
    return "paid";
  }

  const { order, attempt } = initResult;

  // Step 2: Call PayCo using the durable idempotency key for the current attempt.
  let chargeResult: "paid" | "declined";
  try {
    await ctx.payco.createCharge({
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      metadata: { orderId: order.id },
      idempotencyKey: attempt.idempotencyKey,
    });
    chargeResult = "paid";
  } catch (err: any) {
    if (err && err.code === "card_declined") {
      chargeResult = "declined";
    } else {
      // For timeouts or unexpected errors, do NOT rotate the idempotency key.
      // Throwing allows the caller or user to retry safely with the same idempotency key.
      throw err;
    }
  }

  // Step 3: Record the outcome in the DB atomically.
  if (chargeResult === "paid") {
    await ctx.db.transaction((tx) => {
      const currentOrder = tx.get<Order>(orderKey);
      if (currentOrder && currentOrder.status !== "paid") {
        tx.set<Order>(orderKey, { ...currentOrder, status: "paid" });
      }
    });
    return "paid";
  } else {
    // Card was declined.
    // Advance the attempt version so the next "Pay" click uses a fresh idempotency key,
    // unless a concurrent request has already paid or already rotated this attempt.
    return await ctx.db.transaction((tx) => {
      const currentOrder = tx.get<Order>(orderKey);
      if (currentOrder?.status === "paid") {
        // Never overwrite "paid" with "declined", and never return "declined" if seen as "paid".
        return "paid" as const;
      }

      const currentAttempt = tx.get<AttemptState>(attemptKey);
      if (currentAttempt && currentAttempt.version === attempt.version) {
        const nextVersion = attempt.version + 1;
        tx.set<AttemptState>(attemptKey, {
          version: nextVersion,
          idempotencyKey: `order:${orderId}:v${nextVersion}`,
        });
        if (currentOrder && currentOrder.status !== "declined") {
          tx.set<Order>(orderKey, { ...currentOrder, status: "declined" });
        }
      }

      return "declined" as const;
    });
  }
}
