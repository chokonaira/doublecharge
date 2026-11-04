import { randomUUID } from "node:crypto";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface CheckoutState {
  status: "in_flight" | "paid" | "declined";
  attemptId: string;
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
  const stateKey = `checkout:${orderId}`;

  // Step 1: Atomically inspect current order & checkout state, or start a new attempt.
  const initResult = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    const state = tx.get<CheckoutState>(stateKey);

    if (order.status === "paid" || state?.status === "paid") {
      if (order.status !== "paid") {
        tx.set(orderKey, { ...order, status: "paid" });
      }
      return { action: " already_paid" as const };
    }

    if (state?.status === "in_flight") {
      // An earlier request crashed or is still running; join its attemptId so we
      // never double-charge, while tracking that this decline might precede our start.
      return {
        action: "join_in_flight" as const,
        attemptId: state.attemptId,
        order,
      };
    }

    // No in-flight attempt (either fresh or previously declined and customer is retrying).
    const attemptId = randomUUID();
    tx.set<CheckoutState>(stateKey, {
      status: "in_flight",
      attemptId,
    });
    return {
      action: "start_new" as const,
      attemptId,
      order,
    };
  });

  if (initResult.action === " already_paid") {
    return "paid";
  }

  let { attemptId, order } = initResult;
  let isFreshAttempt = initResult.action === "start_new";

  while (true) {
    try {
      const charge = await ctx.payco.createCharge({
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId },
        idempotencyKey: `checkout:${orderId}:${attemptId}`,
      });

      await ctx.db.transaction((tx) => {
        const curOrder = tx.get<Order>(orderKey) ?? order;
        tx.set<Order>(orderKey, { ...curOrder, status: "paid" });
        tx.set<CheckoutState>(stateKey, {
          status: "paid",
          attemptId,
          chargeId: charge.id,
        });
      });

      return "paid";
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "card_declined") {
        if (isFreshAttempt) {
          // The decline definitely happened after this request started.
          const finalStatus = await ctx.db.transaction((tx) => {
            const curOrder = tx.get<Order>(orderKey) ?? order;
            const curState = tx.get<CheckoutState>(stateKey);

            if (curOrder.status === "paid" || curState?.status === "paid") {
              if (curOrder.status !== "paid") {
                tx.set<Order>(orderKey, { ...curOrder, status: "paid" });
              }
              return "paid" as const;
            }

            tx.set<Order>(orderKey, { ...curOrder, status: "declined" });
            if (!curState || curState.attemptId === attemptId) {
              tx.set<CheckoutState>(stateKey, {
                status: "declined",
                attemptId,
              });
            }
            return "declined" as const;
          });

          return finalStatus;
        } else {
          // We joined an already in-flight attempt that turned out to be declined.
          // Because another request might have already returned "declined" to the customer
          // before our request started, or the customer may have updated their card right before
          // clicking Pay again, we must do a fresh attempt with a new idempotency key.
          const next = await ctx.db.transaction((tx) => {
            const curOrder = tx.get<Order>(orderKey) ?? order;
            const curState = tx.get<CheckoutState>(stateKey);

            if (curOrder.status === "paid" || curState?.status === "paid") {
              if (curOrder.status !== "paid") {
                tx.set<Order>(orderKey, { ...curOrder, status: "paid" });
              }
              return { done: "paid" as const };
            }

            if (curState && curState.attemptId !== attemptId && curState.status === "in_flight") {
              // Another concurrent request already rotated the attemptId.
              return {
                done: false as const,
                attemptId: curState.attemptId,
                isFresh: true, // Created after our request started
                order: curOrder,
              };
            }

            const newAttemptId = randomUUID();
            tx.set<CheckoutState>(stateKey, {
              status: "in_flight",
              attemptId: newAttemptId,
            });
            return {
              done: false as const,
              attemptId: newAttemptId,
              isFresh: true,
              order: curOrder,
            };
          });

          if (next.done === "paid") {
            return "paid";
          }

          attemptId = next.attemptId;
          isFreshAttempt = next.isFresh;
          order = next.order;
          continue;
        }
      }

      // Any other error (e.g., timeout, network error): leave state as "in_flight"
      // so the next retry resolves the same idempotencyKey safely.
      throw err;
    }
  }
}
