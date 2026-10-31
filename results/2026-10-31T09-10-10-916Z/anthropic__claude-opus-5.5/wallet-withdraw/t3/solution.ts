type WithdrawalStatus = "reserved" | "paid_out" | "insufficient_funds" | "rejected";

interface WithdrawalRecord {
  userId: string;
  amount: number;
  status: WithdrawalStatus;
  payoutId?: string;
}

function walletKey(userId: string): string {
  return `wallet:${userId}`;
}

function withdrawalKey(requestId: string): string {
  return `withdrawal:${requestId}`;
}

export async function withdraw(
  req: { requestId: string; userId: string; amount: number },
  ctx: Ctx,
): Promise<"paid_out" | "insufficient_funds" | "rejected"> {
  const { db, payco } = ctx;
  const wKey = withdrawalKey(req.requestId);

  // Step 1: atomically create the withdrawal record and reserve the funds,
  // or load the existing record if this requestId was seen before.
  const record = await db.transaction<WithdrawalRecord>((tx) => {
    const existing = tx.get<WithdrawalRecord>(wKey);
    if (existing) return existing;

    const balance = tx.get<number>(walletKey(req.userId)) ?? 0;
    if (balance < req.amount) {
      // The wallet is untouched. The outcome is stored so that retries
      // with the same requestId get a consistent answer.
      const rec: WithdrawalRecord = {
        userId: req.userId,
        amount: req.amount,
        status: "insufficient_funds",
      };
      tx.set(wKey, rec);
      return rec;
    }

    tx.set(walletKey(req.userId), balance - req.amount);
    const rec: WithdrawalRecord = {
      userId: req.userId,
      amount: req.amount,
      status: "reserved",
    };
    tx.set(wKey, rec);
    return rec;
  });

  if (record.userId !== req.userId || record.amount !== req.amount) {
    // The same requestId was reused with different parameters. Refuse rather
    // than move money based on ambiguous input.
    const err = new Error("requestId reused with different parameters") as Error & { code: string };
    err.code = "request_mismatch";
    throw err;
  }

  if (record.status !== "reserved") {
    return record.status;
  }

  // Step 2: perform the payout. The key and the parameters are always the
  // same, taken from the stored record. Retries after a crash or timeout are
  // therefore safe: PayCo performs the payout at most once.
  let payoutId: string;
  try {
    const payout = await payco.createPayout({
      amount: record.amount,
      currency: "EUR",
      destination: record.userId,
      idempotencyKey: `withdraw:${req.requestId}`,
    });
    payoutId = payout.id;
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (code === "payout_rejected") {
      // No money moved: release the reservation exactly once.
      return await db.transaction<"paid_out" | "insufficient_funds" | "rejected">((tx) => {
        const cur = tx.get<WithdrawalRecord>(wKey);
        if (!cur) throw new Error("withdrawal record vanished");
        if (cur.status !== "reserved") return cur.status as "paid_out" | "insufficient_funds" | "rejected";
        const balance = tx.get<number>(walletKey(cur.userId)) ?? 0;
        tx.set(walletKey(cur.userId), balance + cur.amount);
        tx.set(wKey, { ...cur, status: "rejected" });
        return "rejected";
      });
    }
    // timeout or unexpected error: the outcome is unknown. Keep the
    // reservation and let the caller or reconciliation retry with the same key.
    throw e;
  }

  // Step 3: mark the withdrawal as paid out. The money already left the
  // wallet in step 1. If we crash before this write, a retry re-sends the
  // payout with the same key, gets the recorded result and finishes here.
  const final = await db.update<WithdrawalRecord>(wKey, (cur) => {
    if (!cur) throw new Error("withdrawal record vanished");
    if (cur.status !== "reserved") return cur;
    return { ...cur, status: "paid_out", payoutId };
  });

  return final.status === "reserved" ? "paid_out" : (final.status as "paid_out" | "insufficient_funds" | "rejected");
}
