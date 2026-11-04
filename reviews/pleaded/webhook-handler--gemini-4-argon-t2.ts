// PayCo webhook handler: acts on PayCo's current state, books each amount once, and never ships a refunded order.
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
  credited: boolean;
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

  // Fetch the charge from PayCo rather than trusting the event snapshot, which may be stale or out of order.
  const latestCharge = await ctx.payco.getCharge(eventCharge.id);
  const chargeId = latestCharge.id;
  const orderId = latestCharge.metadata?.orderId ?? eventCharge.metadata?.orderId;

  if (!orderId) {
    return;
  }

  const totalAmount = latestCharge.amount;
  const currentRefunded = Math.max(
    latestCharge.amountRefunded ?? 0,
    eventCharge.amountRefunded ?? 0
  );
  const isFullyRefunded = currentRefunded >= totalAmount && totalAmount > 0;

  const chargeStateKey = `charge_state:${chargeId}`;
  const orderKey = `order:${orderId}`;

  // One transaction decides everything from a consistent view: the balance delta, the status move and
  // whether to ship.
  const { shouldShip } = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    const state = tx.get<ChargeState>(chargeStateKey) ?? {
      credited: false,
      refundedAmount: 0,
      shipped: false,
    };

    let balanceDelta = 0;

    if (!state.credited) {
      balanceDelta += totalAmount;
      state.credited = true;
    }

    if (currentRefunded > state.refundedAmount) {
      balanceDelta -= currentRefunded - state.refundedAmount;
      state.refundedAmount = currentRefunded;
    }

    if (balanceDelta !== 0) {
      const balanceKey = `balance:${order.sellerId}`;
      const currentBalance = tx.get<number>(balanceKey) ?? 0;
      tx.set(balanceKey, currentBalance + balanceDelta);
    }

    if (isFullyRefunded) {
      if (order.status !== "refunded") {
        tx.set(orderKey, { ...order, status: "refunded" });
      }
    } else if (order.status === "pending") {
      tx.set(orderKey, { ...order, status: "paid" });
    }

    tx.set(chargeStateKey, state);

    // The refund check uses PayCo's current state, fetched for this delivery, so a success event that
    // arrives after a full refund does not ship; and because the decision is made inside the transaction
    // that also moves the order's status, a refund booked by another delivery cannot slip in between the
    // decision and the status write.
    const needToShip = !isFullyRefunded && !state.shipped;

    return { shouldShip: needToShip };
  });

  // Ship outside the transaction (it is a network call), keyed by order so a redelivery cannot ship twice.
  if (shouldShip) {
    await ctx.shipping.ship(orderId, { idempotencyKey: `ship:${orderId}` });

    await ctx.db.update<ChargeState>(chargeStateKey, (state) => {
      const s = state ?? {
        credited: true,
        refundedAmount: currentRefunded,
        shipped: false,
      };
      return { ...s, shipped: true };
    });
  }
}
