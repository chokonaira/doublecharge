// Local type declarations (provided by runtime; declared here for clarity only).
interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface CheckoutState {
  attempt: number;   // current attempt number; the idempotency key derives from it
  chargeId?: string; // set once paid
}

function errCode(e: unknown): string | undefined {
  return e && typeof e === "object" && typeof (e as any).code === "string"
    ? (e as any).code
    : undefined;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const { db, payco } = ctx;
  const orderKey = `order:${orderId}`;
  const stateKey = `checkout:${orderId}`;

  // Read the order and the current attempt number together.
  const { order, state } = await db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) return { order: undefined, state: undefined };
    let state = tx.get<CheckoutState>(stateKey);
    if (!state) {
      state = { attempt: 1 };
      tx.set(stateKey, state);
    }
    return { order, state };
  });

  if (!order) {
    const e = new Error(`order ${orderId} not found`);
    (e as any).code = "order_not_found";
    throw e;
  }
  if (order.status === "paid") return "paid";

  const attempt = state!.attempt;
  const idempotencyKey = `checkout:${orderId}:${attempt}`;

  let charge: Charge;
  try {
    charge = await payco.createCharge({
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      // Metadata lets the reconciliation job match charges to orders.
      metadata: { orderId, attempt: String(attempt) },
      idempotencyKey,
    });
  } catch (e) {
    if (errCode(e) === "card_declined") {
      // Record the decline and open a new attempt. This happens only if no
      // concurrent request has already done so, and only if the order is not
      // already paid. A decline is definitive, so starting a new attempt
      // cannot lead to a double charge.
      const result = await db.transaction((tx): "paid" | "declined" => {
        const cur = tx.get<Order>(orderKey);
        if (cur?.status === "paid") return "paid";
        const st = tx.get<CheckoutState>(stateKey) ?? { attempt };
        if (st.attempt === attempt) {
          tx.set<CheckoutState>(stateKey, { attempt: attempt + 1 });
        }
        if (cur) tx.set<Order>(orderKey, { ...cur, status: "declined" });
        return "declined";
      });
      return result;
    }
    // timeout: the charge state is unknown. Throw so the customer retries.
    // The retry reuses the same idempotency key, which is safe.
    // idempotency_mismatch or other errors: rethrow and let the app show
    // "try again". The reconciliation job handles anything left stuck.
    throw e;
  }

  // Charge succeeded: mark the order paid. If we crash before this write,
  // a retry gets the same charge back from PayCo and lands here again.
  await db.transaction((tx) => {
    const cur = tx.get<Order>(orderKey);
    if (cur) tx.set<Order>(orderKey, { ...cur, status: "paid" });
    const st = tx.get<CheckoutState>(stateKey) ?? { attempt };
    tx.set<CheckoutState>(stateKey, { ...st, chargeId: charge.id });
  });
  return "paid";
}
