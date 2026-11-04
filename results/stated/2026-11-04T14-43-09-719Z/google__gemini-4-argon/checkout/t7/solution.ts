import { randomUUID } from "node:crypto";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface ChargeState {
  status: "in_flight" | "paid";
  idempotencyKey: string;
  chargeId?: string;
}

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

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const stateKey = `checkout_state:${orderId}`;
  const candidateKey = randomUUID();

  // Atomically read the order and claim or attach to a charge attempt with an idempotency key.
  // Keeping an active `in_flight` key in the DB until a decline is resolved ensures:
  // 1. Retries after crashes/timeouts reuse the exact same idempotencyKey (preventing double charges).
  // 2. Once declined, the in_flight state is cleared so a subsequent "Pay" click (after updating the card)
  //    generates a fresh idempotencyKey rather than replaying the cached decline from PayCo.
  const txResult = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    const state = tx.get<ChargeState>(stateKey);

    if (order.status === "paid" || state?.status === "paid") {
      if (order.status !== "paid") {
        tx.set<Order>(orderKey, { ...order, status: "paid" });
      }
      return { alreadyPaid: true as const };
    }

    if (state && state.status === "in_flight") {
      return {
        alreadyPaid: false as const,
        order,
        idempotencyKey: state.idempotencyKey,
      };
    }

    const newState: ChargeState = {
      status: "in_flight",
      idempotencyKey: candidateKey,
    };
    tx.set<ChargeState>(stateKey, newState);

    return {
      alreadyPaid: false as const,
      order,
      idempotencyKey: candidateKey,
    };
  });

  if (txResult.alreadyPaid) {
    return "paid";
  }

  const { order, idempotencyKey } = txResult;

  try {
    const charge = await ctx.payco.createCharge({
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      metadata: { orderId },
      idempotencyKey,
    });

    await ctx.db.transaction((tx) => {
      const currentOrder = tx.get<Order>(orderKey) ?? order;
      tx.set<Order>(orderKey, { ...currentOrder, status: "paid" });
      tx.set<ChargeState>(stateKey, {
        status: "paid",
        idempotencyKey,
        chargeId: charge.id,
      });
    });

    return "paid";
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;

    if (code === "card_declined") {
      const finalStatus = await ctx.db.transaction((tx) => {
        const currentOrder = tx.get<Order>(orderKey) ?? order;
        const currentState = tx.get<ChargeState>(stateKey);

        // If a concurrent request already paid the order, never overwrite or return "declined".
        if (currentOrder.status === "paid" || currentState?.status === "paid") {
          if (currentOrder.status !== "paid") {
            tx.set<Order>(orderKey, { ...currentOrder, status: "paid" });
          }
          return "paid" as const;
        }

        // Only clear the in-flight key if it still matches the declined key we used.
        // Clearing it allows the customer to update their saved card and try again with a new key,
        // and prevents later retries from re-reporting an old decline the customer was already told about.
        if (currentState?.idempotencyKey === idempotencyKey) {
          tx.delete(stateKey);
        }

        tx.set<Order>(orderKey, { ...currentOrder, status: "declined" });
        return "declined" as const;
      });

      return finalStatus;
    }

    // For timeouts or any unexpected errors, leave `stateKey` as `in_flight` so that
    // the next retry reuses `idempotencyKey` and safely resolves the attempt.
    throw err;
  }
}
