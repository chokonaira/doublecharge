// Checkout with crash-safe, retry-safe, concurrency-safe charging.
//
// Approach:
// - Each payment *attempt* for an order gets a stable PayCo idempotency key:
//   `checkout:<orderId>:<attemptNo>`. The attempt record lives in the Db at
//   `checkout:<orderId>` and is advanced atomically.
// - A retry after a crash or timeout reuses the in-flight attempt's key. PayCo
//   then either processes the charge now or returns the recorded result. We
//   never charge twice for one attempt.
// - Concurrent presses of Pay share the same in-flight attempt, and so the same key.
// - After a decline, the next press starts a new attempt with a new key. That way
//   the customer's updated card is actually tried, rather than PayCo replaying
//   the cached decline.
// - The charge parameters are frozen in the attempt record. A retry therefore
//   always sends identical parameters, which avoids idempotency_mismatch.
// - The final outcome (order status + attempt state) is written in a single
//   transaction, so the two can never disagree.

interface OrderRec {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface AttemptRec {
  attempt: number;
  state: "inflight" | "declined" | "paid";
  amount: number;
  currency: string;
  customerId: string;
  chargeId?: string;
}

function codeOf(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const { db, payco } = ctx;
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:${orderId}`;

  const order = await db.get<OrderRec>(orderKey);
  if (!order) {
    throw Object.assign(new Error(`order ${orderId} not found`), { code: "not_found" });
  }
  if (order.status === "paid") return "paid";

  // Atomically pick the attempt to run: reuse an in-flight one, or start a new one.
  const rec = await db.update<AttemptRec>(attemptKey, (cur) => {
    if (!cur) {
      return {
        attempt: 1,
        state: "inflight",
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
      };
    }
    if (cur.state === "declined") {
      return {
        attempt: cur.attempt + 1,
        state: "inflight",
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
      };
    }
    // An "inflight" attempt is reused (retry or concurrent request).
    // A "paid" attempt is returned unchanged.
    return cur;
  });

  if (rec.state === "paid") {
    // Repair the order if needed (normally already done in the same transaction).
    await db.update<OrderRec>(orderKey, (cur) => {
      if (!cur) throw new Error("order vanished");
      return { ...cur, status: "paid" };
    });
    return "paid";
  }

  const idempotencyKey = `checkout:${orderId}:${rec.attempt}`;

  let charge: Charge;
  try {
    charge = await payco.createCharge({
      amount: rec.amount,
      currency: rec.currency,
      customerId: rec.customerId,
      metadata: { orderId, attempt: String(rec.attempt) },
      idempotencyKey,
    });
  } catch (err) {
    if (codeOf(err) === "card_declined") {
      // No charge was created. Close this attempt so the next Pay uses a fresh key.
      const result = db.transaction((tx) => {
        const a = tx.get<AttemptRec>(attemptKey);
        const o = tx.get<OrderRec>(orderKey);
        if (!a || !o) throw new Error("records vanished");
        // A concurrent request may already have settled this attempt.
        // Only flip the state if the attempt is still ours and still in flight.
        if (a.attempt === rec.attempt && a.state === "inflight") {
          tx.set<AttemptRec>(attemptKey, { ...a, state: "declined" });
          if (o.status !== "paid") tx.set<OrderRec>(orderKey, { ...o, status: "declined" });
          return "declined" as const;
        }
        return o.status === "paid" ? ("paid" as const) : ("declined" as const);
      });
      return await result;
    }
    // timeout, idempotency_mismatch, or anything else: leave the attempt in flight
    // and throw. A retry reuses the same key, so PayCo either processes the charge
    // now or replays the recorded result. No double charge is possible.
    throw err;
  }

  if (charge.amount !== rec.amount || charge.currency !== rec.currency) {
    // Should never happen given idempotency semantics. Fail loudly instead of
    // marking the order paid for the wrong amount.
    throw Object.assign(new Error("charge does not match order"), { code: "charge_mismatch" });
  }

  await db.transaction((tx) => {
    const a = tx.get<AttemptRec>(attemptKey);
    const o = tx.get<OrderRec>(orderKey);
    if (!a || !o) throw new Error("records vanished");
    tx.set<AttemptRec>(attemptKey, { ...a, state: "paid", chargeId: charge.id });
    tx.set<OrderRec>(orderKey, { ...o, status: "paid" });
  });
  return "paid";
}
