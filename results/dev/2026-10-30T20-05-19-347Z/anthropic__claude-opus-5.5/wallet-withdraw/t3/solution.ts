// Types (Ctx, Db, Tx, PayCo, Payout, ...) are provided by the runtime.

type Outcome = "paid_out" | "insufficient_funds" | "rejected";

interface WithdrawalRecord {
  userId: string;
  requestId: string;
  amount: number;
  status: "pending" | "paid_out" | "rejected" | "insufficient_funds";
  payoutId?: string;
}

const walletKey = (userId: string) => `wallet:${userId}`;
const withdrawalKey = (userId: string, requestId: string) =>
  `withdrawal:${encodeURIComponent(userId)}:${encodeURIComponent(requestId)}`;
const pendingKey = (userId: string) => `withdrawals_pending:${encodeURIComponent(userId)}`;
const payoutIdemKey = (userId: string, requestId: string) =>
  `wallet-withdrawal:${encodeURIComponent(userId)}:${encodeURIComponent(requestId)}`;

/*
 * Design:
 *  1. Atomically (one Db transaction): check balance, debit wallet, store a
 *     "pending" withdrawal record and add it to the user's pending index.
 *  2. Call PayCo createPayout with an idempotency key derived from
 *     (userId, requestId), using the amount stored in the record.
 *  3. On success, mark the record paid_out. On payout_rejected, refund the
 *     wallet and mark it rejected. The record is guarded on status "pending",
 *     so this happens only once. On timeout or other errors, throw. The
 *     record stays pending and the caller's retry repeats step 2 with the same
 *     key. PayCo either processes it or returns the recorded result.
 *
 * A crash at any point leaves either nothing done, or a pending record whose
 * reserved money is accounted for and which any later attempt can settle.
 *
 * LIMITATION: if the app stops retrying, a pending withdrawal is only settled
 * when this user makes another withdrawal (we settle the user's other pending
 * withdrawals first), or by an external sweeper calling
 * settlePendingWithdrawals(). Until then the money is reserved, not lost.
 * Settling it automatically requires a background job, which this module
 * cannot schedule on its own.
 */
export async function withdraw(
  req: { requestId: string; userId: string; amount: number },
  ctx: Ctx,
): Promise<Outcome> {
  const { requestId, userId, amount } = req;
  const db = ctx.db;
  const key = withdrawalKey(userId, requestId);

  // If this request was already recorded, continue it using the stored amount.
  const existing = await db.get<WithdrawalRecord>(key);
  if (existing) return finish(existing, ctx);

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    // Invalid amount: nothing changed.
    return "rejected";
  }

  // Best effort: settle older pending withdrawals first, so that refunds
  // from rejected payouts are applied before we check the balance.
  await settlePendingWithdrawals(userId, ctx, requestId).catch(() => undefined);

  const rec = await db.transaction<WithdrawalRecord>((tx) => {
    const cur = tx.get<WithdrawalRecord>(key);
    if (cur) return cur; // a concurrent attempt with the same requestId won
    const balance = tx.get<number>(walletKey(userId)) ?? 0;
    if (balance < amount) {
      const r: WithdrawalRecord = { userId, requestId, amount, status: "insufficient_funds" };
      tx.set(key, r);
      return r;
    }
    tx.set(walletKey(userId), balance - amount);
    const r: WithdrawalRecord = { userId, requestId, amount, status: "pending" };
    tx.set(key, r);
    const pending = tx.get<string[]>(pendingKey(userId)) ?? [];
    if (!pending.includes(requestId)) tx.set(pendingKey(userId), [...pending, requestId]);
    return r;
  });

  return finish(rec, ctx);
}

async function finish(rec: WithdrawalRecord, ctx: Ctx): Promise<Outcome> {
  if (rec.status !== "pending") return rec.status;
  return completePending(rec, ctx);
}

/** Pays out a pending withdrawal and settles its record. Throws on transient errors. */
async function completePending(rec: WithdrawalRecord, ctx: Ctx): Promise<Outcome> {
  const db = ctx.db;
  const key = withdrawalKey(rec.userId, rec.requestId);
  let payoutId: string;
  try {
    const payout = await ctx.payco.createPayout({
      amount: rec.amount,
      currency: "EUR",
      destination: rec.userId,
      idempotencyKey: payoutIdemKey(rec.userId, rec.requestId),
    });
    payoutId = payout.id;
  } catch (err: any) {
    if (err && err.code === "payout_rejected") {
      // No money moved. Refund the reservation exactly once.
      const r = await db.transaction<WithdrawalRecord | undefined>((tx) => {
        const cur = tx.get<WithdrawalRecord>(key);
        if (!cur || cur.status !== "pending") return cur;
        const balance = tx.get<number>(walletKey(rec.userId)) ?? 0;
        tx.set(walletKey(rec.userId), balance + cur.amount);
        const updated: WithdrawalRecord = { ...cur, status: "rejected" };
        tx.set(key, updated);
        removePending(tx, rec.userId, rec.requestId);
        return updated;
      });
      return outcomeOf(r);
    }
    // timeout / unknown: the payout may or may not have happened. Keep the
    // money reserved and let the retry repeat the idempotent call.
    throw err;
  }

  const r = await db.transaction<WithdrawalRecord | undefined>((tx) => {
    const cur = tx.get<WithdrawalRecord>(key);
    if (!cur || cur.status !== "pending") return cur;
    const updated: WithdrawalRecord = { ...cur, status: "paid_out", payoutId };
    tx.set(key, updated);
    removePending(tx, rec.userId, rec.requestId);
    return updated;
  });
  return outcomeOf(r);
}

function outcomeOf(r: WithdrawalRecord | undefined): Outcome {
  if (!r || r.status === "pending") {
    // Should not happen; surface as an error so the caller retries.
    const e: any = new Error("withdrawal in inconsistent state");
    e.code = "internal";
    throw e;
  }
  return r.status;
}

function removePending(tx: Tx, userId: string, requestId: string): void {
  const pending = tx.get<string[]>(pendingKey(userId)) ?? [];
  const next = pending.filter((id) => id !== requestId);
  if (next.length) tx.set(pendingKey(userId), next);
  else tx.delete(pendingKey(userId));
}

/**
 * Settles a user's pending withdrawals. It is safe to call at any time, from
 * any instance, as often as wanted. Intended for use by a periodic sweeper
 * as well.
 */
export async function settlePendingWithdrawals(
  userId: string,
  ctx: Ctx,
  skipRequestId?: string,
): Promise<void> {
  const pending = (await ctx.db.get<string[]>(pendingKey(userId))) ?? [];
  for (const id of pending) {
    if (id === skipRequestId) continue;
    try {
      const rec = await ctx.db.get<WithdrawalRecord>(withdrawalKey(userId, id));
      if (!rec) {
        await ctx.db.transaction((tx) => removePending(tx, userId, id));
        continue;
      }
      if (rec.status === "pending") await completePending(rec, ctx);
      else await ctx.db.transaction((tx) => removePending(tx, userId, id));
    } catch {
      // Transient failure: leave it pending for a later attempt.
    }
  }
}
