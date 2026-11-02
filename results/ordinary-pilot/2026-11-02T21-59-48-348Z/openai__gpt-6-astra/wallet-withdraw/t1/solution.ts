type Result = "paid_out" | "insufficient_funds" | "rejected";

interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

interface Ctx {
  db: {
    transaction<T>(fn: (tx: Tx) => T): Promise<T>;
  };
  payco: {
    createPayout(p: {
      amount: number;
      currency: string;
      destination: string;
      idempotencyKey?: string;
    }): Promise<{
      id: string;
      amount: number;
      currency: string;
      destination: string;
      created: number;
    }>;
  };
}

interface WithdrawalRecord {
  userId: string;
  amount: number;
  idempotencyKey: string;
  status: "pending" | Result;
  payoutId?: string;
}

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
}

function readBalance(tx: Tx, key: string): number {
  const balance = tx.get<number>(key) ?? 0;
  if (!Number.isSafeInteger(balance) || balance < 0) {
    throw failure("invalid_wallet_balance", "Wallet balance is not safe to modify.");
  }
  return balance;
}

/**
 * Reserves funds atomically, then uses a persistent PayCo idempotency key.
 *
 * Pending reservations survive crashes and are completed by client/job retries.
 * Timeout and unknown errors intentionally throw: neither success nor a refund
 * is safe until the payout's outcome is known.
 *
 * Receipts must not be deleted: they prevent old requests from executing again.
 * All wallet writers must use atomic updates/transactions. These APIs cannot
 * prevent another service from overwriting a balance using a stale plain set.
 */
export async function withdraw(
  req: { requestId: string; userId: string; amount: number },
  ctx: Ctx,
): Promise<Result> {
  const { requestId, userId, amount } = req;

  // JavaScript numbers cannot reliably account for cents beyond safe integers.
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw failure("invalid_amount", "Amount must be a positive safe integer.");
  }

  // Request IDs are globally scoped; a reused ID must identify the same request.
  const recordKey = `wallet-withdrawal:v1:${JSON.stringify(requestId)}`;
  const walletKey = `wallet:${userId}`;

  const record = await ctx.db.transaction<WithdrawalRecord>((tx) => {
    const existing = tx.get<WithdrawalRecord>(recordKey);
    if (existing !== undefined) {
      if (existing.userId !== userId || existing.amount !== amount) {
        throw failure(
          "request_id_mismatch",
          "This requestId already identifies a different withdrawal.",
        );
      }
      return existing;
    }

    const balance = readBalance(tx, walletKey);
    const next: WithdrawalRecord = {
      userId,
      amount,
      idempotencyKey: recordKey,
      status: balance < amount ? "insufficient_funds" : "pending",
    };

    if (next.status === "pending") {
      tx.set(walletKey, balance - amount);
    }

    // An insufficient-funds result changes no financial state. Keep only its
    // receipt so a lost response cannot turn a retry into a new withdrawal.
    tx.set(recordKey, next);
    return next;
  });

  if (record.status !== "pending") {
    return record.status;
  }

  let outcome: "paid_out" | "rejected";
  let payoutId: string | undefined;

  try {
    // Concurrent workers deliberately use the same key and exact parameters.
    // PayCo deduplicates the external effect; no expiring worker lock is needed.
    const payout = await ctx.payco.createPayout({
      amount: record.amount,
      currency: "EUR",
      destination: record.userId,
      idempotencyKey: record.idempotencyKey,
    });
    payoutId = payout.id;
    outcome = "paid_out";
  } catch (error: unknown) {
    if (errorCode(error) !== "payout_rejected") {
      // Includes timeout and idempotency_mismatch. Preserve the reservation:
      // these errors do not establish that refunding it is safe.
      throw error;
    }
    outcome = "rejected";
  }

  return ctx.db.transaction<Result>((tx) => {
    const current = tx.get<WithdrawalRecord>(recordKey);
    if (
      current === undefined ||
      current.userId !== record.userId ||
      current.amount !== record.amount ||
      current.idempotencyKey !== record.idempotencyKey
    ) {
      throw failure("withdrawal_state_corrupt", "Withdrawal receipt changed.");
    }

    if (current.status !== "pending") {
      if (current.status !== outcome) {
        throw failure(
          "withdrawal_state_conflict",
          "Stored outcome conflicts with PayCo's outcome.",
        );
      }
      return current.status;
    }

    if (outcome === "rejected") {
      // Add back to the CURRENT balance, never restore an old balance.
      // The refund and terminal receipt commit together, exactly once.
      const refundedBalance = readBalance(tx, walletKey) + current.amount;
      if (!Number.isSafeInteger(refundedBalance)) {
        throw failure("wallet_balance_overflow", "Refund exceeds safe integers.");
      }
      tx.set(walletKey, refundedBalance);
    }

    tx.set<WithdrawalRecord>(recordKey, {
      ...current,
      status: outcome,
      ...(payoutId === undefined ? {} : { payoutId }),
    });
    return outcome;
  });
}
