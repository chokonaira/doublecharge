// Types (Ctx, Db, PayCo, Charge, ...) are provided by the runtime.

type OrderStatus = "pending" | "paid" | "declined";

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: OrderStatus;
}

interface CheckoutAttempt {
  // Attempt number. It is part of the PayCo idempotency key.
  n: number;
  // "open": a charge with this key may or may not exist at PayCo.
  // "declined": PayCo definitively declined this key, so no charge exists for it.
  // "paid": the charge succeeded.
  state: "open" | "declined" | "paid";
  // Frozen when the attempt is opened, so a retry sends exactly the same params.
  amount: number;
  currency: string;
  customerId: string;
  chargeId?: string;
}

const orderKey = (id: string) => `order:${id}`;
const attemptKey = (id: string) => `checkout:${id}`;
const idemKey = (id: string, n: number) => `checkout:${id}:attempt:${n}`;

function errCode(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : undefined;
}

/*
 * Why there is no double charge:
 * - Every charge uses the idempotency key checkout:<orderId>:attempt:<n>.
 * - While attempt n is "open" (a crash, a timeout, or a concurrent request),
 *   every caller reuses the same key. PayCo performs the charge at most once
 *   and replays its result.
 * - A new attempt n+1 is opened only after attempt n was recorded as
 *   "declined". A decline means no charge was created, so at most one key
 *   can ever produce a charge.
 * - A new key per Pay press after a decline lets the customer's updated card
 *   be tried. Reusing the old key would replay the cached decline.
 */
export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const { db, payco } = ctx;

  // Step 1: atomically pick or open the attempt for this call.
  const attempt = await db.transaction((tx) => {
    const order = tx.get<Order>(orderKey(orderId));
    if (!order) {
      const e = new Error(`order ${orderId} not found`) as Error & { code: string };
      e.code = "order_not_found";
      throw e;
    }
    const cur = tx.get<CheckoutAttempt>(attemptKey(orderId));

    if (order.status === "paid" || cur?.state === "paid") {
      return { ...(cur ?? ({} as CheckoutAttempt)), state: "paid" } as CheckoutAttempt;
    }
    if (cur && cur.state === "open") {
      // Resume: same key and same params as the earlier try.
      return cur;
    }

    // No attempt yet, or the previous one was definitively declined.
    const next: CheckoutAttempt = {
      n: cur ? cur.n + 1 : 1,
      state: "open",
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
    };
    tx.set(attemptKey(orderId), next);
    if (order.status !== "pending") {
      tx.set(orderKey(orderId), { ...order, status: "pending" as OrderStatus });
    }
    return next;
  });

  if (attempt.state === "paid") return "paid";

  // Step 2: charge, retrying timeouts inline with the same key (always safe).
  let charge: Charge | undefined;
  let declined = false;
  const MAX_TRIES = 3;
  for (let i = 0; ; i++) {
    try {
      charge = await payco.createCharge({
        amount: attempt.amount,
        currency: attempt.currency,
        customerId: attempt.customerId,
        metadata: { orderId, attempt: String(attempt.n) },
        idempotencyKey: idemKey(orderId, attempt.n),
      });
      break;
    } catch (e) {
      const code = errCode(e);
      if (code === "card_declined") {
        declined = true;
        break;
      }
      if (code === "timeout" && i < MAX_TRIES - 1) {
        await new Promise((r) => setTimeout(r, 200 * (i + 1)));
        continue;
      }
      // Timeout after all tries, or an unexpected error. The attempt stays
      // "open", so the customer's retry reuses this key and cannot double charge.
      throw e;
    }
  }

  // Step 3: record the outcome atomically on both keys.
  if (charge) {
    const chargeId = charge.id;
    await db.transaction((tx) => {
      const cur = tx.get<CheckoutAttempt>(attemptKey(orderId));
      if (cur && cur.n === attempt.n) {
        tx.set(attemptKey(orderId), { ...cur, state: "paid", chargeId });
      }
      const order = tx.get<Order>(orderKey(orderId));
      if (order && order.status !== "paid") {
        tx.set(orderKey(orderId), { ...order, status: "paid" as OrderStatus });
      }
    });
    return "paid";
  }

  if (declined) {
    const result = await db.transaction((tx): "paid" | "declined" => {
      const order = tx.get<Order>(orderKey(orderId));
      const cur = tx.get<CheckoutAttempt>(attemptKey(orderId));
      if (order?.status === "paid" || cur?.state === "paid") return "paid";
      // Only the matching open attempt may be marked declined. If a concurrent
      // request already moved on, leave the newer attempt alone.
      if (cur && cur.n === attempt.n && cur.state === "open") {
        tx.set(attemptKey(orderId), { ...cur, state: "declined" });
        if (order) tx.set(orderKey(orderId), { ...order, status: "declined" as OrderStatus });
        return "declined";
      }
      if (cur && cur.n === attempt.n && cur.state === "declined") return "declined";
      // A newer attempt is in progress. Report this attempt's own result.
      return "declined";
    });
    return result;
  }

  // Unreachable: the loop always breaks with a charge or a decline, or throws.
  throw new Error("unreachable");
}
