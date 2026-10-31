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

type WithdrawalResult = "paid_out" | "insufficient_funds" | "rejected";

interface WithdrawalRecord {
  status: "pending" | WithdrawalResult;
  userId: string;
  amount: number;
}

function isErrorWithCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  );
}

/**
 * Processes a user wallet withdrawal using a reserve-then-execute pattern:
 * 1. Atomically checks idempotency and reserves funds by deducting from `wallet:<userId>`
 *    and recording a `"pending"` state under `withdrawal:<requestId>`.
 * 2. Calls PayCo `createPayout` with `requestId` as the idempotency key.
 * 3. On payout success, marks the record `"paid_out"`.
 * 4. On `payout_rejected`, atomically refunds `wallet:<userId>` and marks the record `"rejected"`
 *    (only if the record is still `"pending"`, preventing double-refunds on concurrent retries).
 */
export async function withdraw(
  req: { requestId: string; userId: string; amount: number },
  ctx: Ctx,
): Promise<WithdrawalResult> {
  const { requestId, userId, amount } = req;
  const walletKey = `wallet:${userId}`;
  const reqKey = `withdrawal:${requestId}`;

  // Step 1: Atomically check existing request state or reserve funds from the wallet.
  const record = await ctx.db.transaction((tx) => {
    const existing = tx.get<WithdrawalRecord>(reqKey);
    if (existing !== undefined) {
      if (existing.userId !== userId || existing.amount !== amount) {
        const err = new Error("Request ID reused with different parameters") as Error & {
          code: string;
        };
        err.code = "idempotency_mismatch";
        throw err;
      }
      return existing;
    }

    const balance = tx.get<number>(walletKey) ?? 0;
    if (balance < amount) {
      const insufficientRecord: WithdrawalRecord = {
        status: "insufficient_funds",
        userId,
        amount,
      };
      tx.set(reqKey, insufficientRecord);
      return insufficientRecord;
    }

    // Reserve funds immediately so concurrent withdrawals cannot double-spend.
    tx.set(walletKey, balance - amount);
    const pendingRecord: WithdrawalRecord = {
      status: "pending",
      userId,
      amount,
    };
    tx.set(reqKey, pendingRecord);
    return pendingRecord;
  });

  if (record.status !== "pending") {
    return record.status;
  }

  // Step 2: Execute the payout with PayCo using requestId for idempotency.
  try {
    await ctx.payco.createPayout({
      amount,
      currency: "EUR",
      destination: userId,
      idempotencyKey: requestId,
    });
  } catch (err) {
    if (isErrorWithCode(err, "payout_rejected")) {
      // Step 3a: Payout was rejected by the bank. Refund the reserved amount atomically.
      return await ctx.db.transaction((tx) => {
        const current = tx.get<WithdrawalRecord>(reqKey);
        if (!current) {
          throw new Error(`Missing withdrawal record for ${requestId}`);
        }
        // Only refund if still pending (guards against concurrent requests both catching payout_rejected).
        if (current.status === "pending") {
          const balance = tx.get<number>(walletKey) ?? 0;
          tx.set(walletKey, balance + amount);
          tx.set<WithdrawalRecord>(reqKey, {
            ...current,
            status: "rejected",
          });
          return "rejected";
        }
        return current.status;
      });
    }

    // For timeouts or unexpected errors, rethrow without refunding.
    // The funds remain reserved while the outcome is uncertain; the caller/reconciliation job will retry.
    throw err;
  }

  // Step 3b: Payout succeeded. Mark withdrawal as paid_out.
  return await ctx.db.transaction((tx) => {
    const current = tx.get<WithdrawalRecord>(reqKey);
    if (!current) {
      throw new Error(`Missing withdrawal record for ${requestId}`);
    }
    if (current.status === "pending") {
      tx.set<WithdrawalRecord>(reqKey, {
        ...current,
        status: "paid_out",
      });
      return "paid_out";
    }
    return current.status;
  });
}
