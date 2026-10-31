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
  userId: string;
  amount: number;
  state: "pending" | WithdrawResult;
  payoutId?: string;
}

/**
 * Reconciliation note:
 * We debit the wallet (`wallet:<userId>`) and record a `"pending"` state in a single atomic DB transaction
 * *before* calling `payco.createPayout`. This prevents double-spending across concurrent requests.
 *
 * Limitation: If an instance crashes while calling `createPayout` (or if `createPayout` times out) and
 * the user closes the app and never retries this `requestId`, the withdrawal record remains `"pending"`
 * and the funds remain reserved (debited from `wallet:<userId>`). Because PayCo provides no read/query API
 * for payouts (`getPayout` / `listPayouts`) and there is no background worker mechanism in the runtime,
 * recovery requires either a subsequent retry with the same `requestId` or an external sweep of `"pending"`
 * records. However, because we persist the pending record in `Db`, another request from the same user
 * will actively attempt to finalize any pending withdrawals recorded in the user's pending index before
 * evaluating the new withdrawal's balance check.
 */
export async function withdraw(
  req: { requestId: string; userId: string; amount: number },
  ctx: Ctx,
): Promise<WithdrawResult> {
  const { requestId, userId, amount } = req;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("Invalid withdrawal amount: must be a positive integer in cents");
  }

  // First, try to resolve any orphaned pending withdrawals for this user from earlier abandoned requests
  // (e.g. if the user closed the app during a timeout and later opened it to make a new request).
  await settleUserPendingWithdrawals(userId, requestId, ctx);

  const reqKey = `withdrawal:${requestId}`;
  const walletKey = `wallet:${userId}`;
  const userPendingKey = `wallet_pending:${userId}`;

  // Step 1: Atomically check idempotency and reserve funds from the wallet.
  const record = await ctx.db.transaction<WithdrawalRecord>((tx) => {
    const existing = tx.get<WithdrawalRecord>(reqKey);
    if (existing) {
      if (existing.userId !== userId || existing.amount !== amount) {
        const err = new Error("Idempotency key reused with different parameters") as Error & {
          code: string;
        };
        err.code = "idempotency_mismatch";
        throw err;
      }
      return existing;
    }

    const balance = tx.get<number>(walletKey) ?? 0;
    if (balance < amount) {
      // Do not persist "insufficient_funds" permanently or if we do, return it.
      // Recording it ensures strict idempotency for the same requestId.
      const insufficientRec: WithdrawalRecord = {
        userId,
        amount,
        state: "insufficient_funds",
      };
      tx.set(reqKey, insufficientRec);
      return insufficientRec;
    }

    // Reserve funds by deducting from wallet immediately and recording pending state.
    tx.set(walletKey, balance - amount);
    const pendingRec: WithdrawalRecord = {
      userId,
      amount,
      state: "pending",
    };
    tx.set(reqKey, pendingRec);

    const pendingList = tx.get<string[]>(userPendingKey) ?? [];
    if (!pendingList.includes(requestId)) {
      pendingList.push(requestId);
      tx.set(userPendingKey, pendingList);
    }

    return pendingRec;
  });

  if (record.state !== "pending") {
    return record.state;
  }

  // Step 2: Execute payout with PayCo using requestId as the idempotency key, then finalize DB state.
  return await executeAndFinalizePayout(requestId, record, ctx);
}

async function executeAndFinalizePayout(
  requestId: string,
  record: WithdrawalRecord,
  ctx: Ctx,
): Promise<WithdrawResult> {
  const reqKey = `withdrawal:${requestId}`;
  const walletKey = `wallet:${record.userId}`;
  const userPendingKey = `wallet_pending:${record.userId}`;

  try {
    const payout = await ctx.payco.createPayout({
      amount: record.amount,
      currency: "EUR",
      destination: record.userId,
      idempotencyKey: requestId,
    });

    const finalRecord = await ctx.db.transaction<WithdrawalRecord>((tx) => {
      const current = tx.get<WithdrawalRecord>(reqKey);
      if (current && current.state !== "pending") {
        return current;
      }
      const updated: WithdrawalRecord = {
        userId: record.userId,
        amount: record.amount,
        state: "paid_out",
        payoutId: payout.id,
      };
      tx.set(reqKey, updated);
      removeFromPendingList(tx, userPendingKey, requestId);
      return updated;
    });

    return finalRecord.state as WithdrawResult;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;

    if (code === "payout_rejected") {
      // Bank rejected the payout; no money moved. Refund the reserved amount back to the wallet
      // atomically, only if this request is still in the "pending" state.
      const finalRecord = await ctx.db.transaction<WithdrawalRecord>((tx) => {
        const current = tx.get<WithdrawalRecord>(reqKey);
        if (!current || current.state !== "pending") {
          return (
            current ?? {
              userId: record.userId,
              amount: record.amount,
              state: "rejected",
            }
          );
        }

        const balance = tx.get<number>(walletKey) ?? 0;
        tx.set(walletKey, balance + record.amount);

        const updated: WithdrawalRecord = {
          userId: record.userId,
          amount: record.amount,
          state: "rejected",
        };
        tx.set(reqKey, updated);
        removeFromPendingList(tx, userPendingKey, requestId);
        return updated;
      });

      return finalRecord.state as WithdrawResult;
    }

    // For timeout or any other transient/unexpected error, leave state as "pending" and rethrow
    // so the caller retries or a subsequent request settles it.
    throw err;
  }
}

async function settleUserPendingWithdrawals(
  userId: string,
  currentRequestId: string,
  ctx: Ctx,
): Promise<void> {
  const userPendingKey = `wallet_pending:${userId}`;
  const pendingIds = await ctx.db.get<string[]>(userPendingKey);
  if (!pendingIds || pendingIds.length === 0) {
    return;
  }

  for (const pendingId of pendingIds) {
    if (pendingId === currentRequestId) continue;
    const rec = await ctx.db.get<WithdrawalRecord>(`withdrawal:${pendingId}`);
    if (rec && rec.state === "pending") {
      try {
        await executeAndFinalizePayout(pendingId, rec, ctx);
      } catch {
        // Ignore transient errors while opportunistically settling older requests
      }
    }
  }
}

function removeFromPendingList(tx: Tx, userPendingKey: string, requestId: string): void {
  const list = tx.get<string[]>(userPendingKey);
  if (!list) return;
  const filtered = list.filter((id) => id !== requestId);
  if (filtered.length === 0) {
    tx.delete(userPendingKey);
  } else {
    tx.set(userPendingKey, filtered);
  }
}
