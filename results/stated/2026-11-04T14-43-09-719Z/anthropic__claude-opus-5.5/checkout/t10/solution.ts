// Locally declared shapes (runtime provides Ctx, Db, PayCo, Charge, ...).
type OrderStatus = "pending" | "paid" | "declined";
interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: OrderStatus;
}
interface AttemptRecord {
  attempt: number;
  status: "pending" | "declined" | "paid";
  chargeId?: string;
}

const MAX_TIMEOUT_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errCode(e: unknown): string | undefined {
  return e && typeof e === "object" && typeof (e as any).code === "string" ? (e as any).code : undefined;
}

export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const { db, payco } = ctx;
  const orderKey = `order:${orderId}`;
  const recKey = `checkout:${orderId}`;

  const order = await db.get<Order>(orderKey);
  if (!order) throw Object.assign(new Error(`order ${orderId} not found`), { code: "not_found" });
  if (order.status === "paid") return "paid";

  // Ensure an attempt record exists.
  await db.insertIfAbsent<AttemptRecord>(recKey, { attempt: 1, status: "pending" });
  let rec = (await db.get<AttemptRecord>(recKey))!;
  if (rec.status === "paid") return "paid";

  if (rec.status === "declined") {
    // The last attempt was declined: the customer is pressing Pay again (perhaps with a new card).
    // Start a new attempt atomically; if another request already did, join its attempt.
    const seen = rec.attempt;
    rec = await db.update<AttemptRecord>(recKey, (cur) => {
      const c = cur ?? { attempt: seen, status: "declined" };
      if (c.attempt === seen && c.status === "declined") {
        return { attempt: seen + 1, status: "pending" };
      }
      return c;
    });
    if (rec.status === "paid") return "paid";
    // If rec is "declined" here, another request bumped the attempt and that new
    // attempt was declined too. We reuse its key: PayCo returns the recorded decline.
  }

  const attempt = rec.attempt;
  // Each attempt has its own key. Parameters are constant for a given order, so
  // reusing the key after a crash or timeout replays the recorded result instead of charging again.
  const idempotencyKey = `checkout:${orderId}:attempt:${attempt}`;

  let outcome: { kind: "paid"; charge: Charge } | { kind: "declined" } | undefined;
  for (let i = 0; ; i++) {
    try {
      const charge = await payco.createCharge({
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId, attempt: String(attempt) },
        idempotencyKey,
      });
      outcome = { kind: "paid", charge };
      break;
    } catch (e) {
      const code = errCode(e);
      if (code === "card_declined") {
        outcome = { kind: "declined" };
        break;
      }
      if (code === "timeout" && i < MAX_TIMEOUT_RETRIES) {
        await sleep(200 * (i + 1));
        continue;
      }
      // Unknown outcome or unexpected error: throw. A retry reuses the same key
      // (the record is still pending), so it can never double-charge.
      throw e;
    }
  }

  if (outcome.kind === "paid") {
    const chargeId = outcome.charge.id;
    await db.transaction((tx) => {
      const o = tx.get<Order>(orderKey);
      if (o) tx.set<Order>(orderKey, { ...o, status: "paid" });
      const r = tx.get<AttemptRecord>(recKey);
      tx.set<AttemptRecord>(recKey, { attempt: Math.max(r?.attempt ?? attempt, attempt), status: "paid", chargeId });
    });
    return "paid";
  }

  // Declined. Record it, but never overwrite an order another request already marked paid.
  const result = await db.transaction<"paid" | "declined">((tx) => {
    const o = tx.get<Order>(orderKey);
    const r = tx.get<AttemptRecord>(recKey);
    if (o?.status === "paid" || r?.status === "paid") return "paid";
    if (r && r.attempt === attempt) {
      tx.set<AttemptRecord>(recKey, { attempt, status: "declined" });
    }
    if (o) tx.set<Order>(orderKey, { ...o, status: "declined" });
    return "declined";
  });
  return result;
}
