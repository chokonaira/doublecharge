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

interface ChargeProcessState {
  creditedAmount: number;
  refundedAmount: number;
  shipped: boolean;
}

export async function handleWebhook(event: PayCoEvent, ctx: Ctx): Promise<void> {
  if (event.type !== "charge.succeeded" && event.type !== "charge.refunded") {
    return;
  }

  const eventCharge = event.data?.charge;
  if (!eventCharge) {
    return;
  }

  // Fetch the latest authoritative state from PayCo.
  // This guarantees correctness against out-of-order events, concurrent events,
  // and prevents shipping if the charge was already fully refunded at PayCo.
  let latestCharge: Charge;
  try {
    latestCharge = await ctx.payco.getCharge(eventCharge.id);
  } catch (err: any) {
    // If PayCo does not have the charge (e.g. a forged webhook event), ignore it.
    if (err && (err.code === "not_found" || err.code === "resource_missing" || err.status === 404)) {
      return;
    }
    throw err;
  }

  if (latestCharge.status !== "succeeded") {
    return;
  }

  const orderId = latestCharge.metadata?.orderId;
  if (!orderId) {
    return;
  }

  const orderKey = `order:${orderId}`;
  const stateKey = `charge_state:${latestCharge.id}`;

  // Monotonically merge the event payload and live PayCo state
  const targetAmount = latestCharge.amount;
  const targetRefunded = Math.min(
    targetAmount,
    Math.max(latestCharge.amountRefunded ?? 0, eventCharge.amountRefunded ?? 0)
  );
  const isFullyRefunded = targetRefunded >= targetAmount;

  const txResult = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      return { shouldShip: false };
    }

    const state = tx.get<ChargeProcessState>(stateKey) ?? {
      creditedAmount: 0,
      refundedAmount: 0,
      shipped: false,
    };

    const newCreditedAmount = Math.max(state.creditedAmount, targetAmount);
    const newRefundedAmount = Math.max(state.refundedAmount, targetRefunded);

    const creditDelta = newCreditedAmount - state.creditedAmount;
    const refundDelta = newRefundedAmount - state.refundedAmount;
    const balanceDelta = creditDelta - refundDelta;

    if (balanceDelta !== 0) {
      const balanceKey = `balance:${order.sellerId}`;
      const currentBalance = tx.get<number>(balanceKey) ?? 0;
      tx.set(balanceKey, currentBalance + balanceDelta);
    }

    let newOrderStatus: Order["status"] = order.status;
    if (isFullyRefunded || order.status === "refunded") {
      newOrderStatus = "refunded";
    } else {
      newOrderStatus = "paid";
    }

    if (newOrderStatus !== order.status) {
      tx.set(orderKey, { ...order, status: newOrderStatus });
    }

    if (creditDelta !== 0 || refundDelta !== 0) {
      tx.set(stateKey, {
        creditedAmount: newCreditedAmount,
        refundedAmount: newRefundedAmount,
        shipped: state.shipped,
      });
    }

    const shouldShip = !state.shipped && newOrderStatus === "paid" && !isFullyRefunded;
    return { shouldShip };
  });

  if (txResult.shouldShip) {
    // Use a deterministic idempotency key per order so retries or concurrent
    // webhook deliveries never create duplicate shipments.
    await ctx.shipping.ship(orderId, { idempotencyKey: `ship:order:${orderId}` });

    await ctx.db.transaction((tx) => {
      const state = tx.get<ChargeProcessState>(stateKey);
      if (state && !state.shipped) {
        tx.set(stateKey, { ...state, shipped: true });
      }
    });
  }
}
