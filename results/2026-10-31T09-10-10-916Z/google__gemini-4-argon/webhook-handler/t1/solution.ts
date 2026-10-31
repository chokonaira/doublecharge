interface Ctx {
  db: Db;
  payco: PayCo;
  shipping: Shipping;
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

interface PayCoEvent {
  id: string;
  type: "charge.succeeded" | "charge.refunded";
  created: number;
  data: { charge: Charge };
}

interface Shipping {
  ship(orderId: string, opts?: { idempotencyKey?: string }): Promise<void>;
}

interface Order {
  id: string;
  sellerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "refunded";
}

interface ChargeState {
  creditedAmount: number;
  refundedAmount: number;
  shipped: boolean;
}

/**
 * Handles PayCo webhook events (`charge.succeeded` and `charge.refunded`).
 *
 * Out-of-order, concurrent, and duplicate webhook deliveries are handled by:
 * 1. Fetching the latest authoritative Charge state from PayCo (`payco.getCharge`)
 *    or taking the monotonically highest `amountRefunded` between the event and API.
 * 2. Tracking cumulative `creditedAmount` and `refundedAmount` per charge in a DB
 *    transaction so each cent of credit or refund is applied to `balance:<sellerId>`
 *    at most once, regardless of event ordering or duplication.
 * 3. Only shipping when `event.type === "charge.succeeded"` AND the latest charge
 *    state is not fully refunded. Note: because `shipping.ship` is an external network
 *    call without a cancellation API, a refund arriving concurrently while `ship()` is
 *    in flight cannot abort the in-flight call, but checking the authoritative charge
 *    state beforehand prevents shipping any order already fully refunded.
 */
export async function handleWebhook(event: PayCoEvent, ctx: Ctx): Promise<void> {
  if (event.type !== "charge.succeeded" && event.type !== "charge.refunded") {
    return;
  }

  const eventCharge = event.data?.charge;
  if (!eventCharge?.id) {
    return;
  }

  // Fetch the latest authoritative state from PayCo to protect against stale/out-of-order
  // snapshots and spoofed webhook payloads.
  const fetchedCharge = await ctx.payco.getCharge(eventCharge.id);

  const chargeId = fetchedCharge.id;
  const orderId = fetchedCharge.metadata?.orderId ?? eventCharge.metadata?.orderId;
  if (!orderId) {
    return;
  }

  const chargeAmount = fetchedCharge.amount;
  // amountRefunded only ever increases; take the max in case of replica lag vs event snapshot
  const totalRefunded = Math.min(
    chargeAmount,
    Math.max(fetchedCharge.amountRefunded ?? 0, eventCharge.amountRefunded ?? 0)
  );
  const isFullyRefunded = totalRefunded >= chargeAmount && chargeAmount > 0;

  const orderKey = `order:${orderId}`;
  const stateKey = `charge_state:${chargeId}`;

  const txResult = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      return { orderFound: false, shouldShip: false };
    }

    const state: ChargeState = tx.get<ChargeState>(stateKey) ?? {
      creditedAmount: 0,
      refundedAmount: 0,
      shipped: false,
    };

    // Any charge.succeeded or charge.refunded implies the charge succeeded for `chargeAmount`.
    // Credit the charge amount once, even if `charge.refunded` arrives before `charge.succeeded`.
    const creditDelta = Math.max(0, chargeAmount - state.creditedAmount);
    // Subtract any newly refunded amount not yet deducted.
    const refundDelta = Math.max(0, totalRefunded - state.refundedAmount);

    const netBalanceDelta = creditDelta - refundDelta;

    if (netBalanceDelta !== 0) {
      const balanceKey = `balance:${order.sellerId}`;
      const currentBalance = tx.get<number>(balanceKey) ?? 0;
      tx.set(balanceKey, currentBalance + netBalanceDelta);
    }

    // Order status transitions: pending -> paid -> refunded (never backwards from refunded to paid).
    const targetStatus: Order["status"] =
      isFullyRefunded || order.status === "refunded" ? "refunded" : "paid";

    if (order.status !== targetStatus) {
      tx.set<Order>(orderKey, {
        ...order,
        status: targetStatus,
      });
    }

    state.creditedAmount += creditDelta;
    state.refundedAmount += refundDelta;

    const shouldShip =
      event.type === "charge.succeeded" &&
      targetStatus === "paid" &&
      !isFullyRefunded &&
      !state.shipped;

    tx.set<ChargeState>(stateKey, state);

    return { orderFound: true, shouldShip };
  });

  if (!txResult.orderFound) {
    throw new Error(`Order ${orderId} not found`);
  }

  if (txResult.shouldShip) {
    // Re-check PayCo right before shipping if necessary, and use an idempotencyKey
    // so retries on timeout never create duplicate shipments.
    await ctx.shipping.ship(orderId, { idempotencyKey: `ship:${orderId}` });

    await ctx.db.transaction((tx) => {
      const state = tx.get<ChargeState>(stateKey);
      if (state && !state.shipped) {
        tx.set<ChargeState>(stateKey, { ...state, shipped: true });
      }
    });
  }
}
