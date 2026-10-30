// Checkout for the "Pay" button.
//
// Design:
// - Each payment attempt for an order gets a deterministic PayCo idempotency key:
//   `checkout:<orderId>:<attempt>`. The attempt counter lives in the Db
//   (`checkout:<orderId>`), so it survives crashes and is shared by all instances.
// - Retries, concurrent clicks and crash recovery reuse the same attempt, so the
//   same key goes to PayCo. PayCo then returns the original charge instead of
//   charging again. This prevents double charges.
// - The attempt counter only advances after a definitive `card_declined`. That
//   charge certainly did not happen, so a fresh key is safe. Without the new key,
//   PayCo would replay the old decline forever, even after the customer updates
//   their card.
// - The order status and the counter change in one transaction. A stale
//   concurrent request can never overwrite "paid" or bump the counter twice.
// - On a timeout we retry with the same key a few times (always safe per PayCo).
//   If it keeps timing out, we throw. The order stays at the same attempt, so
//   the caller's retry resumes safely.
//
// Limitation: if a decline is recorded but the response is lost, the caller's
// automatic retry starts a new attempt. This can cause one more charge attempt
// on the card. It can never double-charge, because the previous attempt
// definitively created no charge.

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
  chargeId?: string;
}

interface CheckoutState {
  attempt: number;
}

const MAX_TIMEOUT_RETRIES = 3;

function errCode(e: unknown): string | undefined {
  return e && typeof e === "object" && typeof (e as any).code === "string"
    ? (e as any).code
    : undefined;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const { db, payco } = ctx;
  const orderKey = `order:${orderId}`;
  const stateKey = `checkout:${orderId}`;

  const order = await db.get<Order>(orderKey);
  if (!order) {
    throw Object.assign(new Error(`Order ${orderId} not found`), { code: "order_not_found" });
  }
  if (order.status === "paid") return "paid";

  const state = (await db.get<CheckoutState>(stateKey)) ?? { attempt: 0 };
  const attempt = state.attempt;
  const idempotencyKey = `checkout:${orderId}:${attempt}`;

  let charge: Charge | undefined;
  let declined = false;
  for (let i = 0; ; i++) {
    try {
      charge = await payco.createCharge({
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId, attempt: String(attempt) },
        idempotencyKey,
      });
      break;
    } catch (e) {
      const code = errCode(e);
      if (code === "card_declined") {
        declined = true;
        break;
      }
      if (code === "timeout" && i < MAX_TIMEOUT_RETRIES) continue;
      // timeout (exhausted), idempotency_mismatch, or unknown: leave state
      // untouched so a later retry reuses the same key safely.
      throw e;
    }
  }

  if (charge) {
    const chargeId = charge.id;
    await db.transaction((tx) => {
      const cur = tx.get<Order>(orderKey);
      if (!cur) return;
      if (cur.status !== "paid") {
        tx.set<Order>(orderKey, { ...cur, status: "paid", chargeId });
      }
    });
    return "paid";
  }

  // Definitive decline for this attempt.
  const result = await db.transaction((tx) => {
    const cur = tx.get<Order>(orderKey);
    if (!cur) return "declined" as const;
    if (cur.status === "paid") return "paid" as const; // another attempt succeeded
    const st = tx.get<CheckoutState>(stateKey) ?? { attempt: 0 };
    if (st.attempt === attempt) {
      // First to record this attempt's decline: advance so the next Pay
      // press uses a fresh idempotency key.
      tx.set<CheckoutState>(stateKey, { attempt: attempt + 1 });
      tx.set<Order>(orderKey, { ...cur, status: "declined" });
    }
    // If st.attempt moved on, a newer attempt is in charge of the status.
    return "declined" as const;
  });
  return result;
}
