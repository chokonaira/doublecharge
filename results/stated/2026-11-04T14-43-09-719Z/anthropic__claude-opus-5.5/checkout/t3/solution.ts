// checkout.ts
//
// Design
// ------
// Each checkout attempt has a record `checkout:<orderId>` = { attempt, state, chargeId? }.
// Every charge request goes to PayCo with the idempotency key `checkout:<orderId>:<attempt>`,
// so PayCo performs at most one charge per attempt.
//
// - Before charging, a Db transaction either reuses the current attempt or opens a new one.
//   It reuses the attempt if its state is "charging", meaning a previous or concurrent
//   request may have charged, or may still be charging. Retrying that key is always safe:
//   PayCo either processes it now or returns what it recorded.
//   It opens attempt+1 only when the current attempt is recorded as "declined". That is the
//   "customer updated their card and pressed Pay again" case. A declined attempt never
//   created a charge, so a new charge cannot double-charge.
// - Success: one transaction marks the attempt and the order "paid". If we crash before
//   that write, the attempt stays "charging". The next request reuses the same key, gets
//   the same succeeded charge back from PayCo, and reports "paid".
// - Decline: we record it only if the order is not paid. If the order is already paid, we
//   return "paid", because we must never say "declined" after reading the order as paid.
//   This also covers the case of a crash after PayCo stored a decline but before we wrote
//   it down. The retry reuses the key and gets that same, never-reported decline back.
//   Per the rules it may be reported once; the next Pay press then opens a fresh attempt.
// - A timeout is retried a few times with the same key. If it still times out, we throw and
//   the attempt stays "charging". We never guess the outcome.

interface OrderRec {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface CheckoutRec {
  attempt: number;
  state: "charging" | "declined" | "paid";
  chargeId?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function codeOf(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : undefined;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const { db, payco } = ctx;
  const orderKey = `order:${orderId}`;
  const ckKey = `checkout:${orderId}`;

  const order = await db.get<OrderRec>(orderKey);
  if (!order) {
    throw Object.assign(new Error(`order ${orderId} not found`), { code: "not_found" });
  }
  if (order.status === "paid") return "paid";

  // Atomically choose the attempt this request will use.
  const plan = await db.transaction((tx) => {
    const o = tx.get<OrderRec>(orderKey);
    if (!o) throw Object.assign(new Error(`order ${orderId} not found`), { code: "not_found" });
    if (o.status === "paid") return { paid: true as const };
    const cur = tx.get<CheckoutRec>(ckKey);
    if (cur && cur.state === "paid") return { paid: true as const };
    let attempt: number;
    if (!cur) {
      attempt = 1;
      tx.set<CheckoutRec>(ckKey, { attempt, state: "charging" });
    } else if (cur.state === "declined") {
      attempt = cur.attempt + 1;
      tx.set<CheckoutRec>(ckKey, { attempt, state: "charging" });
    } else {
      // "charging": reuse the same key. It is safe whatever happened before.
      attempt = cur.attempt;
    }
    return { paid: false as const, attempt, order: o };
  });

  if (plan.paid) return "paid";
  const { attempt, order: o } = plan;
  const idempotencyKey = `checkout:${orderId}:${attempt}`;

  let outcome: { kind: "succeeded"; chargeId: string } | { kind: "declined" };
  for (let i = 0; ; i++) {
    try {
      const charge = await payco.createCharge({
        amount: o.amount,
        currency: o.currency,
        customerId: o.customerId,
        metadata: { orderId, attempt: String(attempt) },
        idempotencyKey,
      });
      outcome = { kind: "succeeded", chargeId: charge.id };
      break;
    } catch (e) {
      const code = codeOf(e);
      if (code === "card_declined") {
        outcome = { kind: "declined" };
        break;
      }
      if (code === "timeout" && i < 2) {
        await sleep(500 * (i + 1));
        continue;
      }
      // A timeout that keeps happening, a mismatch, or an unknown error: the outcome is
      // unknown or unsafe to guess. Leave the attempt "charging" and let the caller retry.
      throw e;
    }
  }

  if (outcome.kind === "succeeded") {
    const chargeId = outcome.chargeId;
    await db.transaction((tx) => {
      const cur = tx.get<OrderRec>(orderKey);
      if (cur && cur.status !== "paid") tx.set<OrderRec>(orderKey, { ...cur, status: "paid" });
      const ck = tx.get<CheckoutRec>(ckKey);
      if (!ck || ck.attempt === attempt || ck.state !== "paid") {
        tx.set<CheckoutRec>(ckKey, { attempt, state: "paid", chargeId });
      }
    });
    return "paid";
  }

  // Declined. Record it unless the order turned out to be paid.
  const result = await db.transaction((tx) => {
    const cur = tx.get<OrderRec>(orderKey);
    if (cur && cur.status === "paid") return "paid" as const;
    const ck = tx.get<CheckoutRec>(ckKey);
    if (ck && ck.state === "paid") return "paid" as const;
    if (ck && ck.attempt === attempt && ck.state === "charging") {
      tx.set<CheckoutRec>(ckKey, { attempt, state: "declined" });
      if (cur) tx.set<OrderRec>(orderKey, { ...cur, status: "declined" });
    }
    // If a newer attempt has already started, leave its state alone. Our own decline was
    // still real and happened during this request, so reporting it is truthful.
    return "declined" as const;
  });
  return result;
}
