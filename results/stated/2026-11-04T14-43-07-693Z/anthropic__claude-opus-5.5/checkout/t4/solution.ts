// Checkout with retry-safe, multi-instance-safe charging.
//
// Each order has a checkout record `checkout:<orderId>` that tracks the current
// payment *attempt*. Every attempt uses a deterministic PayCo idempotency key
// (`checkout:<orderId>:<attempt>`). Because the key is stored in the Db, any
// instance, any retry and any concurrent double click reuses it, so PayCo
// performs at most one charge per attempt.
//
// We only move to a new attempt (and a new key) once the current attempt is
// recorded as definitively declined. A decline is the only outcome where
// PayCo guarantees no charge was created. Timeouts and unknown errors keep
// the same attempt, so the retry replays the same key. That is always safe.
//
// The amount and currency are frozen into the attempt when it starts. A retry
// therefore sends identical parameters, even if the order changes meanwhile,
// so it never triggers idempotency_mismatch.

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface CheckoutState {
  attempt: number;
  declinedAttempt: number; // last attempt known to be declined (0 = none)
  customerId: string;
  amount: number;
  currency: string;
  chargeId?: string;
}

type Begin =
  | { kind: "paid" }
  | { kind: "charge"; state: CheckoutState };

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const checkoutKey = `checkout:${orderId}`;

  // 1. Atomically decide which attempt this request belongs to.
  const begin = await ctx.db.transaction<Begin>((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      const err = new Error(`Order ${orderId} not found`) as Error & { code: string };
      err.code = "order_not_found";
      throw err;
    }
    if (order.status === "paid") return { kind: "paid" };

    const cur = tx.get<CheckoutState>(checkoutKey);
    let state: CheckoutState;
    if (!cur) {
      state = {
        attempt: 1,
        declinedAttempt: 0,
        customerId: order.customerId,
        amount: order.amount,
        currency: order.currency,
      };
    } else if (cur.declinedAttempt === cur.attempt) {
      // The previous attempt was definitively declined, so no charge exists.
      // Start a fresh attempt with a fresh key. The customer may have
      // updated their card. Concurrent requests all see the same result
      // here because this runs in a transaction, so they share one attempt.
      state = {
        attempt: cur.attempt + 1,
        declinedAttempt: cur.declinedAttempt,
        customerId: order.customerId,
        amount: order.amount,
        currency: order.currency,
      };
    } else {
      // The current attempt is still open, or its outcome is unknown.
      // Reuse it unchanged so the retry replays the same idempotent request.
      return { kind: "charge", state: cur };
    }
    tx.set(checkoutKey, state);
    if (order.status !== "pending") tx.set(orderKey, { ...order, status: "pending" });
    return { kind: "charge", state };
  });

  if (begin.kind === "paid") return "paid";
  const { state } = begin;
  const attempt = state.attempt;

  // 2. Charge idempotently. Timeouts and unknown errors propagate.
  //    The attempt stays open, and the customer's retry, or the
  //    reconciliation job, replays the same key.
  let charge: Charge;
  try {
    charge = await ctx.payco.createCharge({
      amount: state.amount,
      currency: state.currency,
      customerId: state.customerId,
      metadata: { orderId, attempt: String(attempt) },
      idempotencyKey: `checkout:${orderId}:${attempt}`,
    });
  } catch (e) {
    if ((e as { code?: unknown })?.code === "card_declined") {
      // Definitive: no charge was created for this attempt.
      const result = await ctx.db.transaction<"paid" | "declined">((tx) => {
        const order = tx.get<Order>(orderKey);
        const cur = tx.get<CheckoutState>(checkoutKey);
        if (order?.status === "paid") return "paid";
        if (cur && cur.attempt === attempt && cur.declinedAttempt !== attempt) {
          tx.set(checkoutKey, { ...cur, declinedAttempt: attempt });
        }
        if (order && order.status !== "declined") tx.set(orderKey, { ...order, status: "declined" });
        return "declined";
      });
      return result;
    }
    throw e;
  }

  if (charge.status !== "succeeded") {
    const err = new Error(`Unexpected charge status ${String(charge.status)}`) as Error & { code: string };
    err.code = "unexpected_charge_status";
    throw err;
  }

  // 3. Record success. Paid always wins over any other status.
  await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    const cur = tx.get<CheckoutState>(checkoutKey);
    if (cur && cur.attempt === attempt) tx.set(checkoutKey, { ...cur, chargeId: charge.id });
    if (order && order.status !== "paid") tx.set(orderKey, { ...order, status: "paid" });
  });
  return "paid";
}
