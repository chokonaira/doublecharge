// Withdrawal flow:
//
// 1. Reserve. One Db transaction records the withdrawal under
//    `withdrawal:<userId>:<requestId>` and debits the wallet. If funds are
//    short, it records "insufficient_funds" and leaves the wallet alone.
//    Because the debit and the record are written together, a retry or a
//    concurrent duplicate request can never debit the wallet twice.
//
// 2. Payout. Call PayCo with an idempotency key derived from the withdrawal
//    record, using the amount stored in the record. Repeating this call
//    (retries, other instances, the reconciliation job) never pays out twice.
//
// 3. Finalise. A transaction that only acts if the record is still "pending":
//    - payout succeeded -> mark "paid_out"
//    - payout_rejected  -> credit the wallet back and mark "rejected"
//    This guard means the money is put back at most once.
//
// If PayCo keeps timing out, or any other error happens, the record stays
// "pending" with the money reserved. We throw. The client retry or the
// reconciliation job then runs `withdraw` again with the same requestId, and
// that run resumes at step 2. Retrying after a timeout with the same key is
// safe. Money is therefore never created or lost, though the funds stay
// reserved until a retry completes the request.

type WithdrawResult = "paid_out" | "insufficient_funds" | "rejected";

interface WithdrawalRecord {
  userId: string;
  requestId: string;
  amount: number;
  state: "pending" | "paid_out" | "rejected" | "insufficient_funds";
  payoutId?: string;
  createdAt: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function errCode(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : undefined;
}

export async function withdraw(
  req: { requestId: string; userId: string; amount: number },
  ctx: Ctx,
): Promise<WithdrawResult> {
  const { requestId, userId, amount } = req;
  const walletKey = `wallet:${userId}`;
  const recordKey = `withdrawal:${userId}:${requestId}`;
  const idempotencyKey = `withdrawal:${userId}:${requestId}`;

  // Step 1: create the record and reserve the funds atomically.
  // If the record already exists, return it unchanged.
  const record = await ctx.db.transaction<WithdrawalRecord>((tx) => {
    const existing = tx.get<WithdrawalRecord>(recordKey);
    if (existing) return existing;

    const balance = tx.get<number>(walletKey) ?? 0;
    const rec: WithdrawalRecord = {
      userId,
      requestId,
      amount,
      state: balance < amount ? "insufficient_funds" : "pending",
      createdAt: Date.now(),
    };
    if (rec.state === "pending") {
      tx.set<number>(walletKey, balance - amount);
    }
    tx.set<WithdrawalRecord>(recordKey, rec);
    return rec;
  });

  if (record.state !== "pending") return record.state;

  // Step 2: pay out. The amount comes from the record, so the parameters
  // always match the first attempt.
  let payoutId: string | undefined;
  let rejected = false;
  const maxAttempts = 4;
  for (let attempt = 1; ; attempt++) {
    try {
      const payout = await ctx.payco.createPayout({
        amount: record.amount,
        currency: "EUR",
        destination: userId,
        idempotencyKey,
      });
      payoutId = payout.id;
      break;
    } catch (e) {
      const code = errCode(e);
      if (code === "payout_rejected") {
        rejected = true;
        break;
      }
      if (code === "timeout" && attempt < maxAttempts) {
        // Safe: a timed-out request is either processed now or replayed.
        await sleep(200 * 2 ** (attempt - 1));
        continue;
      }
      // Outcome unknown, or an unexpected error. Leave the record "pending"
      // with funds reserved. A retry with the same requestId resumes here.
      throw e;
    }
  }

  // Step 3: finalise. This acts at most once across all instances.
  const final = await ctx.db.transaction<WithdrawalRecord>((tx) => {
    const cur = tx.get<WithdrawalRecord>(recordKey);
    if (!cur) {
      // Should be impossible: records are never deleted by this module.
      throw Object.assign(new Error("withdrawal record missing"), { code: "record_missing" });
    }
    if (cur.state !== "pending") return cur;

    if (rejected) {
      const balance = tx.get<number>(walletKey) ?? 0;
      tx.set<number>(walletKey, balance + cur.amount);
      const next: WithdrawalRecord = { ...cur, state: "rejected" };
      tx.set<WithdrawalRecord>(recordKey, next);
      return next;
    }
    const next: WithdrawalRecord = { ...cur, state: "paid_out", payoutId };
    tx.set<WithdrawalRecord>(recordKey, next);
    return next;
  });

  return final.state as WithdrawResult;
}
