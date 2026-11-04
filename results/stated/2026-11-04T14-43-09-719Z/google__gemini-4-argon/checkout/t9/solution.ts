import { randomUUID } from "node:crypto";

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
  idempotencyKey: string;
  status: "in_flight" | "paid";
  chargeId?: string;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const stateKey = `checkout_state:${orderId}`;

  // Step 1: Atomically inspect the order and current attempt state.
  // If no attempt is currently in flight (and order isn't already paid),
  // claim a new attempt with a fresh idempotencyKey so updated cards can be charged.
  const init = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    const state = tx.get<AttemptState>(stateKey);

    if (order.status === "paid" || state?.status === "paid") {
      if (order.status !== "paid") {
        tx.set<Order>(orderKey, { ...order, status: "paid" });
      }
      return { alreadyPaid: true as const, order, idempotencyKey: "" };
    }

    if (state && state.status === "in_flight") {
      // An earlier attempt didn't finish cleanly (crash or timeout).
      // Reuse its idempotencyKey to safely resolve its outcome without double-charging.
      return {
        alreadyPaid: false as const,
        order,
        idempotencyKey: state.idempotencyKey,
      };
    }

    // No attempt in flight: start a fresh attempt with a new idempotency key.
    const idempotencyKey = `charge:${orderId}:${randomUUID()}`;
    tx.set<AttemptState>(stateKey, {
      idempotencyKey,
      status: "in_flight",
    });

    return {
      alreadyPaid: false as const,
      order,
      idempotencyKey,
    };
  });

  if (init.alreadyPaid) {
    return "paid";
  }

  const { order, idempotencyKey } = init;

  // Step 2: Execute or replay the charge with PayCo using the attempt's idempotencyKey.
  try {
    const charge = await ctx.payco.createCharge({
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      metadata: { orderId },
      idempotencyKey,
    });

    // Step 3a: Charge succeeded. Mark order as "paid" and record the completed state.
    await ctx.db.transaction((tx) => {
      const curOrder = tx.get<Order>(orderKey) ?? order;
      tx.set<Order>(orderKey, { ...curOrder, status: "paid" });
      tx.set<AttemptState>(stateKey, {
        idempotencyKey,
        status: "paid",
        chargeId: charge.id,
      });
    });

    return "paid";
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;

    if (code === "card_declined") {
      // Step 3b: Card was declined.
      // Clear our in_flight state (if it hasn't been superseded) so the next "Pay" press
      // after the customer updates their card gets a fresh idempotencyKey.
      // Also guard against overwriting an order that another request already paid.
      const finalStatus = await ctx.db.transaction((tx) => {
        const curOrder = tx.get<Order>(orderKey) ?? order;
        const curState = tx.get<AttemptState>(stateKey);

        if (curOrder.status === "paid" || curState?.status === "paid") {
          if (curOrder.status !== "paid") {
            tx.set<Order>(orderKey, { ...curOrder, status: "paid" });
          }
          return "paid" as const;
        }

        if (curState && curState.idempotencyKey === idempotencyKey) {
          tx.delete(stateKey);
        }

        tx.set<Order>(orderKey, { ...curOrder, status: "declined" });
        return "declined" as const;
      });

      return finalStatus;
    }

    // For timeouts or any unexpected errors, leave the state as "in_flight"
    // so that retries reuse the same idempotencyKey and rethrow so the caller retries.
    throw err;
  }
}
