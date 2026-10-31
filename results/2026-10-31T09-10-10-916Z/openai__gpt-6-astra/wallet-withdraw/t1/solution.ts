type Outcome = "paid_out" | "insufficient_funds" | "rejected";

interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

interface Db {
  transaction<T>(fn: (tx: Tx) => T): Promise<T>;
}

interface Payout {
  id: string;
  amount: number;
  currency: string;
  destination: string;
  created: number;
}

interface PayCo {
  createPayout(p: {
    amount: number;
    currency: string;
    destination: string;
    idempotencyKey?: string;
  }): Promise<Payout>;
}

interface Ctx {
  db: Db;
  payco: PayCo;
}

interface Withdrawal {
  userId: string;
  amount: number;
  idempotencyKey: string;
  state: "pending" | Outcome;
  payoutId?: string;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code: unknown }).code
    : undefined;
}

function balance(tx: Tx, key: string): number {
  // A nonexistent wallet has no funds.
  const value = tx.get<number>(key) ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("invalid_wallet_balance", "Wallet balance must be nonnegative safe-integer cents.");
  }
  return value;
}

/**
 * Pending withdrawals have already reserved their funds by debiting the wallet.
 * Retries finish that reservation using the same durable PayCo idempotency key.
 *
 * As with any shared balance, other writers must use atomic updates/transactions:
 * no implementation can prevent an unrelated writer from blindly overwriting
 * the wallet with a stale value.
 */
export async function withdraw(
  req: { requestId: string; userId: string; amount: number },
  ctx: Ctx,
): Promise<"paid_out" | "insufficient_funds" | "rejected"> {
  if (
    typeof req.requestId !== "string" ||
    typeof req.userId !== "string" ||
    !Number.isSafeInteger(req.amount) ||
    req.amount < 1
  ) {
    fail("invalid_request", "Expected string identifiers and positive safe-integer cents.");
  }

  // Snapshot inputs before awaiting. JSON encoding preserves arbitrary string IDs.
  const { requestId, userId, amount } = req;
  const requestKey = `withdrawal:v1:${JSON.stringify(requestId)}`;
  const walletKey = `wallet:${userId}`;

  const withdrawal = await ctx.db.transaction<Withdrawal>((tx) => {
    const existing = tx.get<Withdrawal>(requestKey);
    if (existing !== undefined) {
      if (existing.userId !== userId || existing.amount !== amount) {
        fail("idempotency_mismatch", "requestId was already used with different parameters.");
      }
      return existing;
    }

    const currentBalance = balance(tx, walletKey);
    const record: Withdrawal = {
      userId,
      amount,
      idempotencyKey: requestKey,
      state: currentBalance < amount ? "insufficient_funds" : "pending",
    };

    if (record.state === "pending") {
      tx.set(walletKey, currentBalance - amount);
    }

    // Insufficient funds changes no money. Persist only the decision so a retry
    // cannot turn that same request into a new withdrawal after a later deposit.
    tx.set(requestKey, record);
    return record;
  });

  if (withdrawal.state !== "pending") {
    return withdrawal.state;
  }

  let payout: Payout;
  try {
    payout = await ctx.payco.createPayout({
      amount: withdrawal.amount,
      currency: "EUR",
      destination: withdrawal.userId,
      idempotencyKey: withdrawal.idempotencyKey,
    });
  } catch (error: unknown) {
    if (errorCode(error) !== "payout_rejected") {
      // Timeouts and unknown errors may have moved money. Never release the
      // reservation; throw so the caller/reconciler retries the identical payout.
      throw error;
    }

    return ctx.db.transaction<Outcome>((tx) => {
      const current = tx.get<Withdrawal>(requestKey);
      if (current === undefined) {
        fail("withdrawal_state_missing", "Durable withdrawal record is missing.");
      }
      if (current.state !== "pending") {
        return current.state;
      }

      const restoredBalance = balance(tx, walletKey) + current.amount;
      if (!Number.isSafeInteger(restoredBalance)) {
        // Keep the reservation rather than silently rounding money.
        fail("wallet_balance_overflow", "Refund exceeds safe-integer cents.");
      }

      // Refund and terminal status commit together, so concurrent retries cannot
      // refund twice, even if a previous transaction committed but lost its reply.
      tx.set(walletKey, restoredBalance);
      tx.set<Withdrawal>(requestKey, { ...current, state: "rejected" });
      return "rejected";
    });
  }

  return ctx.db.transaction<Outcome>((tx) => {
    const current = tx.get<Withdrawal>(requestKey);
    if (current === undefined) {
      fail("withdrawal_state_missing", "Durable withdrawal record is missing.");
    }
    if (current.state !== "pending") {
      return current.state;
    }

    // The wallet was debited before PayCo was called; do not debit it again.
    tx.set<Withdrawal>(requestKey, {
      ...current,
      state: "paid_out",
      payoutId: payout.id,
    });
    return "paid_out";
  });
}
