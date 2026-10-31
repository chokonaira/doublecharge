type WithdrawResult = "paid_out" | "insufficient_funds" | "rejected";

interface WithdrawalRecord {
  state: "reserved" | WithdrawResult;
  userId: string;
  amount: number;
}

const walletKey = (userId: string) => `wallet:${userId}`;
const recordKey = (requestId: string) => `withdrawal:${requestId}`;

export async function withdraw(
  req: { requestId: string; userId: string; amount: number },
  ctx: Ctx,
): Promise<WithdrawResult> {
  const { db, payco } = ctx;
  const rKey = recordKey(req.requestId);

  // Step 1: atomically either reuse the existing record, record insufficient
  // funds, or reserve (debit) the funds together with creating the record.
  // Reserving first means concurrent withdrawals can never overdraw the wallet,
  // and a crash after this point leaves a durable "reserved" record that the
  // retry/reconciliation will drive to completion.
  const record = await db.transaction<WithdrawalRecord>((tx) => {
    const existing = tx.get<WithdrawalRecord>(rKey);
    if (existing) return existing;

    const balance = tx.get<number>(walletKey(req.userId)) ?? 0;
    if (balance < req.amount) {
      const rec: WithdrawalRecord = { state: "insufficient_funds", userId: req.userId, amount: req.amount };
      tx.set(rKey, rec);
      return rec;
    }
    tx.set(walletKey(req.userId), balance - req.amount);
    const rec: WithdrawalRecord = { state: "reserved", userId: req.userId, amount: req.amount };
    tx.set(rKey, rec);
    return rec;
  });

  if (record.state !== "reserved") return record.state;

  // Step 2: pay out. Parameters come from the stored record so the idempotency
  // key is always reused with identical parameters; PayCo guarantees at most
  // one payout for this key no matter how many times / instances call this.
  const idempotencyKey = `withdraw:${req.requestId}`;
  let outcome: "paid_out" | "rejected";
  let attempt = 0;
  for (;;) {
    try {
      await payco.createPayout({
        amount: record.amount,
        currency: "EUR",
        destination: record.userId,
        idempotencyKey,
      });
      outcome = "paid_out";
      break;
    } catch (err: any) {
      const code = err?.code;
      if (code === "payout_rejected") {
        outcome = "rejected";
        break;
      }
      if (code === "timeout" && attempt < 2) {
        // Retrying a timed-out request with the same key is always safe.
        attempt++;
        continue;
      }
      // Unknown outcome (persistent timeout or other error): leave the record
      // "reserved" (funds held, not lost) and fail; the caller/reconciliation
      // retries with the same requestId and we resume here.
      throw err;
    }
  }

  // Step 3: finalize atomically. Only a "reserved" record can transition, so a
  // concurrent duplicate cannot refund twice.
  return db.transaction<WithdrawResult>((tx) => {
    const cur = tx.get<WithdrawalRecord>(rKey);
    if (!cur) {
      // Should not happen (records are never deleted); be safe and do nothing.
      return outcome;
    }
    if (cur.state !== "reserved") return cur.state;
    if (outcome === "rejected") {
      const balance = tx.get<number>(walletKey(cur.userId)) ?? 0;
      tx.set(walletKey(cur.userId), balance + cur.amount);
    }
    tx.set(rKey, { ...cur, state: outcome });
    return outcome;
  });
}
