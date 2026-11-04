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

interface CheckoutState {
  attempt: number;
  chargeId?: string;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const stateKey = `checkout:${orderId}`;

  // Step 1: Atomically inspect the order and allocate or reuse an attempt / idempotency key.
  const init = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    const state = tx.get<CheckoutState>(stateKey);

    if (order.status === "paid") {
      return { alreadyPaid: true as const, order, attempt: state?.attempt ?? 1 };
    }

    let attempt: number;
    if (!state) {
      attempt = 1;
      tx.set<CheckoutState>(stateKey, { attempt });
    } else if (order.status === "declined") {
      // Order was already marked declined before this request started.
      // The customer may have updated their card and pressed Pay again,
      // so we start a fresh attempt with a new idempotency key and reset status to pending.
      attempt = state.attempt + 1;
      tx.set<CheckoutState>(stateKey, { attempt });
      tx.set<Order>(orderKey, { ...order, status: "pending" });
    } else {
      // Order is "pending": reuse the active attempt's idempotency key so we don't
      // double-charge if an earlier request is in-flight or timed out after charging.
      attempt = state.attempt;
    }

    return { alreadyPaid: false as const, order, attempt };
  });

  if (init.alreadyPaid) {
    return "paid";
  }

  const { order, attempt } = init;
  const idempotencyKey = `order:${orderId}:attempt:${attempt}`;

  // Step 2: Call PayCo with the attempt's idempotency key.
  let chargeResult: "paid" | "declined";
  let chargeId: string | undefined;

  try {
    const charge = await ctx.payco.createCharge({
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      metadata: { orderId },
      idempotencyKey,
    });
    chargeResult = "paid";
    chargeId = charge.id;
  } catch (err: any) {
    if (err && err.code === "card_declined") {
      chargeResult = "declined";
    } else {
      // For timeout or unexpected errors, let it throw so the caller/user can safely retry.
      throw err;
    }
  }

  // Step 3: Record the result in the Db, respecting concurrent state transitions.
  return await ctx.db.transaction((tx) => {
    const currentOrder = tx.get<Order>(orderKey) ?? order;
    const currentState = tx.get<CheckoutState>(stateKey);

    // Never overwrite a "paid" order or tell the customer "declined" if the order is already paid.
    if (currentOrder.status === "paid" || currentState?.chargeId) {
      return "paid";
    }

    if (chargeResult === "paid") {
      tx.set<Order>(orderKey, { ...currentOrder, status: "paid" });
      tx.set<CheckoutState>(stateKey, {
        attempt: Math.max(currentState?.attempt ?? attempt, attempt),
        chargeId,
      });
      return "paid";
    } else {
      // Only transition to "declined" if this attempt is still the current attempt.
      // If a concurrent request already saw the decline and moved to attempt + 1,
      // wait/retry or return declined only if still on the same attempt.
      if (!currentState || currentState.attempt === attempt) {
        tx.set<Order>(orderKey, { ...currentOrder, status: "declined" });
        // Advance attempt so the next "Pay" press uses a fresh idempotency key even if
        // another concurrent request is still finishing.
        tx.set<CheckoutState>(stateKey, { attempt: attempt + 1 });
      }
      return "declined";
    }
  });
}
