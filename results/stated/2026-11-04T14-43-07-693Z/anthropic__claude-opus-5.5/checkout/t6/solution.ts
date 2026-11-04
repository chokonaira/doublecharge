// Checkout with exactly-once charging across retries, crashes and concurrent requests.
//
// Design:
// - Each order has a durable attempt counter in the Db (`checkout:<orderId>`).
//   The PayCo idempotency key is derived from it: `checkout:<orderId>:<attempt>`.
// - Any retry of the same attempt (after a timeout, a crash, a concurrent double
//   click, or a request landing on another instance) reuses the same key. PayCo
//   then returns the recorded result instead of charging again.
// - The counter advances only after PayCo has definitively declined the current
//   attempt. A declined key never produced a charge, so a new key cannot cause a
//   double charge. The new key lets the customer retry after updating their card.
//   Without it, PayCo would keep replaying the cached decline.
// - A crash at any point leaves the system in one of two states:
//   (a) PayCo never recorded the attempt: a retry charges normally.
//   (b) PayCo recorded it: a retry replays the result and finishes the Db update.

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface CheckoutState {
  attempt: number;
}

const orderKey = (id: string) => `order:${id}`;
const stateKey = (id: string) => `checkout:${id}`;

function errCode(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : undefined;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const { db, payco } = ctx;

  // Read the order and the current attempt together.
  // Create the attempt record on first use.
  const snap = await db.transaction((tx) => {
    const order = tx.get<Order>(orderKey(orderId));
    if (!order) return undefined;
    let state = tx.get<CheckoutState>(stateKey(orderId));
    if (!state) {
      state = { attempt: 0 };
      tx.set(stateKey(orderId), state);
    }
    return { order, attempt: state.attempt };
  });

  if (!snap) {
    const e = new Error(`Order ${orderId} not found`) as Error & { code: string };
    e.code = "order_not_found";
    throw e;
  }

  const { order, attempt } = snap;
  if (order.status === "paid") return "paid";

  const idempotencyKey = `checkout:${orderId}:${attempt}`;

  // Retrying a timed-out request with the same key is always safe.
  // Make a few quick tries; if PayCo keeps timing out, throw so the customer can
  // retry later. The next request will reuse the same key.
  let declined = false;
  const MAX_TRIES = 3;
  for (let i = 0; ; i++) {
    try {
      await payco.createCharge({
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId, attempt: String(attempt) },
        idempotencyKey,
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
      // timeout (exhausted), idempotency_mismatch, or unknown: the outcome is
      // unknown or unsafe to resolve here. Leave the state untouched so a retry
      // reuses the same key. The reconciliation job handles abandoned orders.
      // idempotency_mismatch only occurs if the order's amount, currency or
      // customer changed mid-checkout. Charging again under a new key could
      // double charge, so surface the error instead.
      throw e;
    }
  }

  if (!declined) {
    await db.update<Order>(orderKey(orderId), (cur) => {
      if (!cur) throw new Error(`Order ${orderId} disappeared`);
      return cur.status === "paid" ? cur : { ...cur, status: "paid" };
    });
    return "paid";
  }

  // Definitive decline for this attempt. In one transaction:
  // - advance the attempt so the next Pay press uses a fresh key, but only if no
  //   concurrent request has already advanced it;
  // - mark the order declined, unless another attempt has already paid it.
  const finalStatus = await db.transaction((tx) => {
    const st = tx.get<CheckoutState>(stateKey(orderId)) ?? { attempt: 0 };
    if (st.attempt === attempt) {
      tx.set(stateKey(orderId), { attempt: attempt + 1 });
    }
    const cur = tx.get<Order>(orderKey(orderId));
    if (!cur) throw new Error(`Order ${orderId} disappeared`);
    if (cur.status === "paid") return "paid" as const;
    if (cur.status !== "declined") tx.set(orderKey(orderId), { ...cur, status: "declined" });
    return "declined" as const;
  });

  return finalStatus;
}
