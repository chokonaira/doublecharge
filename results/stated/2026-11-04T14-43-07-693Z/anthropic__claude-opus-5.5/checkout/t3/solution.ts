// Types Ctx, Db, Tx, PayCo, Charge are provided by the runtime.

type OrderStatus = "pending" | "paid" | "declined";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: OrderStatus;
  [k: string]: unknown;
}

interface CheckoutState {
  attempt: number;      // current charge attempt; part of the PayCo idempotency key
  chargeId?: string;    // set once a charge succeeded
}

function stateKey(orderId: string) {
  return `checkout:${orderId}`;
}

function idemKey(orderId: string, attempt: number) {
  return `checkout:${orderId}:attempt:${attempt}`;
}

/*
 * Design
 * ------
 * - Each order has a durable attempt counter in the Db. The PayCo
 *   idempotency key is derived from (orderId, attempt).
 * - Retries after a crash, timeout or any error reuse the same key. PayCo then
 *   either performs the charge once or returns the result it recorded, so
 *   there is no double charge, even across instances or concurrent clicks.
 * - The counter only advances after a definite `card_declined` for the
 *   current attempt. PayCo guarantees that no charge exists in that case. A
 *   fresh key is required there, because PayCo would otherwise replay the
 *   cached decline after the customer updates their card.
 * - Advancing happens in a transaction that checks the attempt is still the
 *   one we used. A stale or concurrent request therefore cannot advance it
 *   twice, and it cannot overwrite a "paid" order with "declined".
 * - A successful charge always wins: we mark the order paid, because the
 *   money was taken.
 * - Ambiguous failures (timeout, unknown errors) are rethrown. The customer
 *   or caller retries with the same key, and the reconciliation job handles
 *   customers who never return.
 */
export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const { db, payco } = ctx;

  const order = await db.get<Order>(`order:${orderId}`);
  if (!order) {
    const err = new Error(`order ${orderId} not found`) as Error & { code: string };
    err.code = "order_not_found";
    throw err;
  }
  if (order.status === "paid") return "paid";

  // Ensure the attempt state exists (atomic; concurrent callers converge).
  await db.insertIfAbsent<CheckoutState>(stateKey(orderId), { attempt: 1 });
  const state = await db.get<CheckoutState>(stateKey(orderId));
  if (!state) throw new Error("checkout state missing");
  if (state.chargeId) {
    // A charge already succeeded. Make sure the order reflects it.
    await markPaid(db, orderId, state.chargeId);
    return "paid";
  }

  const attempt = state.attempt;

  let charge: Charge;
  try {
    charge = await payco.createCharge({
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      metadata: { orderId, attempt: String(attempt) },
      idempotencyKey: idemKey(orderId, attempt),
    });
  } catch (e: any) {
    if (e && e.code === "card_declined") {
      // Definite: no charge exists for this attempt. Record the decline and
      // advance the attempt so the next Pay press uses a fresh key. This is
      // only done if nobody else has advanced it or completed payment yet.
      const result = await db.transaction<OrderStatus>((tx: Tx) => {
        const o = tx.get<Order>(`order:${orderId}`);
        const s = tx.get<CheckoutState>(stateKey(orderId));
        if (!o || !s) throw new Error("checkout state missing");
        if (o.status === "paid" || s.chargeId) return "paid";
        if (s.attempt === attempt) {
          tx.set<CheckoutState>(stateKey(orderId), { ...s, attempt: attempt + 1 });
          tx.set<Order>(`order:${orderId}`, { ...o, status: "declined" });
        }
        // If the attempt already advanced, another request recorded this
        // decline. Report the decline for the attempt we performed.
        return "declined";
      });
      return result === "paid" ? "paid" : "declined";
    }
    // timeout / idempotency_mismatch / unknown: outcome unknown or
    // unrecoverable here. Rethrow; a retry reuses the same idempotency key
    // and is safe.
    throw e;
  }

  await markPaid(db, orderId, charge.id);
  return "paid";
}

async function markPaid(db: Db, orderId: string, chargeId: string): Promise<void> {
  await db.transaction<void>((tx: Tx) => {
    const o = tx.get<Order>(`order:${orderId}`);
    const s = tx.get<CheckoutState>(stateKey(orderId));
    if (!o) throw new Error(`order ${orderId} not found`);
    tx.set<CheckoutState>(stateKey(orderId), { attempt: s?.attempt ?? 1, ...s, chargeId });
    if (o.status !== "paid") {
      tx.set<Order>(`order:${orderId}`, { ...o, status: "paid" });
    }
  });
}
