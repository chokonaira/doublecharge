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
  payoutId?: string;
}

export async function withdraw(
  req: { requestId: string; userId: string; amount: number },
  ctx: Ctx,
): Promise<WithdrawalResult> {
  const { requestId, userId, amount } = req;
  const withdrawalKey = `withdrawal:${requestId}`;
  const walletKey = `wallet:${userId}`;

  // Step 1: Atomically check idempotency and reserve funds from the wallet.
  // Deducting funds BEFORE calling PayCo prevents concurrent requests from
  // double-spending the balance, and ensures funds are held while a payout is in flight.
  const record = await ctx.db.transaction((tx) => {
    const existing = tx.get<WithdrawalRecord>(withdrawalKey);
    if (existing) {
      if (existing.userId !== userId || existing.amount !== amount) {
        const err = new Error("Request ID already used with different parameters") as Error & { code: string };
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
      tx.set(withdrawalKey, insufficientRecord);
      return insufficientRecord;
    }

    // Reserve funds by deducting immediately
    tx.set(walletKey, balance - amount);
    const pendingRecord: WithdrawalRecord = {
      status: "pending",
      userId,
      amount,
    };
    tx.set(withdrawalKey, pendingRecord);
    return pendingRecord;
  });

  if (record.status !== "pending") {
    return record.status;
  }

  // Step 2: Execute the payout with PayCo using requestId as the idempotency key.
  // If a previous attempt crashed or timed out, PayCo will either execute it once
  // or return the cached outcome (including throwing `payout_rejected`).
  try {
    const payout = await ctx.payco.createPayout({
      amount,
      currency: "EUR",
      destination: userId,
      idempotencyKey: requestId,
    });

    // Step 3a: Payout succeeded. Mark withdrawal as paid_out.
    await ctx.db.transaction((tx) => {
      const current = tx.get<WithdrawalRecord>(withdrawalKey);
      if (current && current.status === "pending") {
        tx.set<WithdrawalRecord>(withdrawalKey, {
          ...current,
          status: "paid_out",
          payoutId: payout.id,
        });
      }
    });

    return "paid_out";
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;

    if (code === "payout_rejected") {
      // Step 3b: Payout was definitively rejected by the bank.
      // Refund the reserved amount back to the user's wallet atomically
      // alongside updating the record status so a concurrent retry cannot double-refund.
      await ctx.db.transaction((tx) => {
        const current = tx.get<WithdrawalRecord>(withdrawalKey);
        if (current && current.status === "pending") {
          const balance = tx.get<number>(walletKey) ?? 0;
          tx.set(walletKey, balance + amount);
          tx.set<WithdrawalRecord>(withdrawalKey, {
            ...current,
            status: "rejected",
          });
        }
      });

      return "rejected";
    }

    // For timeouts or any other transient failure, leave the status as "pending"
    // and keep the funds reserved. The caller or reconciliation job will retry.
    throw err;
  }
}
