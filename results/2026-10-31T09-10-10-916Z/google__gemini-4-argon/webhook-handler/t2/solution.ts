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

export async function handleWebhook(event: PayCoEvent, ctx: Ctx): Promise<void> {
  if (!event?.data?.charge?.id) {
    return;
  }

  // Always fetch the live authoritative state from PayCo.
  // This prevents processing spoofed webhooks and naturally resolves
  // out-of-order delivery (e.g., charge.refunded arriving before charge.succeeded)
  // and concurrent partial refund events.
  const liveCharge = await ctx.payco.getCharge(event.data.charge.id);
  if (!liveCharge || liveCharge.status !== "succeeded") {
    return;
  }

  const orderId = liveCharge.metadata?.orderId;
  if (!orderId) {
    return;
  }

  const orderKey = `order:${orderId}`;
  const stateKey = `charge_state:${liveCharge.id}`;

  const txResult = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      return { shouldShip: false };
    }

    const state = tx.get<ChargeState>(stateKey) ?? {
      creditedAmount: 0,
      refundedAmount: 0,
      shipped: false,
    };

    const targetCredited = liveCharge.amount;
    // Ensure refundedAmount only increases monotonically in case of read replica lag
    const targetRefunded = Math.max(state.refundedAmount, liveCharge.amountRefunded);

    const creditDiff = targetCredited - state.creditedAmount;
    const refundDiff = targetRefunded - state.refundedAmount;
    const netBalanceDelta = creditDiff - refundDiff;

    if (netBalanceDelta !== 0) {
      const balanceKey = `balance:${order.sellerId}`;
      const currentBalance = tx.get<number>(balanceKey) ?? 0;
      tx.set(balanceKey, currentBalance + netBalanceDelta);
    }

    const isFullyRefunded = targetRefunded >= targetCredited && targetCredited > 0;
    const desiredOrderStatus: Order["status"] = isFullyRefunded ? "refunded" : "paid";

    if (order.status !== desiredOrderStatus) {
      tx.set<Order>(orderKey, {
        ...order,
        status: desiredOrderStatus,
      });
    }

    if (state.creditedAmount !== targetCredited || state.refundedAmount !== targetRefunded) {
      tx.set<ChargeState>(stateKey, {
        creditedAmount: targetCredited,
        refundedAmount: targetRefunded,
        shipped: state.shipped,
      });
    }

    // Do not ship an order whose charge has been fully refunded.
    // Note: Because Shipping is an external non-transactional service, if a charge.succeeded
    // event is processed concurrently with a full refund at PayCo before the refund event arrives,
    // we check both the transaction snapshot and re-verify before calling shipping.
    const shouldShip = !isFullyRefunded && !state.shipped;

    return { shouldShip };
  });

  if (txResult.shouldShip) {
    // Re-check latest order status right before external call to minimize the race window
    // if a concurrent refund webhook finished just after our transaction.
    const currentOrder = await ctx.db.get<Order>(orderKey);
    if (currentOrder?.status === "refunded") {
      return;
    }

    // Ship is idempotent using orderId-based key. If this throws (e.g., timeout) or the process
    // crashes before updating `shipped: true`, PayCo's webhook retry will safely re-invoke `ship`
    // with the same idempotencyKey unless the order was fully refunded in the meantime.
    await ctx.shipping.ship(orderId, { idempotencyKey: `ship:${orderId}` });

    await ctx.db.update<ChargeState>(stateKey, (curr) => ({
      creditedAmount: curr?.creditedAmount ?? liveCharge.amount,
      refundedAmount: curr?.refundedAmount ?? liveCharge.amountRefunded,
      shipped: true,
    }));
  }
}
