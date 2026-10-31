type WithdrawalResult = "paid_out" | "insufficient_funds" | "rejected";

interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

interface Db {
  transaction<T>(fn: (tx: Tx) => T): Promise<T>;
}

interface PayCo {
  createPayout(p: {
    amount: number;
    currency: string;
    destination: string;
    idempotencyKey?: string;
  }): Promise<{ id: string }>;
}

interface Ctx {
  db: Db;
  payco: PayCo;
}

type Withdrawal = {
  requestId: string;
  userId: string;
  amount: number;
  idempotencyKey: string;
} & (
  | { state: "pending" }
  | { state: "paid_out"; payoutId: string }
  | { state: "insufficient_funds" | "rejected" }
);

function errorWithCode(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code: unknown }).code
    : undefined;
}

function readBalance(tx: Tx, key: string): number {
  // A missing wallet has no spendable funds.
  const balance = tx.get<number>(key) ?? 0;
  if (!Number.isSafeInteger(balance)) {
    throw errorWithCode("invalid_balance", "Wallet balance is not a safe integer.");
  }
  return balance;
}

/**
 * The debit is a durable reservation while the request is pending. Reconciliation
 * completes the payout or refunds that reservation after a definitive rejection.
 *
 * All other wallet writers must also use atomic updates/transactions: no
 * implementation can preserve money if another service overwrites this balance
 * using a stale read. Monetary arithmetic must stay within JS safe integers.
 *
 * Request records must be retained for as long as retries are possible. The
 * insufficient-funds path changes no wallet or external funds; it records only
 * the terminal answer so a lost response cannot become a new withdrawal later.
 */
export async function withdraw(
  req: { requestId: string; userId: string; amount: number },
  ctx: Ctx,
): Promise<WithdrawalResult> {
  // Copy inputs before awaiting so subsequent caller mutations cannot affect us.
  const { requestId, userId, amount } = req;

  if (
    typeof requestId !== "string" ||
    typeof userId !== "string" ||
    !Number.isSafeInteger(amount) ||
    amount < 1
  ) {
    throw errorWithCode("invalid_request", "Invalid withdrawal request.");
  }

  // Request IDs are global to this operation. Reusing one with different
  // parameters is an error, not permission to send another payout.
  const requestKey = `withdrawal:v1:${JSON.stringify(requestId)}`;
  const walletKey = `wallet:${userId}`;
  const idempotencyKey = `wallet-withdrawal:v1:${JSON.stringify(requestId)}`;

  const withdrawal = await ctx.db.transaction<Withdrawal>((tx) => {
    const existing = tx.get<Withdrawal>(requestKey);
    if (existing !== undefined) {
      if (
        existing.requestId !== requestId ||
        existing.userId !== userId ||
        existing.amount !== amount
      ) {
        throw errorWithCode(
          "request_conflict",
          "requestId was already used with different withdrawal parameters.",
        );
      }
      return existing;
    }

    const balance = readBalance(tx, walletKey);
    const base = { requestId, userId, amount, idempotencyKey };

    if (balance < amount) {
      const result: Withdrawal = { ...base, state: "insufficient_funds" };
      tx.set(requestKey, result);
      return result;
    }

    const pending: Withdrawal = { ...base, state: "pending" };
    // Reservation and request creation either both commit or neither commits.
    tx.set(walletKey, balance - amount);
    tx.set(requestKey, pending);
    return pending;
  });

  if (withdrawal.state !== "pending") {
    return withdrawal.state;
  }

  const finish = (
    outcome:
      | { state: "paid_out"; payoutId: string }
      | { state: "rejected" },
  ): Promise<WithdrawalResult> =>
    ctx.db.transaction((tx) => {
      const current = tx.get<Withdrawal>(requestKey);
      if (
        current === undefined ||
        current.requestId !== requestId ||
        current.userId !== userId ||
        current.amount !== amount ||
        current.idempotencyKey !== withdrawal.idempotencyKey
      ) {
        throw errorWithCode(
          "withdrawal_state_error",
          "Withdrawal record is missing or inconsistent.",
        );
      }

      if (current.state !== "pending") {
        if (current.state !== outcome.state) {
          throw errorWithCode(
            "withdrawal_state_error",
            "Conflicting terminal payout outcomes.",
          );
        }
        return current.state;
      }

      if (outcome.state === "rejected") {
        // Add to the current balance, never restore an old balance snapshot.
        const restored = readBalance(tx, walletKey) + amount;
        if (!Number.isSafeInteger(restored)) {
          throw errorWithCode(
            "balance_overflow",
            "Refund would exceed the safe integer range.",
          );
        }
        tx.set(walletKey, restored);
      }

      tx.set<Withdrawal>(requestKey, { ...current, ...outcome });
      return outcome.state;
    });

  let payout: { id: string };
  try {
    // Concurrent invocations and crash recovery all use identical parameters
    // and the same durable key. No process-local lock or lease is needed.
    payout = await ctx.payco.createPayout({
      amount: withdrawal.amount,
      currency: "EUR",
      destination: withdrawal.userId,
      idempotencyKey: withdrawal.idempotencyKey,
    });
  } catch (error: unknown) {
    if (errorCode(error) === "payout_rejected") {
      return finish({ state: "rejected" });
    }

    // Timeouts, mismatches and unexpected errors are not proof that no money
    // moved. Keep the reservation pending and throw for retry/reconciliation.
    throw error;
  }

  // If this commit fails or the process dies, retrying PayCo with the same key
  // recovers the original payout without sending money a second time.
  return finish({ state: "paid_out", payoutId: payout.id });
}
