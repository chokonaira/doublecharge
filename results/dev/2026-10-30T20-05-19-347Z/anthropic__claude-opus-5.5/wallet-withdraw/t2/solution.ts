// Wallet withdrawal.
//
// Design:
//   1. In ONE Db transaction: check the balance, debit the wallet, and store a
//      "pending" withdrawal record keyed by requestId. The record is also added
//      to a per-user list of pending withdrawals. Funds are reserved before any
//      money moves, so concurrent withdrawals cannot overdraw the wallet.
//   2. Call PayCo createPayout with idempotencyKey derived from requestId and
//      with the parameters stored in the record. Any retry, from any instance,
//      either repeats the payout safely or gets back the recorded result.
//   3. In ONE Db transaction, settle the record exactly once:
//        - payout succeeded -> "paid_out"
//        - payout_rejected  -> credit the amount back, "rejected"
//      The pending -> final transition happens only once, so a refund can never
//      be applied twice.
//
// Crash safety: if an instance dies between steps, the record stays "pending"
// with the money reserved. A retry with the same requestId resumes at step 2.
// In addition, every withdraw call for a user first settles that user's other
// pending withdrawals. So if the app stopped retrying, the next withdrawal by
// that user finishes the abandoned one (pays it out, or refunds it if rejected).
//
// LIMITATION: if a request is abandoned mid-flight and the user never calls
// withdraw again, the reserved amount stays pending. It is neither paid out
// nor refunded until something calls settlePending for that user. The API
// gives us no background-job mechanism. A periodic sweeper that calls
// `settlePending` for every user with a non-empty pending list would close
// this gap. Money is never lost or created: it is always in exactly one of
// wallet / pending reservation / paid out.

type Result = "paid_out" | "insufficient_funds" | "rejected";

interface WithdrawalRecord {
  userId: string;
  amount: number;
  status: "pending" | Result;
  payoutId?: string;
}

const walletKey = (userId: string) => `wallet:${userId}`;
const recordKey = (requestId: string) => `withdrawal:${requestId}`;
const pendingKey = (userId: string) => `pending_withdrawals:${userId}`;
const payoutIdemKey = (requestId: string) => `wallet-withdrawal:${requestId}`;

function errCode(e: unknown): string | undefined {
  if (e && typeof e === "object" && "code" in e) {
    const c = (e as { code: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

/** Performs/resumes the payout for a pending record and settles it exactly once. */
async function settle(requestId: string, ctx: Ctx): Promise<Result> {
  const rec = await ctx.db.get<WithdrawalRecord>(recordKey(requestId));
  if (!rec) throw Object.assign(new Error("unknown withdrawal"), { code: "not_found" });
  if (rec.status !== "pending") return rec.status;

  let outcome: { kind: "paid"; payoutId: string } | { kind: "rejected" };
  try {
    const payout = await ctx.payco.createPayout({
      amount: rec.amount,
      currency: "EUR",
      destination: rec.userId,
      idempotencyKey: payoutIdemKey(requestId),
    });
    outcome = { kind: "paid", payoutId: payout.id };
  } catch (e) {
    if (errCode(e) === "payout_rejected") {
      outcome = { kind: "rejected" };
    } else {
      // timeout or unknown error: the outcome is uncertain. Leave the record
      // pending with funds reserved. A retry will resume safely with the same key.
      throw e;
    }
  }

  return ctx.db.transaction<Result>((tx) => {
    const cur = tx.get<WithdrawalRecord>(recordKey(requestId));
    if (!cur) throw new Error("withdrawal record vanished");
    if (cur.status !== "pending") return cur.status; // someone else settled it

    const pend = (tx.get<string[]>(pendingKey(cur.userId)) ?? []).filter((r) => r !== requestId);
    if (pend.length) tx.set(pendingKey(cur.userId), pend);
    else tx.delete(pendingKey(cur.userId));

    if (outcome.kind === "paid") {
      tx.set<WithdrawalRecord>(recordKey(requestId), {
        ...cur,
        status: "paid_out",
        payoutId: outcome.payoutId,
      });
      return "paid_out";
    }
    const bal = tx.get<number>(walletKey(cur.userId)) ?? 0;
    tx.set<number>(walletKey(cur.userId), bal + cur.amount);
    tx.set<WithdrawalRecord>(recordKey(requestId), { ...cur, status: "rejected" });
    return "rejected";
  });
}

/** Best-effort completion of a user's abandoned withdrawals. */
export async function settlePending(userId: string, ctx: Ctx, exceptRequestId?: string): Promise<void> {
  const pend = (await ctx.db.get<string[]>(pendingKey(userId))) ?? [];
  for (const rid of pend.slice(0, 20)) {
    if (rid === exceptRequestId) continue;
    try {
      await settle(rid, ctx);
    } catch {
      // Still uncertain (e.g. timeout). Leave it for a later attempt.
    }
  }
}

export async function withdraw(
  req: { requestId: string; userId: string; amount: number },
  ctx: Ctx,
): Promise<Result> {
  const { requestId, userId, amount } = req;

  // Finish any abandoned withdrawals for this user first.
  await settlePending(userId, ctx, requestId);

  const validAmount = Number.isSafeInteger(amount) && amount > 0;

  const step = await ctx.db.transaction<Result | "pending">((tx) => {
    const existing = tx.get<WithdrawalRecord>(recordKey(requestId));
    if (existing) return existing.status; // retry: reuse the stored params/result

    if (!validAmount) return "rejected"; // nothing changed, nothing recorded

    const bal = tx.get<number>(walletKey(userId)) ?? 0;
    if (bal < amount) {
      // Store the result so retries stay consistent. The wallet is untouched.
      tx.set<WithdrawalRecord>(recordKey(requestId), { userId, amount, status: "insufficient_funds" });
      return "insufficient_funds";
    }

    tx.set<number>(walletKey(userId), bal - amount);
    tx.set<WithdrawalRecord>(recordKey(requestId), { userId, amount, status: "pending" });
    const pend = tx.get<string[]>(pendingKey(userId)) ?? [];
    if (!pend.includes(requestId)) tx.set(pendingKey(userId), [...pend, requestId]);
    return "pending";
  });

  if (step !== "pending") return step;
  return settle(requestId, ctx);
}
