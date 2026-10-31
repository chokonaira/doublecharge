type WithdrawalResult = "paid_out" | "insufficient_funds" | "rejected";

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
    }): Promise<{ id: string }>;
  };
}

interface Withdrawal {
  userId: string;
  amount: number;
  state: "pending" | WithdrawalResult;
  payoutId?: string;
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function readBalance(tx: Tx, key: string): number {
  // An absent wallet is treated as empty.
  const balance = tx.get<number>(key) ?? 0;
  if (!Number.isSafeInteger(balance)) {
    throw codedError("invalid_balance", "Wallet balance is not a safe integer.");
  }
  return balance;
}

/**
 * A pending record owns a reservation already deducted from the wallet.
 * Retries finish that reservation using the same permanent PayCo key.
 *
 * Journal records must not be deleted or expired: doing so would allow an old
 * request to debit again. Insufficient-funds results change only this journal,
 * not the wallet or PayCo, so their results also remain stable across retries.
 *
 * Other wallet writers must use atomic balance updates/transactions. These APIs
 * cannot protect a balance against another service overwriting it with a stale
 * value. Likewise, JS number arithmetic cannot safely represent arbitrary-sized
 * cent balances; unrepresentable amounts/balances fail without moving money.
 */
export async function withdraw(
  req: { requestId: string; userId: string; amount: number },
  ctx: Ctx,
): Promise<WithdrawalResult> {
  const { requestId, userId, amount } = req;

  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw codedError("invalid_amount", "Amount must be a positive safe integer.");
  }

  // Separate namespaces; request IDs are bound globally to their parameters.
  const recordKey = `wallet-withdrawal:v1:${requestId}`;
  const walletKey = `wallet:${userId}`;
  const idempotencyKey = `wallet-withdrawal-payout:v1:${requestId}`;

  const record = await ctx.db.transaction<Withdrawal>((tx) => {
    const existing = tx.get<Withdrawal>(recordKey);
    if (existing !== undefined) {
      if (existing.userId !== userId || existing.amount !== amount) {
        throw codedError(
          "idempotency_mismatch",
          "Withdrawal requestId was already used with different parameters.",
        );
      }
      return existing;
    }

    const balance = readBalance(tx, walletKey);
    const next: Withdrawal = {
      userId,
      amount,
      state: balance < amount ? "insufficient_funds" : "pending",
    };

    if (next.state === "pending") {
      // Reserve before contacting PayCo so concurrent withdrawals cannot
      // spend the same funds. The debit and recovery record commit together.
      tx.set(walletKey, balance - amount);
    }
    tx.set(recordKey, next);
    return next;
  });

  if (record.state !== "pending") {
    return record.state;
  }

  let outcome: "paid_out" | "rejected";
  let payoutId: string | undefined;

  try {
    const payout = await ctx.payco.createPayout({
      amount: record.amount,
      currency: "EUR",
      destination: record.userId,
      idempotencyKey,
    });
    payoutId = payout.id;
    outcome = "paid_out";
  } catch (error: unknown) {
    if (errorCode(error) !== "payout_rejected") {
      // Timeouts and unknown failures are NOT evidence that no money moved.
      // Keep the reservation; a caller/reconciliation retry safely replays
      // this exact payout, including after a crash following PayCo success.
      throw error;
    }
    outcome = "rejected";
  }

  return ctx.db.transaction<WithdrawalResult>((tx) => {
    const current = tx.get<Withdrawal>(recordKey);
    if (
      current === undefined ||
      current.userId !== userId ||
      current.amount !== amount
    ) {
      throw codedError(
        "withdrawal_state_corrupt",
        "Withdrawal recovery record is missing or inconsistent.",
      );
    }

    // Another concurrent retry may already have finalized this withdrawal.
    if (current.state !== "pending") {
      return current.state;
    }

    if (outcome === "rejected") {
      // Add to the CURRENT balance, never restore an old snapshot.
      const restoredBalance = readBalance(tx, walletKey) + current.amount;
      if (!Number.isSafeInteger(restoredBalance)) {
        throw codedError(
          "balance_overflow",
          "Refund would exceed safe integer precision.",
        );
      }
      tx.set(walletKey, restoredBalance);
      tx.set<Withdrawal>(recordKey, { ...current, state: "rejected" });
    } else {
      tx.set<Withdrawal>(recordKey, {
        ...current,
        state: "paid_out",
        payoutId,
      });
    }

    return outcome;
  });
}
