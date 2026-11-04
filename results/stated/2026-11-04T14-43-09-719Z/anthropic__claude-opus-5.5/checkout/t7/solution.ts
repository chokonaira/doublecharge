// Types Ctx, Db, Tx, PayCo, Charge are provided by the runtime.

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
  chargeId?: string;
}

interface AttemptState {
  n: number; // current attempt number; bumped only after a recorded decline of attempt n
}

const orderKey = (id: string) => `order:${id}`;
const attemptKey = (id: string) => `checkoutAttempt:${id}`;
const chargeIdemKey = (id: string, n: number) => `checkout:${id}:${n}`;

function codeOf(e: unknown): string | undefined {
  return e && typeof e === "object" && typeof (e as any).code === "string" ? (e as any).code : undefined;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const { db, payco } = ctx;

  // 1. Read the order and the current attempt number together (atomically).
  const start = db.transaction((tx: Tx) => {
    const order = tx.get<Order>(orderKey(orderId));
    if (!order) return { order: undefined, n: 0 };
    let st = tx.get<AttemptState>(attemptKey(orderId));
    if (!st) {
      st = { n: 1 };
      tx.set(attemptKey(orderId), st);
    }
    return { order, n: st.n };
  });
  const { order, n } = await start;
  if (!order) {
    const err: any = new Error(`order ${orderId} not found`);
    err.code = "order_not_found";
    throw err;
  }
  if (order.status === "paid") return "paid";

  // 2. Charge with a stable idempotency key for this attempt.
  //    - If an earlier request with this key succeeded (and crashed before
  //      recording it), PayCo returns that success: no double charge.
  //    - If it was declined, PayCo returns that decline. The decline was then
  //      never reported to the customer, because reporting happens only after
  //      the attempt number is bumped.
  //    - A timed-out request is not recorded by PayCo, so retrying the same key is safe.
  const key = chargeIdemKey(orderId, n);
  let charge: Charge | undefined;
  let declined = false;
  const MAX_TRIES = 3;
  for (let i = 0; ; i++) {
    try {
      charge = await payco.createCharge({
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId, attempt: String(n) },
        idempotencyKey: key,
      });
      break;
    } catch (e) {
      const code = codeOf(e);
      if (code === "card_declined") {
        declined = true;
        break;
      }
      if (code === "timeout" && i < MAX_TRIES - 1) continue;
      // Timeout after retries, idempotency_mismatch, or anything else: we don't
      // know the outcome (or it is unsafe to guess). Throw without touching state.
      // The customer's retry reuses the same key and resolves the true outcome.
      throw e;
    }
  }

  if (charge) {
    // The customer has been charged: record it as paid, whatever the stored
    // status currently says.
    await db.transaction((tx: Tx) => {
      const cur = tx.get<Order>(orderKey(orderId));
      if (!cur) return;
      tx.set(orderKey(orderId), { ...cur, status: "paid", chargeId: charge!.id });
    });
    return "paid";
  }

  // 3. Declined. In one transaction:
  //    - If the order is already paid, the customer was charged (by a
  //      concurrent attempt), so tell them "paid".
  //    - Otherwise mark the order declined and advance the attempt number, so
  //      the next Pay press makes a fresh charge (e.g. with an updated card).
  //    The bump only happens if the attempt number is still n, so concurrent
  //    requests that shared key n don't skip attempts.
  const result = await db.transaction((tx: Tx) => {
    const cur = tx.get<Order>(orderKey(orderId));
    if (!cur) return "declined" as const;
    if (cur.status === "paid") return "paid" as const;
    const st = tx.get<AttemptState>(attemptKey(orderId)) ?? { n };
    if (st.n === n) tx.set(attemptKey(orderId), { n: n + 1 });
    tx.set(orderKey(orderId), { ...cur, status: "declined" });
    return "declined" as const;
  });
  void declined;
  return result;
}
