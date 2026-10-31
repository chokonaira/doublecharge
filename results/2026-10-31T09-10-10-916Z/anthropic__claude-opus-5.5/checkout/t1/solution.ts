// Checkout for the "Pay" button.
//
// Design:
// - PayCo idempotency keys make retries safe, but PayCo also replays a recorded
//   *decline* for a reused key. After a decline the customer must be able to pay
//   again with an updated card, so every payment attempt has its own key.
// - The attempt record lives in the Db (`checkout:<orderId>`). It is created or
//   advanced inside a transaction, so concurrent presses on any instance share
//   one attempt. A new attempt is only opened after the previous one was
//   recorded as declined, and a declined attempt created no charge. So at most
//   one attempt can produce a charge, which means at most one successful charge
//   per order.
// - If an instance dies mid-request, or PayCo keeps timing out, the attempt
//   stays "open". The next press reuses the same key, so PayCo either performs
//   the charge or returns what it already recorded. It never charges twice.
// - The amount, currency and customer are frozen into the attempt when it is
//   opened, so every retry sends identical parameters. This avoids
//   idempotency_mismatch if the order is edited meanwhile.

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface Attempt {
  attempt: number;
  state: "open" | "declined" | "paid";
  amount: number;
  currency: string;
  customerId: string;
  chargeId?: string;
}

type Begin = { kind: "paid" } | { kind: "open"; att: Attempt };

const MAX_TIMEOUT_RETRIES = 3;

function codeOf(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:${orderId}`;

  // 1. Find the current attempt, or open a new one, atomically.
  const begin = await ctx.db.transaction<Begin>((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      throw Object.assign(new Error(`order ${orderId} not found`), { code: "order_not_found" });
    }
    if (order.status === "paid") return { kind: "paid" };

    const att = tx.get<Attempt>(attemptKey);
    if (att && att.state === "paid") {
      // A charge already succeeded. Make sure the order reflects it.
      tx.set<Order>(orderKey, { ...order, status: "paid" });
      return { kind: "paid" };
    }
    if (att && att.state === "open") return { kind: "open", att };

    // No attempt yet, or the last one was declined: open a fresh attempt.
    const next: Attempt = {
      attempt: (att?.attempt ?? 0) + 1,
      state: "open",
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
    };
    tx.set<Attempt>(attemptKey, next);
    if (order.status !== "pending") tx.set<Order>(orderKey, { ...order, status: "pending" });
    return { kind: "open", att: next };
  });

  if (begin.kind === "paid") return "paid";
  const att = begin.att;
  const idempotencyKey = `checkout:${orderId}:attempt:${att.attempt}`;

  // 2. Charge. Retrying a timeout with the same key is always safe.
  let charge: Charge | undefined;
  let declined = false;
  for (let i = 0; ; i++) {
    try {
      charge = await ctx.payco.createCharge({
        amount: att.amount,
        currency: att.currency,
        customerId: att.customerId,
        metadata: { orderId, attempt: String(att.attempt) },
        idempotencyKey,
      });
      break;
    } catch (e) {
      const code = codeOf(e);
      if (code === "card_declined") {
        declined = true;
        break;
      }
      if (code === "timeout" && i < MAX_TIMEOUT_RETRIES) {
        await sleep(200 * 2 ** i);
        continue;
      }
      // Outcome unknown, or an unexpected error. The attempt stays open and
      // the next press reuses the same key, so no double charge is possible.
      throw e;
    }
  }

  // 3. Record the outcome atomically on both keys.
  if (charge) {
    const chargeId = charge.id;
    await ctx.db.transaction((tx) => {
      const cur = tx.get<Attempt>(attemptKey);
      if (cur && cur.attempt === att.attempt) {
        tx.set<Attempt>(attemptKey, { ...cur, state: "paid", chargeId });
      }
      const order = tx.get<Order>(orderKey);
      // Money was taken, so the order is paid no matter what else happened.
      if (order) tx.set<Order>(orderKey, { ...order, status: "paid" });
    });
    return "paid";
  }

  if (declined) {
    const result = await ctx.db.transaction<"paid" | "declined">((tx) => {
      const order = tx.get<Order>(orderKey);
      if (order?.status === "paid") return "paid";
      const cur = tx.get<Attempt>(attemptKey);
      if (cur && cur.attempt === att.attempt && cur.state === "open") {
        tx.set<Attempt>(attemptKey, { ...cur, state: "declined" });
      }
      if (order) tx.set<Order>(orderKey, { ...order, status: "declined" });
      return "declined";
    });
    return result;
  }

  // Unreachable: the loop either sets charge or declined, or throws.
  throw new Error("checkout: unexpected state");
}
