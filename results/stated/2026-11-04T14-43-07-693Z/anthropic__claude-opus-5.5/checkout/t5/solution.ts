// checkout: charge an order exactly once per "Pay attempt", safely across
// retries, crashes, concurrent requests and multiple instances.
//
// Design
// ------
// - `checkout:<orderId>` holds the attempt state in the Db:
//     { attempt: number; state: "charging" | "declined" | "paid"; chargeId?: string }
// - Each attempt uses the PayCo idempotency key `checkout:<orderId>:<attempt>`.
//   * A retry of an unfinished attempt (crash, timeout, concurrent press) reuses
//     the same key, so PayCo never charges twice for it. It either processes the
//     charge now or returns the result it already recorded.
//   * After a decline, a new press bumps the attempt number atomically. That
//     gives a fresh key, so the customer's updated card is actually tried.
//     Reusing the old key would just replay the cached decline.
// - Final results are written to the order and the attempt record in one
//   transaction. A stale attempt can never overwrite a newer outcome or a "paid"
//   order.

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface AttemptRecord {
  attempt: number;
  state: "charging" | "declined" | "paid";
  chargeId?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const { db, payco } = ctx;
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:${orderId}`;

  const order = await db.get<Order>(orderKey);
  if (!order) {
    const err: any = new Error(`Order ${orderId} not found`);
    err.code = "order_not_found";
    throw err;
  }
  if (order.status === "paid") return "paid";

  // Atomically claim or continue an attempt.
  const rec = await db.update<AttemptRecord>(attemptKey, (cur) => {
    if (!cur) return { attempt: 1, state: "charging" };
    if (cur.state === "declined") return { attempt: cur.attempt + 1, state: "charging" };
    return cur; // "charging" (resume same key) or "paid"
  });

  if (rec.state === "paid") {
    // Defensive: make sure the order reflects it.
    await db.update<Order>(orderKey, (o) => (o ? { ...o, status: "paid" } : (o as any)));
    return "paid";
  }

  const attempt = rec.attempt;
  const idempotencyKey = `checkout:${orderId}:${attempt}`;

  // Charge, retrying timeouts in-process with the same key (always safe).
  // If it still times out, throw. The caller's retry resumes the same attempt
  // and therefore the same key.
  let charge: Charge | undefined;
  let declined = false;
  const maxTries = 3;
  for (let i = 0; i < maxTries; i++) {
    try {
      charge = await payco.createCharge({
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId, attempt: String(attempt) },
        idempotencyKey,
      });
      break;
    } catch (e: any) {
      if (e?.code === "card_declined") {
        declined = true;
        break;
      }
      if (e?.code === "timeout" && i < maxTries - 1) {
        await sleep(200 * (i + 1));
        continue;
      }
      // timeout after retries, idempotency_mismatch (e.g. order amount changed
      // mid-attempt), or an unknown error: surface it. State stays "charging",
      // so a retry reuses the same key and stays safe.
      throw e;
    }
  }

  if (charge) {
    const chargeId = charge.id;
    await db.transaction((tx) => {
      const o = tx.get<Order>(orderKey);
      if (o) tx.set<Order>(orderKey, { ...o, status: "paid" });
      const cur = tx.get<AttemptRecord>(attemptKey);
      // Money moved: always record it as paid, whatever attempt is current.
      tx.set<AttemptRecord>(attemptKey, {
        attempt: Math.max(cur?.attempt ?? attempt, attempt),
        state: "paid",
        chargeId,
      });
    });
    return "paid";
  }

  if (declined) {
    const result = await db.transaction((tx): "paid" | "declined" => {
      const o = tx.get<Order>(orderKey);
      const cur = tx.get<AttemptRecord>(attemptKey);
      if (o?.status === "paid" || cur?.state === "paid") return "paid";
      // Only finalize if this is still the current attempt. Otherwise a newer
      // attempt owns the outcome.
      if (cur && cur.attempt === attempt && cur.state === "charging") {
        tx.set<AttemptRecord>(attemptKey, { attempt, state: "declined" });
        if (o) tx.set<Order>(orderKey, { ...o, status: "declined" });
      }
      return "declined";
    });
    return result;
  }

  // Unreachable: the loop either sets charge/declined or throws.
  throw Object.assign(new Error("checkout: unexpected state"), { code: "internal" });
}
