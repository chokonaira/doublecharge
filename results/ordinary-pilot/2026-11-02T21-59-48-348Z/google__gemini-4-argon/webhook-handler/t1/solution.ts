// Declare runtime-provided interfaces locally for TypeScript compilation
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
  credited: number;
  refunded: number;
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

  // Always fetch the authoritative latest state of the charge from PayCo.
  // This prevents processing forged webhooks, eliminates race conditions from
  // out-of-order webhook deliveries, and allows skipping shipment if a charge
  // was already fully refunded before `charge.succeeded` was processed.
  let charge: Charge;
  try {
    charge = await ctx.payco.getCharge(eventCharge.id);
  } catch (err: any) {
    // If fetching fails because the charge doesn't exist at PayCo (e.g. unauthentic event),
    // ignore it rather than retrying forever. Re-throw transient errors like timeouts.
    if (err && (err.code === "not_found" || err.code === "resource_missing" || err.status === 404)) {
      return;
    }
    throw err;
  }

  const orderId = charge.metadata?.orderId;
  if (!orderId) {
    return;
  }

  const stateKey = `charge_state:${charge.id}`;
  const orderKey = `order:${orderId}`;

  // Atomically reconcile our database state with the latest charge state from PayCo.
  // By tracking how much has already been credited and refunded per charge, out-of-order
  // and concurrent duplicate deliveries become naturally idempotent.
  const txResult = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      return { foundOrder: false, needsShip: false, alreadyShipped: false };
    }

    const state: ChargeState = tx.get<ChargeState>(stateKey) ?? {
      credited: 0,
      refunded: 0,
      shipped: false,
    };

    const targetCredited = charge.status === "succeeded" ? charge.amount : 0;
    const targetRefunded = Math.max(state.refunded, charge.amountRefunded);

    const creditDiff = targetCredited - state.credited;
    const refundDiff = targetRefunded - state.refunded;
    const netBalanceDelta = creditDiff - refundDiff;

    if (netBalanceDelta !== 0) {
      const balanceKey = `balance:${order.sellerId}`;
      const currentBalance = tx.get<number>(balanceKey) ?? 0;
      tx.set(balanceKey, currentBalance + netBalanceDelta);
    }

    const isFullyRefunded = targetRefunded >= charge.amount && charge.amount > 0;
    const targetOrderStatus: Order["status"] = isFullyRefunded
      ? "refunded"
      : targetCredited > 0
      ? "paid"
      : order.status;

    if (order.status !== targetOrderStatus) {
      tx.set(orderKey, { ...order, status: targetOrderStatus });
    }

    if (state.credited !== targetCredited || state.refunded !== targetRefunded) {
      tx.set(stateKey, {
        credited: targetCredited,
        refunded: targetRefunded,
        shipped: state.shipped,
      });
    }

    // Do not ship an order whose charge has been fully refunded.
    const needsShip = targetCredited > 0 && !isFullyRefunded && !state.shipped;

    return {
      foundOrder: true,
      needsShip,
      alreadyShipped: state.shipped,
    };
  });

  if (!txResult.foundOrder) {
    return;
  }

  // Note on shipping vs full refund:
  // If `charge.succeeded` is processed before a refund happens at PayCo, the order is
  // legitimately shipped then. If the charge was already fully refunded by the time we
  // inspect it (e.g. out-of-order delivery or immediate refund), `needsShip` is false
  // and we never ship it.
  if (txResult.needsShip && !txResult.alreadyShipped) {
    await ctx.shipping.ship(orderId, { idempotencyKey: `ship:${orderId}` });

    await ctx.db.update<ChargeState>(stateKey, (current) => {
      const base = current ?? {
        credited: charge.amount,
        refunded: charge.amountRefunded,
        shipped: true,
      };
      return { ...base, shipped: true };
    });
  }
}
