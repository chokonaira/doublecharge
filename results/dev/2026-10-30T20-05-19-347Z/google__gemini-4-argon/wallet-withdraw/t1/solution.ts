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

type WithdrawOutcome = "paid_out" | "insufficient_funds" | "rejected";

interface WithdrawalRecord {
  status: "pending" | WithdrawOutcome;
  userId: string;
  amount: number;
  payoutId?: string;
}

/**
 * Settles an in-flight ("pending") withdrawal by calling PayCo with the request's
 * idempotency key and transitioning the DB state to a terminal outcome.
 *
 * Because PayCo is idempotent per `requestId` and the DB transition from "pending"
 * to a terminal state happens inside an atomic transaction, this function is safe
 * to call from the original request, from a retry, or when recovering an orphaned
 * withdrawal started by a client that stopped retrying.
 */
async function resolvePendingWithdrawal(
  requestId: string,
  record: WithdrawalRecord,
  ctx: Ctx,
): Promise<WithdrawOutcome> {
  const reqKey = `withdrawal:req:${requestId}`;
  const walletKey = `wallet:${record.userId}`;
  const pendingUserKey = `withdrawal:user_pending:${record.userId}`;

  try {
    const payout = await ctx.payco.createPayout({
      amount: record.amount,
      currency: "EUR",
      destination: record.userId,
      idempotencyKey: requestId,
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
      if (tx.get<string>(pendingUserKey) === requestId) {
        tx.delete(pendingUserKey);
      }
    });

    return "paid_out";
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "payout_rejected") {
      // The bank rejected the payout and no money moved.
      // Atomically refund the reserved balance and mark the request as rejected
      // so concurrent retries cannot double-refund.
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
        if (tx.get<string>(pendingUserKey) === requestId) {
          tx.delete(pendingUserKey);
        }
      });

      return "rejected";
    }

    // For transient errors (e.g., `timeout`) or unexpected failures, leave the
    // funds reserved in the `pending` state and rethrow so the caller can retry
    // or a subsequent request for this user can recover it.
    throw err;
  }
}

export async function withdraw(
  req: { requestId: string; userId: string; amount: number },
  ctx: Ctx,
): Promise<WithdrawOutcome> {
  const { requestId, userId, amount } = req;

  if (!Number.isInteger(amount) || amount < 0) {
    throw Object.assign(new Error("Invalid withdrawal amount"), { code: "invalid_amount" });
  }

  const reqKey = `withdrawal:req:${requestId}`;
  const walletKey = `wallet:${userId}`;
  const pendingUserKey = `withdrawal:user_pending:${userId}`;

  while (true) {
    const step = await ctx.db.transaction<
      | { action: "done"; status: WithdrawOutcome }
      | { action: "resolve"; targetRequestId: string; record: WithdrawalRecord }
    >((tx) => {
      // 1. Check if this requestId has already been seen.
      const existing = tx.get<WithdrawalRecord>(reqKey);
      if (existing) {
        if (existing.userId !== userId || existing.amount !== amount) {
          throw Object.assign(
            new Error("Idempotency key reused with different parameters"),
            { code: "idempotency_mismatch" },
          );
        }
        if (existing.status !== "pending") {
          return { action: "done", status: existing.status };
        }
        return { action: "resolve", targetRequestId: requestId, record: existing };
      }

      // 2. Check if the user has an orphaned/in-flight withdrawal from an earlier
      // request (e.g., the user closed the app after a crash/timeout). Settling it
      // first ensures any rejected payout is refunded before we check the balance.
      const priorPendingReqId = tx.get<string>(pendingUserKey);
      if (priorPendingReqId && priorPendingReqId !== requestId) {
        const priorRecord = tx.get<WithdrawalRecord>(`withdrawal:req:${priorPendingReqId}`);
        if (priorRecord && priorRecord.status === "pending") {
          return {
            action: "resolve",
            targetRequestId: priorPendingReqId,
            record: priorRecord,
          };
        }
        tx.delete(pendingUserKey);
      }

      // 3. Check balance and atomically reserve funds BEFORE calling PayCo.
      // If we didn't deduct first, two concurrent withdrawals could both pass the
      // balance check or a crash after PayCo payout would leave money paid out
      // without being deducted from the wallet.
      const balance = tx.get<number>(walletKey) ?? 0;
      if (balance < amount) {
        // Record the terminal result for idempotency on retries of this requestId.
        tx.set<WithdrawalRecord>(reqKey, {
          status: "insufficient_funds",
          userId,
          amount,
        });
        return { action: "done", status: "insufficient_funds" };
      }

      tx.set<number>(walletKey, balance - amount);
      const newRecord: WithdrawalRecord = {
        status: "pending",
        userId,
        amount,
      };
      tx.set<WithdrawalRecord>(reqKey, newRecord);
      tx.set<string>(pendingUserKey, requestId);

      return { action: "resolve", targetRequestId: requestId, record: newRecord };
    });

    if (step.action === "done") {
      return step.status;
    }

    const outcome = await resolvePendingWithdrawal(
      step.targetRequestId,
      step.record,
      ctx,
    );

    if (step.targetRequestId === requestId) {
      return outcome;
    }
    // If we just resolved an older orphaned request for this user, loop around
    // to execute the current `requestId`.
  }
}
