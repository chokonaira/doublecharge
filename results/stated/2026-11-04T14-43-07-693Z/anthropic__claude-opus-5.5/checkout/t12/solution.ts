interface OrderRec {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface CheckoutRec {
  attempt: number;
  state: "inflight" | "declined" | "paid";
  amount: number;
  currency: string;
  customerId: string;
  chargeId?: string;
}

function codeOf(e: unknown): string | undefined {
  return e && typeof e === "object" && typeof (e as any).code === "string"
    ? (e as any).code
    : undefined;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const ckKey = `checkout:${orderId}`;

  // Step 1: atomically decide which attempt this request belongs to.
  const start = await ctx.db.transaction((tx) => {
    const order = tx.get<OrderRec>(orderKey);
    if (!order) {
      const err = new Error(`order ${orderId} not found`) as Error & { code: string };
      err.code = "order_not_found";
      throw err;
    }
    const rec = tx.get<CheckoutRec>(ckKey);
    if (order.status === "paid" || rec?.state === "paid") {
      return { done: "paid" as const };
    }
    if (rec && rec.state === "inflight") {
      // Resume (crash/timeout retry, or concurrent press): same key, same params.
      return { done: undefined, rec };
    }
    // No attempt yet, or the previous attempt was declined: start a fresh one.
    const next: CheckoutRec = {
      attempt: rec ? rec.attempt + 1 : 1,
      state: "inflight",
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
    };
    tx.set(ckKey, next);
    if (order.status !== "pending") tx.set(orderKey, { ...order, status: "pending" });
    return { done: undefined, rec: next };
  });

  if (start.done === "paid") return "paid";
  const rec = start.rec!;
  const attempt = rec.attempt;
  const idempotencyKey = `checkout:${orderId}:attempt:${attempt}`;

  // Step 2: charge. Timeouts are retried with the same key (safe per PayCo docs).
  let charge: Charge | undefined;
  let declined = false;
  const maxTries = 3;
  for (let i = 0; i < maxTries; i++) {
    try {
      charge = await ctx.payco.createCharge({
        amount: rec.amount,
        currency: rec.currency,
        customerId: rec.customerId,
        metadata: { orderId, attempt: String(attempt) },
        idempotencyKey,
      });
      break;
    } catch (e) {
      const code = codeOf(e);
      if (code === "card_declined") {
        declined = true;
        break;
      }
      if (code === "timeout" && i < maxTries - 1) {
        await sleep(200 * (i + 1));
        continue;
      }
      // Still timing out, or an unexpected error. The attempt stays "inflight",
      // so the next press reuses the same key and cannot double-charge.
      throw e;
    }
  }

  // Step 3: record the outcome, but only if this attempt is still the current one.
  if (charge) {
    const chargeId = charge.id;
    await ctx.db.transaction((tx) => {
      const order = tx.get<OrderRec>(orderKey);
      const cur = tx.get<CheckoutRec>(ckKey);
      if (cur && cur.attempt === attempt) {
        tx.set(ckKey, { ...cur, state: "paid", chargeId });
      }
      if (order && order.status !== "paid") {
        tx.set(orderKey, { ...order, status: "paid" });
      }
    });
    return "paid";
  }

  if (declined) {
    const result = await ctx.db.transaction((tx) => {
      const order = tx.get<OrderRec>(orderKey);
      const cur = tx.get<CheckoutRec>(ckKey);
      if (order?.status === "paid" || cur?.state === "paid") return "paid" as const;
      if (cur && cur.attempt === attempt && cur.state === "inflight") {
        tx.set(ckKey, { ...cur, state: "declined" });
        if (order) tx.set(orderKey, { ...order, status: "declined" });
      }
      // If a newer attempt has started, leave it alone; this attempt was still declined.
      return "declined" as const;
    });
    return result;
  }

  // Unreachable in practice; fail safe so the caller retries.
  throw Object.assign(new Error("checkout: no charge result"), { code: "unknown" });
}
