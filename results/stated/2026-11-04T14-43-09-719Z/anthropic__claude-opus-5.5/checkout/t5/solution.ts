import { randomUUID } from "node:crypto";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface Attempt {
  n: number;
  key: string;
  state: "inflight" | "declined" | "paid";
  // Parameters frozen when the attempt was created, so a retry of the same key
  // sends identical parameters (avoids idempotency_mismatch).
  amount: number;
  currency: string;
  customerId: string;
  chargeId?: string;
}

function codeOf(e: unknown): string | undefined {
  return e && typeof e === "object" && typeof (e as any).code === "string" ? (e as any).code : undefined;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const { db, payco } = ctx;
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:${orderId}`;

  // Step 1: atomically decide which charge attempt (idempotency key) this request uses.
  // - in-flight attempt (crash/timeout/concurrent click): reuse its key, so we never double charge.
  // - no attempt, or last attempt declined: start a new attempt with a fresh key, so the
  //   customer's (possibly updated) card is actually tried again.
  const decision = await db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) throw Object.assign(new Error(`order ${orderId} not found`), { code: "not_found" });
    if (order.status === "paid") return { kind: "paid" as const };
    const cur = tx.get<Attempt>(attemptKey);
    if (cur && cur.state === "paid") {
      // Charge succeeded but the order write was lost; repair it.
      tx.set<Order>(orderKey, { ...order, status: "paid" });
      return { kind: "paid" as const };
    }
    if (cur && cur.state === "inflight") return { kind: "charge" as const, attempt: cur };
    const next: Attempt = {
      n: cur ? cur.n + 1 : 1,
      key: `checkout:${orderId}:${cur ? cur.n + 1 : 1}:${randomUUID()}`,
      state: "inflight",
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
    };
    tx.set<Attempt>(attemptKey, next);
    return { kind: "charge" as const, attempt: next };
  });

  if (decision.kind === "paid") return "paid";
  const attempt = decision.attempt;

  // Step 2: charge with the attempt's key. Retrying a timed-out request with the same key
  // is always safe. If it keeps timing out we throw; the caller's retry reuses the key.
  let outcome: { ok: true; chargeId: string } | { ok: false } | undefined;
  for (let i = 0; i < 3 && !outcome; i++) {
    try {
      const charge = await payco.createCharge({
        amount: attempt.amount,
        currency: attempt.currency,
        customerId: attempt.customerId,
        metadata: { orderId, attempt: String(attempt.n) },
        idempotencyKey: attempt.key,
      });
      outcome = { ok: true, chargeId: charge.id };
    } catch (e) {
      const code = codeOf(e);
      if (code === "card_declined") outcome = { ok: false };
      else if (code === "timeout") continue;
      else throw e;
    }
  }
  if (!outcome) {
    throw Object.assign(new Error("payment provider timed out"), { code: "timeout" });
  }

  // Step 3: record the result atomically.
  const result = outcome;
  return db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    const cur = tx.get<Attempt>(attemptKey);
    const sameAttempt = cur && cur.n === attempt.n;

    if (result.ok) {
      if (sameAttempt) tx.set<Attempt>(attemptKey, { ...cur!, state: "paid", chargeId: result.chargeId });
      if (order && order.status !== "paid") tx.set<Order>(orderKey, { ...order, status: "paid" });
      return "paid" as const;
    }

    // Declined. If the order is already paid (we read it as paid), the truth for the customer is "paid".
    if (order && order.status === "paid") return "paid" as const;
    if (cur && cur.state === "paid") {
      if (order) tx.set<Order>(orderKey, { ...order, status: "paid" });
      return "paid" as const;
    }
    if (sameAttempt && cur!.state === "inflight") {
      tx.set<Attempt>(attemptKey, { ...cur!, state: "declined" });
    }
    // A later attempt can only start after this attempt was recorded declined, so the
    // customer was not charged through this order's attempts before this request started.
    if (order && order.status !== "declined") tx.set<Order>(orderKey, { ...order, status: "declined" });
    return "declined" as const;
  });
}
