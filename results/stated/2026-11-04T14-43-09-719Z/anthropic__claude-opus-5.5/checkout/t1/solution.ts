// Checkout handler: charges the saved card for an order exactly once per attempt.
//
// Design:
// - `checkout:<orderId>` holds { n, state }. Each charge attempt n uses the PayCo
//   idempotency key `checkout:<orderId>:<n>`.
// - While attempt n is "open", every request reuses key n. This covers a crashed
//   request, a timed-out request and concurrent requests: PayCo performs at most
//   one charge for key n and returns that same result to everyone.
// - A new attempt n+1 is started only after attempt n was recorded as declined.
//   At that point the customer was not charged for n, so pressing Pay again
//   after updating the card produces a fresh charge request.

interface OrderRec {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface AttemptRec {
  n: number;
  state: "open" | "declined" | "paid";
}

const MAX_TIMEOUT_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:${orderId}`;

  // Step 1: atomically read the order and claim or reuse an attempt number.
  const start = await ctx.db.transaction((tx) => {
    const order = tx.get<OrderRec>(orderKey);
    if (!order) {
      const e: any = new Error(`order ${orderId} not found`);
      e.code = "order_not_found";
      throw e;
    }
    if (order.status === "paid") return { kind: "paid" as const };

    const cur = tx.get<AttemptRec>(attemptKey);
    let att: AttemptRec;
    if (!cur) {
      att = { n: 1, state: "open" };
      tx.set(attemptKey, att);
    } else if (cur.state === "paid") {
      // The charge succeeded but the order was not updated (partial write
      // elsewhere). Repair the order and report paid.
      tx.set(orderKey, { ...order, status: "paid" });
      return { kind: "paid" as const };
    } else if (cur.state === "declined") {
      // The previous attempt was declined (no charge), so start a fresh one.
      att = { n: cur.n + 1, state: "open" };
      tx.set(attemptKey, att);
    } else {
      // Open attempt: possibly in flight or crashed. Reuse its key so the
      // customer can never be charged twice.
      att = cur;
    }
    return { kind: "charge" as const, order, n: att.n };
  });

  if (start.kind === "paid") return "paid";
  const { order, n } = start;

  // Step 2: charge with the attempt's idempotency key. Parameters are identical
  // on every retry of the same attempt.
  const idempotencyKey = `checkout:${orderId}:${n}`;
  let declined = false;
  for (let i = 0; ; i++) {
    try {
      await ctx.payco.createCharge({
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId, attempt: String(n) },
        idempotencyKey,
      });
      break;
    } catch (err: any) {
      if (err?.code === "card_declined") {
        declined = true;
        break;
      }
      if (err?.code === "timeout" && i < MAX_TIMEOUT_RETRIES) {
        // Retrying a timed-out request with the same key is always safe.
        await sleep(200 * (i + 1));
        continue;
      }
      // Unknown outcome (e.g. repeated timeouts). The attempt stays open, so a
      // later press reuses the same key and learns the real result.
      throw err;
    }
  }

  // Step 3: record the outcome atomically.
  if (!declined) {
    await ctx.db.transaction((tx) => {
      const o = tx.get<OrderRec>(orderKey);
      if (o && o.status !== "paid") tx.set(orderKey, { ...o, status: "paid" });
      const a = tx.get<AttemptRec>(attemptKey);
      if (a && a.n === n) tx.set(attemptKey, { n, state: "paid" });
    });
    return "paid";
  }

  const result = await ctx.db.transaction((tx) => {
    const o = tx.get<OrderRec>(orderKey);
    if (o && o.status === "paid") return "paid" as const; // never contradict a recorded payment
    const a = tx.get<AttemptRec>(attemptKey);
    if (a && a.n === n && a.state === "open") {
      tx.set(attemptKey, { n, state: "declined" });
    }
    // If a.n > n, a newer attempt has already started after attempt n was
    // recorded as declined. Our decline of attempt n is still genuine. Any
    // charge from the newer attempt happened after we last looked, which is a
    // race no handler can prevent. Do not overwrite a newer attempt's state.
    if (o && (!a || a.n === n)) tx.set(orderKey, { ...o, status: "declined" });
    return "declined" as const;
  });
  return result;
}
