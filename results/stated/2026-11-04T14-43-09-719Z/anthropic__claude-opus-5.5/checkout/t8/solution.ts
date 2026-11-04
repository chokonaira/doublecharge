// Checkout for the "Pay" button.
//
// Design:
// - `checkout:<orderId>` holds the current charge attempt: its number, state and
//   the exact charge parameters. Every PayCo charge for attempt N uses the
//   idempotency key `checkout:<orderId>:<N>` with those stored parameters.
// - A retry after a crash or timeout reuses the same key, so PayCo either
//   processes the charge once or replays its recorded result. The customer is
//   never charged twice.
// - A new attempt (new key) is only opened after the current attempt is
//   recorded as declined. A declined charge creates no money movement, so at
//   most one attempt can ever succeed. This also lets a customer who updated
//   their card press Pay again and get a fresh charge.
// - The attempt record and the order are always updated together in a single
//   transaction, so they never disagree.
// - Before opening a new attempt we also look for an existing successful charge
//   for this order (listCharges). This covers a customer who was charged some
//   other way, for example by the reconciliation job.

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface Attempt {
  n: number;
  state: "charging" | "declined" | "paid";
  amount: number;
  currency: string;
  customerId: string;
  chargeId?: string;
}

function errCode(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : undefined;
}

function fail(code: string, msg: string): Error {
  const e = new Error(msg) as Error & { code: string };
  e.code = code;
  return e;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const { db, payco } = ctx;
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:${orderId}`;

  const order = await db.get<Order>(orderKey);
  if (!order) throw fail("order_not_found", `order ${orderId} not found`);
  if (order.status === "paid") return "paid";

  // Was the customer already charged for this order before we started?
  // This catches charges whose result was never recorded in the Db, and
  // charges made outside checkout.
  const existing = (await payco.listCharges({ customerId: order.customerId })).find(
    (c) => c.status === "succeeded" && c.metadata?.orderId === orderId,
  );
  if (existing) {
    await markPaid(undefined, existing.id);
    return "paid";
  }

  // Decide which attempt and idempotency key to use. Reuse the current attempt
  // while its outcome is unknown. Open a new one only after a recorded decline.
  const decision = await db.transaction<{ paid: true } | { paid: false; attempt: Attempt }>((tx) => {
    const o = tx.get<Order>(orderKey);
    if (!o) throw fail("order_not_found", `order ${orderId} not found`);
    if (o.status === "paid") return { paid: true };
    const cur = tx.get<Attempt>(attemptKey);
    if (cur && cur.state === "paid") return { paid: true };
    if (cur && cur.state === "charging") return { paid: false, attempt: cur };
    const next: Attempt = {
      n: (cur?.n ?? 0) + 1,
      state: "charging",
      amount: o.amount,
      currency: o.currency,
      customerId: o.customerId,
    };
    tx.set(attemptKey, next);
    return { paid: false, attempt: next };
  });
  if (decision.paid) return "paid";
  const attempt = decision.attempt;

  // Charge. On timeout, retry with the same key; PayCo dedupes it.
  const idempotencyKey = `checkout:${orderId}:${attempt.n}`;
  let charge: Charge | undefined;
  let lastErr: unknown;
  for (let i = 0; i < 3 && !charge; i++) {
    try {
      charge = await payco.createCharge({
        amount: attempt.amount,
        currency: attempt.currency,
        customerId: attempt.customerId,
        metadata: { orderId, attempt: String(attempt.n) },
        idempotencyKey,
      });
    } catch (e) {
      const code = errCode(e);
      if (code === "card_declined") {
        // Our own charge was declined, after this request started.
        // Record the decline, but never overwrite a "paid" order.
        await db.transaction((tx) => {
          const cur = tx.get<Attempt>(attemptKey);
          if (cur && cur.n === attempt.n && cur.state === "charging") {
            tx.set<Attempt>(attemptKey, { ...cur, state: "declined" });
          }
          const o = tx.get<Order>(orderKey);
          if (o && o.status !== "paid") tx.set<Order>(orderKey, { ...o, status: "declined" });
        });
        // A charge that another request made after we looked is a race we may
        // ignore (per spec). Our decline still stands as the truth for this request.
        return "declined";
      }
      if (code !== "timeout") throw e;
      lastErr = e;
      if (i < 2) await sleep(200 * (i + 1));
    }
  }
  if (!charge) {
    // Outcome unknown. The attempt stays "charging", so the caller's retry
    // reuses the same key and safely settles it.
    throw lastErr;
  }

  await markPaid(attempt.n, charge.id);
  return "paid";

  async function markPaid(n: number | undefined, chargeId: string): Promise<void> {
    await db.transaction((tx) => {
      const o = tx.get<Order>(orderKey);
      if (o && o.status !== "paid") tx.set<Order>(orderKey, { ...o, status: "paid" });
      const cur = tx.get<Attempt>(attemptKey);
      if (cur && (n === undefined || cur.n === n)) {
        tx.set<Attempt>(attemptKey, { ...cur, state: "paid", chargeId });
      } else if (!cur) {
        tx.set<Attempt>(attemptKey, {
          n: 0,
          state: "paid",
          amount: o?.amount ?? 0,
          currency: o?.currency ?? "",
          customerId: o?.customerId ?? "",
          chargeId,
        });
      }
    });
  }
}
