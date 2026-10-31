// Withdrawal flow (crash-safe, retry-safe, safe under concurrency):
//
// 1. Reserve: in one atomic Db transaction, create the record
//    `withdrawal:<userId>:<requestId>` and debit the wallet. If the balance is
//    too low, record "insufficient_funds" and leave the wallet unchanged.
//    Taking the money off before paying out means concurrent withdrawals can
//    never spend the same euros twice.
// 2. Pay out with a deterministic idempotency key derived from the request.
//    A retry after a crash or timeout repeats the call with the same key.
//    PayCo then either performs the payout once or replays its first result,
//    including a payout_rejected error.
// 3. Finalise: in one atomic transaction, move the record from "reserved" to
//    "paid_out", or, if rejected, to "rejected" and give the money back.
//    A guard on the current state makes this step happen at most once.
//
// If PayCo times out (or any other unexpected error occurs), we rethrow and
// the record stays "reserved". The caller's retry, or the reconciliation job,
// re-enters at step 2. Limitation: until then, the reserved amount is held
// off the wallet. That is safe (no money is created or lost), but the user
// does not see the funds while the request is unfinished.

type WithdrawalState = "reserved" | "paid_out" | "rejected" | "insufficient_funds";

interface WithdrawalRecord {
  userId: string;
  amount: number;
  state: WithdrawalState;
  payoutId?: string;
}

export async function withdraw(
  req: { requestId: string; userId: string; amount: number },
  ctx: Ctx,
): Promise<"paid_out" | "insufficient_funds" | "rejected"> {
  const { db, payco } = ctx;
  const walletKey = `wallet:${req.userId}`;
  const recordKey = `withdrawal:${req.userId}:${req.requestId}`;

  // Step 1: reserve the funds atomically, or read the existing record.
  const record = await db.transaction<WithdrawalRecord>((tx) => {
    const existing = tx.get<WithdrawalRecord>(recordKey);
    if (existing) return existing;

    const balance = tx.get<number>(walletKey) ?? 0;
    if (balance < req.amount) {
      const r: WithdrawalRecord = { userId: req.userId, amount: req.amount, state: "insufficient_funds" };
      tx.set(recordKey, r);
      return r;
    }

    tx.set(walletKey, balance - req.amount);
    const r: WithdrawalRecord = { userId: req.userId, amount: req.amount, state: "reserved" };
    tx.set(recordKey, r);
    return r;
  });

  if (record.state !== "reserved") return record.state;

  // Step 2: pay out. The recorded amount is authoritative, so a retry always
  // sends the same parameters under the same key.
  let payoutId: string;
  try {
    const payout = await payco.createPayout({
      amount: record.amount,
      currency: "EUR",
      destination: record.userId,
      idempotencyKey: `withdrawal:${record.userId}:${req.requestId}`,
    });
    payoutId = payout.id;
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "payout_rejected") {
      // No money moved: return the reservation to the wallet exactly once.
      const final = await db.transaction<WithdrawalState>((tx) => {
        const cur = tx.get<WithdrawalRecord>(recordKey);
        if (!cur || cur.state !== "reserved") return cur ? cur.state : "rejected";
        const balance = tx.get<number>(walletKey) ?? 0;
        tx.set(walletKey, balance + cur.amount);
        tx.set(recordKey, { ...cur, state: "rejected" });
        return "rejected";
      });
      return final === "reserved" ? "rejected" : final;
    }
    // timeout, idempotency_mismatch or anything unexpected: the outcome is
    // unknown, so keep the reservation and let the retry resolve it.
    throw err;
  }

  // Step 3: mark the withdrawal as paid out. The wallet was already debited.
  const final = await db.transaction<WithdrawalState>((tx) => {
    const cur = tx.get<WithdrawalRecord>(recordKey);
    if (!cur) return "paid_out"; // should not happen; the payout succeeded
    if (cur.state !== "reserved") return cur.state;
    tx.set(recordKey, { ...cur, state: "paid_out", payoutId });
    return "paid_out";
  });
  return final === "reserved" ? "paid_out" : final;
}
