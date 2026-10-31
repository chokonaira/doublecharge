interface Ctx {
  db: Db;
  payco: PayCo;
  shipping: unknown;
}

interface Db {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  insertIfAbsent<T>(key: string, value: T): Promise<boolean>;
  update<T>(key: string, fn: (current: T | undefined) => T): Promise<T>;
  transaction<T>(fn: (tx: Tx) => T): Promise<T>;
  delete(key: string): Promise<void>;
}

interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
}

interface PayCo {
  createPayout(p: {
    amount: number;
    currency: string;
    destination: string;
    idempotencyKey?: string;
  }): Promise<Payout>;
}

interface Payout {
  id: string;
  amount: number;
  currency: string;
  destination: string;
  created: number;
}

type WithdrawResult = "paid_out" | "insufficient_funds" | "rejected";

interface WithdrawalRecord {
  requestId: string;
  userId: string;
  amount: number;
  status: "pending" | WithdrawResult;
  payoutId?: string;
}

/**
 * Reconciliation helper for any pending withdrawals belonging to the user.
 * If the client closes the app during a timeout or crash, a withdrawal might remain "pending".
 * Subsequent withdrawals for the same user will resolve those pending states before checking balance.
 *
 * Note on limitation: If a request crashes during `createPayout` and neither this user nor any system
 * process ever calls `withdraw` again, the reserved funds remain in a `pending` state in the DB
 * because there are no background workers/timers in the provided runtime. Deducting (reserving)
 * before calling PayCo is the safest approach to strictly prevent double-spending / overdrafts.
 */
async function reconcilePendingWithdrawals(userId: string, currentRequestId: string, ctx: Ctx): Promise<void> {
  const pendingKey = `user_pending_withdrawals:${userId}`;
  const pendingIds = (await ctx.db.get<string[]>(pendingKey)) ?? [];

  for (const reqId of pendingIds) {
    if (reqId === currentRequestId) continue;
    const record = await ctx.db.get<WithdrawalRecord>(`withdrawal:${reqId}`);
    if (!record || record.status !== "pending") {
      await removePendingId(ctx.db, pendingKey, reqId);
      continue;
    }

    try {
      await settlePendingWithdrawal(record, ctx);
    } catch {
      // If PayCo is still timing out or unavailable, leave it pending for now.
    }
  }
}

async function removePendingId(db: Db, pendingKey: string, requestId: string): Promise<void> {
  await db.update<string[]>(pendingKey, (list = []) => list.filter((id) => id !== requestId));
}

async function settlePendingWithdrawal(
  record: WithdrawalRecord,
  ctx: Ctx,
): Promise<WithdrawResult> {
  const reqKey = `withdrawal:${record.requestId}`;
  const walletKey = `wallet:${record.userId}`;
  const pendingKey = `user_pending_withdrawals:${record.userId}`;

  try {
    const payout = await ctx.payco.createPayout({
      amount: record.amount,
      currency: "EUR",
      destination: record.userId,
      idempotencyKey: `withdrawal:${record.requestId}`,
    });

    await ctx.db.transaction((tx) => {
      const current = tx.get<WithdrawalRecord>(reqKey);
      if (current && current.status === "pending") {
        tx.set<WithdrawalRecord>(reqKey, {
          ...current,
          status: "paid_out",
          payoutId: payout.id,
        });
      }
      const pendingList = tx.get<string[]>(pendingKey) ?? [];
      tx.set(
        pendingKey,
        pendingList.filter((id) => id !== record.requestId),
      );
    });

    return "paid_out";
  } catch (err: any) {
    if (err && err.code === "payout_rejected") {
      // Refund the reserved amount back to the user's wallet atomically
      await ctx.db.transaction((tx) => {
        const current = tx.get<WithdrawalRecord>(reqKey);
        if (current && current.status === "pending") {
          const balance = tx.get<number>(walletKey) ?? 0;
          tx.set<number>(walletKey, balance + current.amount);
          tx.set<WithdrawalRecord>(reqKey, {
            ...current,
            status: "rejected",
          });
        }
        const pendingList = tx.get<string[]>(pendingKey) ?? [];
        tx.set(
          pendingKey,
          pendingList.filter((id) => id !== record.requestId),
        );
      });

      return "rejected";
    }

    // For timeouts or unexpected errors, rethrow so the caller can retry.
    // The funds remain safely reserved and the record stays "pending".
    throw err;
  }
}

export async function withdraw(
  req: { requestId: string; userId: string; amount: number },
  ctx: Ctx,
): Promise<"paid_out" | "insufficient_funds" | "rejected"> {
  const { requestId, userId, amount } = req;

  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error("Invalid withdrawal amount");
  }

  // Opportunistically settle any abandoned pending withdrawals for this user
  // so their refunded funds (if rejected) become available.
  await reconcilePendingWithdrawals(userId, requestId, ctx);

  const reqKey = `withdrawal:${requestId}`;
  const walletKey = `wallet:${userId}`;
  const pendingKey = `user_pending_withdrawals:${userId}`;

  // Step 1: Atomically check idempotency and reserve funds from the wallet.
  const record = await ctx.db.transaction((tx): WithdrawalRecord => {
    const existing = tx.get<WithdrawalRecord>(reqKey);
    if (existing) {
      if (existing.userId !== userId || existing.amount !== amount) {
        const err = new Error("Idempotency key reused with different parameters") as Error & { code: string };
        err.code = "idempotency_mismatch";
        throw err;
      }
      return existing;
    }

    const balance = tx.get<number>(walletKey) ?? 0;
    if (balance < amount) {
      // Do not persist "insufficient_funds" or modify the wallet; requirements state
      // "change nothing" on insufficient funds. Or if retried with same requestId, re-evaluating is safe.
      return {
        requestId,
        userId,
        amount,
        status: "insufficient_funds",
      };
    }

    // Deduct/reserve funds immediately to prevent concurrent double-spending
    tx.set<number>(walletKey, balance - amount);

    const pendingRecord: WithdrawalRecord = {
      requestId,
      userId,
      amount,
      status: "pending",
    };
    tx.set<WithdrawalRecord>(reqKey, pendingRecord);

    const pendingList = tx.get<string[]>(pendingKey) ?? [];
    if (!pendingList.includes(requestId)) {
      tx.set<string[]>(pendingKey, [...pendingList, requestId]);
    }

    return pendingRecord;
  });

  // Step 2: If already terminal (or insufficient funds), return immediately.
  if (record.status !== "pending") {
    return record.status;
  }

  // Step 3: Execute the payout with PayCo using the deterministic idempotency key,
  // and finalize the transaction state.
  return await settlePendingWithdrawal(record, ctx);
}
