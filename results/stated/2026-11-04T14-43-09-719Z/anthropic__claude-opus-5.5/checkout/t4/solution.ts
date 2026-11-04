// checkout.ts
//
// Design
// ------
// Each order gets a record `checkout:<orderId>` = { attempt, declined }.
// The PayCo idempotency key for a charge is `checkout:<orderId>:<attempt>`.
//
// - The attempt number only moves forward when we *know* the current
//   attempt's key holds a decline (PayCo returned card_declined for it).
//   So a key that may have produced a charge (success, or a lost/timed-out
//   request) is never abandoned. Any retry, on any instance, after any crash,
//   reuses that key. PayCo then either returns the existing charge or
//   processes the request exactly once. The customer is never charged twice
//   and is never charged before we notice.
// - After a decline, pressing Pay again advances to a fresh key. A fresh
//   charge is needed because the customer may have updated their saved card,
//   and reusing the old key would only replay the cached decline. Every
//   earlier key is known to be declined, so the customer had not been charged
//   before this request.
// - The decline is recorded atomically with the order status, in one
//   transaction, *before* we return "declined". So once a customer has been
//   told about a decline, every later request sees it and starts a new attempt
//   instead of repeating the old decline.
// - The decline transaction re-reads the order. If it is already "paid", we
//   return "paid" (true: a charge exists) rather than "declined".

interface OrderRec {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface CheckoutRec {
  attempt: number;
  declined: boolean;
}

const MAX_TIMEOUT_RETRIES = 3;

function errCode(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const { db, payco } = ctx;
  const orderKey = `order:${orderId}`;
  const ckKey = `checkout:${orderId}`;

  // Read the order, make sure an attempt record exists, and advance the attempt
  // if the current one is known to be declined. All of this happens atomically.
  const prep = await db.transaction((tx) => {
    const order = tx.get<OrderRec>(orderKey);
    if (!order) return { kind: "missing" as const };
    if (order.status === "paid") return { kind: "paid" as const };
    let ck = tx.get<CheckoutRec>(ckKey);
    if (!ck) {
      ck = { attempt: 0, declined: false };
      tx.set(ckKey, ck);
    } else if (ck.declined) {
      // The previous key is known to hold a decline and no charge.
      // Start a fresh attempt so an updated card can be charged.
      ck = { attempt: ck.attempt + 1, declined: false };
      tx.set(ckKey, ck);
      if (order.status === "declined") tx.set(orderKey, { ...order, status: "pending" });
    }
    return { kind: "charge" as const, order, attempt: ck.attempt };
  });

  if (prep.kind === "missing") {
    throw Object.assign(new Error(`order ${orderId} not found`), { code: "not_found" });
  }
  if (prep.kind === "paid") return "paid";

  const { order, attempt } = prep;
  const idempotencyKey = `checkout:${orderId}:${attempt}`;

  // Charge. On timeout, retry with the same key, which is always safe.
  // If the request is still lost after a few tries, throw. The key stays
  // current, so the customer's retry resolves it exactly once.
  let declined = false;
  for (let i = 0; ; i++) {
    try {
      await payco.createCharge({
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId },
        idempotencyKey,
      });
      break;
    } catch (e) {
      const code = errCode(e);
      if (code === "card_declined") {
        declined = true;
        break;
      }
      if (code === "timeout" && i < MAX_TIMEOUT_RETRIES) {
        await sleep(200 * (i + 1));
        continue;
      }
      throw e; // timeout exhausted, idempotency_mismatch, or unknown error
    }
  }

  if (!declined) {
    // The customer has been charged (or PayCo returned the earlier charge for this key).
    await db.update<OrderRec>(orderKey, (cur) => {
      if (!cur) throw new Error(`order ${orderId} vanished`);
      return cur.status === "paid" ? cur : { ...cur, status: "paid" };
    });
    return "paid";
  }

  // Declined: record it for this attempt and mark the order, atomically.
  const result = await db.transaction((tx) => {
    const cur = tx.get<OrderRec>(orderKey);
    if (!cur) throw new Error(`order ${orderId} vanished`);
    if (cur.status === "paid") return "paid" as const; // a charge exists; "paid" is true
    const ck = tx.get<CheckoutRec>(ckKey);
    if (ck && ck.attempt === attempt && !ck.declined) {
      tx.set(ckKey, { attempt, declined: true });
    }
    if (cur.status !== "declined") tx.set(orderKey, { ...cur, status: "declined" });
    return "declined" as const;
  });
  return result;
}
