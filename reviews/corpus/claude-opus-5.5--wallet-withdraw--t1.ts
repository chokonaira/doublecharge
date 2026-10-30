// Design notes
// ------------
// Each withdrawal moves through a durable record `withdrawal:<userId>:<requestId>`:
//
//   1. RESERVE (one atomic Db transaction): check balance, debit wallet, write the
//      record in state "reserved", add it to `withdrawals_pending:<userId>`.
//      Money in a reserved record is "in flight": not in the wallet, not yet paid out.
//   2. PAYOUT: createPayout with idempotencyKey derived from userId+requestId and the
//      parameters stored in the record. Retries / concurrent duplicates hit the same
//      PayCo operation, so at most one payout ever happens per withdrawal.
//   3. SETTLE (atomic): on success -> "paid_out"; on payout_rejected -> credit wallet
//      back, "rejected". Transitions happen only from "reserved", so settling twice is
//      harmless.
//
// If an instance dies between 1 and 3, the caller's retry (same requestId) resumes at
// step 2. A timeout is retried with the same key, which PayCo documents as safe.
//
// LIMITATION: if the app stops retrying (user closed it) while a record is still
// "reserved", the money stays held. To bound this, every withdraw() call first
// re-drives that user's pending withdrawals (best effort). A fully guaranteed resolution
// would need a background sweeper running settle() over all pending records. That
// cannot be done from inside this function alone. Note that the money is never lost,
// only held: the record says exactly what is in flight, and settle() is safe to run at
// any time from anywhere.

type Ctx = { db: any; payco: any; shipping: any };

type WithdrawalState = "reserved" | "paid_out" | "rejected";

interface WithdrawalRecord {
  userId: string;
  requestId: string;
  amount: number;
  state: WithdrawalState;
  payoutId?: string;
  createdAt: number;
}

type Result = "paid_out" | "insufficient_funds" | "rejected";

const walletKey = (userId: string) => `wallet:${userId}`;
const recordKey = (userId: string, requestId: string) =>
  `withdrawal:${userId}:${requestId}`;
const pendingKey = (userId: string) => `withdrawals_pending:${userId}`;
const payoutIdemKey = (userId: string, requestId: string) =>
  `withdrawal-payout:${userId}:${requestId}`;

const MAX_TIMEOUT_RETRIES = 2;
const MAX_SWEEP = 5;

function errCode(e: unknown): string | undefined {
  return e && typeof e === "object" && typeof (e as any).code === "string"
    ? (e as any).code
    : undefined;
}

async function finalize(
  ctx: Ctx,
  rec: WithdrawalRecord,
  outcome: "paid_out" | "rejected",
  payoutId?: string,
): Promise<WithdrawalState> {
  return ctx.db.transaction((tx: any) => {
    const key = recordKey(rec.userId, rec.requestId);
    const cur = tx.get(key) as WithdrawalRecord | undefined;
    if (!cur) throw new Error(`withdrawal record vanished: ${key}`);
    if (cur.state !== "reserved") return cur.state; // already settled elsewhere

    if (outcome === "rejected") {
      const bal = (tx.get(walletKey(cur.userId)) as number | undefined) ?? 0;
      tx.set(walletKey(cur.userId), bal + cur.amount);
    }
    tx.set(key, { ...cur, state: outcome, ...(payoutId ? { payoutId } : {}) });

    const pending = (tx.get(pendingKey(cur.userId)) as string[] | undefined) ?? [];
    const next = pending.filter((id) => id !== cur.requestId);
    if (next.length) tx.set(pendingKey(cur.userId), next);
    else tx.delete(pendingKey(cur.userId));
    return outcome;
  });
}

/** Drive a reserved withdrawal to a final state. Throws if PayCo stays unreachable. */
async function settle(ctx: Ctx, rec: WithdrawalRecord): Promise<WithdrawalState> {
  if (rec.state !== "reserved") return rec.state;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_TIMEOUT_RETRIES; attempt++) {
    try {
      const payout = await ctx.payco.createPayout({
        amount: rec.amount,
        currency: "EUR",
        destination: rec.userId,
        idempotencyKey: payoutIdemKey(rec.userId, rec.requestId),
      });
      return await finalize(ctx, rec, "paid_out", payout?.id);
    } catch (e) {
      const code = errCode(e);
      if (code === "payout_rejected") return await finalize(ctx, rec, "rejected");
      if (code === "timeout") {
        lastErr = e;
        continue; // same key: safe to retry
      }
      // Includes idempotency_mismatch (should be impossible: params come from the
      // record) and unknown errors. Leave reserved, so the money is held, not lost.
      throw e;
    }
  }
  throw lastErr; // still reserved; a caller retry resumes it
}

/** Best effort: re-drive other stuck withdrawals of this user. */
async function sweepPending(ctx: Ctx, userId: string, skip: string): Promise<void> {
  let pending: string[] | undefined;
  try {
    pending = await ctx.db.get(pendingKey(userId));
  } catch {
    return;
  }
  if (!pending?.length) return;
  for (const id of pending.filter((p) => p !== skip).slice(0, MAX_SWEEP)) {
    try {
      const rec = (await ctx.db.get(recordKey(userId, id))) as
        | WithdrawalRecord
        | undefined;
      if (rec && rec.state === "reserved") await settle(ctx, rec);
    } catch {
      // ignore; it will be retried later
    }
  }
}

export async function withdraw(
  req: { requestId: string; userId: string; amount: number },
  ctx: Ctx,
): Promise<Result> {
  const { requestId, userId, amount } = req;

  // Invalid input: change nothing.
  if (!Number.isSafeInteger(amount) || amount <= 0 || !userId || !requestId) {
    return "rejected";
  }

  await sweepPending(ctx, userId, requestId);

  const now = Date.now();
  const reserved = await ctx.db.transaction((tx: any) => {
    const key = recordKey(userId, requestId);
    const existing = tx.get(key) as WithdrawalRecord | undefined;
    if (existing) return { kind: "existing" as const, rec: existing };

    const bal = (tx.get(walletKey(userId)) as number | undefined) ?? 0;
    if (bal < amount) return { kind: "insufficient" as const };

    const rec: WithdrawalRecord = {
      userId,
      requestId,
      amount,
      state: "reserved",
      createdAt: now,
    };
    tx.set(walletKey(userId), bal - amount);
    tx.set(key, rec);
    const pending = (tx.get(pendingKey(userId)) as string[] | undefined) ?? [];
    if (!pending.includes(requestId)) tx.set(pendingKey(userId), [...pending, requestId]);
    return { kind: "reserved" as const, rec };
  });

  if (reserved.kind === "insufficient") return "insufficient_funds";

  // For a retry, the stored record (amount included) is authoritative.
  const state = await settle(ctx, reserved.rec);
  if (state === "paid_out") return "paid_out";
  if (state === "rejected") return "rejected";
  // settle() only returns final states or throws.
  throw Object.assign(new Error("withdrawal still pending"), { code: "pending" });
}
