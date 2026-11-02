// Checkout for the "Pay" button.
//
// Design
// ------
// Every charge attempt for an order gets a stable PayCo idempotency key:
// `checkout:<orderId>:<attempt>`. The attempt state lives in the shared Db
// under `checkout:<orderId>`, so all instances agree on it:
//
//   - Concurrent clicks or client retries, on any instance, reuse the current
//     in-flight attempt. They therefore reuse its key, and PayCo makes sure
//     the customer is charged at most once for that attempt.
//   - A timeout leaves the attempt "inflight". The next press retries with the
//     same key, which PayCo documents as always safe.
//   - A decline is final for its key, because PayCo replays the recorded
//     error. So after a decline the next press opens a new attempt with a new
//     key. That lets a customer who updated their saved card be charged.
//   - The amount and currency are frozen into the attempt record. A retry with
//     the same key therefore always sends identical parameters and never
//     triggers idempotency_mismatch.
//
// Every state transition is done inside a Db transaction, so no two
// instances can race on the order or attempt records.

type OrderStatus = "pending" | "paid" | "declined";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: OrderStatus;
}

interface Attempt {
  attempt: number;
  state: "inflight" | "declined" | "paid";
  customerId: string;
  amount: number;
  currency: string;
  chargeId?: string;
}

const orderKey = (id: string) => `order:${id}`;
const attemptKey = (id: string) => `checkout:${id}`;
const idemKey = (id: string, n: number) => `checkout:${id}:${n}`;

type Plan = { kind: "done"; result: "paid" } | { kind: "charge"; attempt: Attempt };

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const { db, payco } = ctx;

  // 1. Atomically decide which attempt to perform.
  const plan = await db.transaction<Plan>((tx) => {
    const order = tx.get<Order>(orderKey(orderId));
    if (!order) {
      throw Object.assign(new Error(`Order ${orderId} not found`), { code: "order_not_found" });
    }
    if (order.status === "paid") return { kind: "done", result: "paid" };

    const cur = tx.get<Attempt>(attemptKey(orderId));
    if (cur && cur.state === "paid") {
      // The charge succeeded but the order write was lost. Repair it.
      tx.set<Order>(orderKey(orderId), { ...order, status: "paid" });
      return { kind: "done", result: "paid" };
    }
    if (cur && cur.state === "inflight") {
      // Retry or concurrent click: reuse the same attempt and key.
      return { kind: "charge", attempt: cur };
    }

    // There is no attempt yet, or the previous one was declined: open a new one.
    const next: Attempt = {
      attempt: cur ? cur.attempt + 1 : 1,
      state: "inflight",
      customerId: order.customerId,
      amount: order.amount,
      currency: order.currency,
    };
    tx.set<Attempt>(attemptKey(orderId), next);
    return { kind: "charge", attempt: next };
  });

  if (plan.kind === "done") return plan.result;
  const a = plan.attempt;

  // 2. Charge. Retrying with the same key is safe, so retry a few times on
  //    timeout before giving up.
  let charge: Charge | undefined;
  let declined = false;
  const maxTries = 3;
  for (let i = 0; ; i++) {
    try {
      charge = await payco.createCharge({
        amount: a.amount,
        currency: a.currency,
        customerId: a.customerId,
        metadata: { orderId, attempt: String(a.attempt) },
        idempotencyKey: idemKey(orderId, a.attempt),
      });
      break;
    } catch (err: any) {
      if (err?.code === "card_declined") {
        declined = true;
        break;
      }
      if (err?.code === "timeout" && i < maxTries - 1) {
        await new Promise((r) => setTimeout(r, 200 * (i + 1)));
        continue;
      }
      // On a timeout after retries, or an unexpected error, the attempt stays
      // "inflight". The customer's next press retries the same key, which
      // cannot double-charge. The reconciliation job can also settle it using
      // the same key or the orderId metadata.
      throw err;
    }
  }

  // 3. Record the outcome atomically.
  if (charge) {
    const chargeId = charge.id;
    await db.transaction((tx) => {
      const order = tx.get<Order>(orderKey(orderId));
      const cur = tx.get<Attempt>(attemptKey(orderId));
      if (cur && cur.attempt === a.attempt) {
        tx.set<Attempt>(attemptKey(orderId), { ...cur, state: "paid", chargeId });
      }
      if (order) tx.set<Order>(orderKey(orderId), { ...order, status: "paid" });
    });
    return "paid";
  }

  // The card was declined. Mark the attempt declined only if it is still the
  // current in-flight one; a declined key always replays a decline, so the
  // result is the same for every caller using it.
  return await db.transaction<"paid" | "declined">((tx) => {
    const order = tx.get<Order>(orderKey(orderId));
    if (order?.status === "paid") return "paid";
    const cur = tx.get<Attempt>(attemptKey(orderId));
    if (cur && cur.attempt === a.attempt && cur.state === "inflight") {
      tx.set<Attempt>(attemptKey(orderId), { ...cur, state: "declined" });
    }
    if (order) tx.set<Order>(orderKey(orderId), { ...order, status: "declined" });
    return "declined";
  });
}
