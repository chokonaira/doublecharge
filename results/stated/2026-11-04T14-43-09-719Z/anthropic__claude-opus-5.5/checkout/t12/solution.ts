// checkout: charges an order's customer exactly once per payment attempt.
//
// Design
// - `checkout:<orderId>` stores the current attempt number `n` and its outcome.
//   The PayCo idempotency key is `checkout:<orderId>:<n>`.
// - A crash or timeout leaves no outcome. The next request reuses the same key,
//   so PayCo either performs the charge once or replays the result it recorded.
//   This prevents double charges.
// - The attempt number increases only after PayCo has definitively declined the
//   current key and that decline is recorded. So every earlier key is a known
//   decline, and only the current key can ever have charged the customer.
//   When the customer updates their card and presses Pay again, the request
//   sees the recorded decline and moves to a fresh key. A stale cached decline
//   is therefore never replayed to a customer who was already told about it.
// - The increase uses an atomic update keyed on the attempt number that was
//   read. Concurrent requests therefore agree on a single new attempt.
// - Results are written in one transaction covering the order and the attempt
//   record. A decline never overwrites "paid", and a request that reads the
//   order as paid returns "paid".
// - If PayCo keeps timing out, we throw. The caller's retry reuses the same key.

interface OrderRec {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface AttemptRec {
  n: number;
  outcome?: "paid" | "declined";
  chargeId?: string;
}

function errCode(e: unknown): string | undefined {
  return e && typeof e === "object" && typeof (e as any).code === "string"
    ? (e as any).code
    : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const { db, payco } = ctx;
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:${orderId}`;

  const order = await db.get<OrderRec>(orderKey);
  if (!order) {
    throw Object.assign(new Error(`order ${orderId} not found`), { code: "not_found" });
  }
  if (order.status === "paid") return "paid";

  await db.insertIfAbsent<AttemptRec>(attemptKey, { n: 0 });
  let attempt = await db.get<AttemptRec>(attemptKey);
  if (!attempt) throw new Error("attempt record missing");

  if (attempt.outcome === "paid") {
    // The charge succeeded, but marking the order may not have completed. Repair it.
    await db.update<OrderRec>(orderKey, (cur) => {
      if (!cur) throw new Error("order vanished");
      return { ...cur, status: "paid" };
    });
    return "paid";
  }

  if (attempt.outcome === "declined") {
    // The previous attempt was definitively declined, so start a fresh attempt.
    // The update is atomic, so concurrent requests converge on the same n+1.
    const seen = attempt.n;
    attempt = await db.update<AttemptRec>(attemptKey, (cur) => {
      if (!cur) return { n: seen + 1 };
      if (cur.n === seen && cur.outcome === "declined") return { n: seen + 1 };
      return cur; // Someone else already moved on, so use their attempt.
    });
    if (attempt.outcome === "paid") return "paid";
    // If attempt.outcome is "declined" here, another request already advanced
    // and was declined after we started. Its decline was recorded after we
    // read the attempt, but we must still make our own charge request before
    // reporting. Reusing its key replays that decline, which happened after
    // this request started, so reporting it is allowed.
  }

  const n = attempt.n;
  const idempotencyKey = `checkout:${orderId}:${n}`;

  let charge: Charge | undefined;
  let declined = false;
  const maxTries = 3;
  for (let i = 0; ; i++) {
    try {
      charge = await payco.createCharge({
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId, attempt: String(n) },
        idempotencyKey,
      });
      break;
    } catch (e) {
      const code = errCode(e);
      if (code === "card_declined") {
        declined = true;
        break;
      }
      if (code === "timeout" && i < maxTries - 1) {
        await sleep(200 * (i + 1));
        continue;
      }
      // Timeouts that persist, idempotency_mismatch and unknown errors all throw.
      // The outcome is unknown or unsafe, so the retry reuses the same key.
      throw e;
    }
  }

  if (charge && !declined) {
    const chargeId = charge.id;
    await db.transaction((tx) => {
      const o = tx.get<OrderRec>(orderKey);
      if (!o) throw new Error("order vanished");
      tx.set<OrderRec>(orderKey, { ...o, status: "paid" });
      const a = tx.get<AttemptRec>(attemptKey);
      if (a && a.n === n) tx.set<AttemptRec>(attemptKey, { n, outcome: "paid", chargeId });
    });
    return "paid";
  }

  // Our own most recent charge request was declined by PayCo.
  const result = await db.transaction((tx): "paid" | "declined" => {
    const o = tx.get<OrderRec>(orderKey);
    if (!o) throw new Error("order vanished");
    const a = tx.get<AttemptRec>(attemptKey);
    // A later attempt (new card) may already have paid. Never overwrite that.
    if (o.status === "paid" || a?.outcome === "paid") return "paid";
    if (a && a.n === n && !a.outcome) {
      tx.set<AttemptRec>(attemptKey, { n, outcome: "declined" });
    }
    tx.set<OrderRec>(orderKey, { ...o, status: "declined" });
    return "declined";
  });
  return result;
}
