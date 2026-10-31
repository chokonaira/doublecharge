// Types provided by the runtime
declare interface Ctx {
  db: Db;
  payco: PayCo;
  shipping: unknown;
}

declare interface Db {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  insertIfAbsent<T>(key: string, value: T): Promise<boolean>;
  update<T>(key: string, fn: (current: T | undefined) => T): Promise<T>;
  transaction<T>(fn: (tx: Tx) => T): Promise<T>;
  delete(key: string): Promise<void>;
}

declare interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
}

declare interface PayCo {
  createPayout(p: {
    amount: number;
    currency: string;
    destination: string;
    idempotencyKey?: string;
  }): Promise<Payout>;
}

declare interface Payout {
  id: string;
  amount: number;
  currency: string;
  destination: string;
  created: number;
}

type WithdrawResult = "paid_out" | "insufficient_funds" | "rejected";

interface WithdrawalRecord {
  status: "reserved" | WithdrawResult;
  userId: string;
  amount: number;
  payoutId?: string;
}

export async function withdraw(
  req: { requestId: string; userId: string; amount: number },
  ctx: Ctx,
): Promise<WithdrawResult> {
  const { requestId, userId, amount } = req;
  const withdrawalKey = `withdrawal:${requestId}`;
  const walletKey = `wallet:${userId}`;

  // Step 1: Atomically check idempotency and reserve funds from the wallet.
  // Reserving funds BEFORE calling PayCo guarantees we cannot overdraw the wallet
  // under concurrent requests or lose track of funds if the instance crashes mid-flight.
  const record = await ctx.db.transaction((tx): WithdrawalRecord => {
    const existing = tx.get<WithdrawalRecord>(withdrawalKey);
    if (existing !== undefined) {
      if (existing.userId !== userId || existing.amount !== amount) {
        const err = new Error("Request ID reused with different parameters") as Error & { code: string };
        err.code = "idempotency_mismatch";
        throw err;
      }
      return existing;
    }

    const balance = tx.get<number>(walletKey) ?? 0;
    if (balance < amount) {
      const insufficient: WithdrawalRecord = {
        status: "insufficient_funds",
        userId,
        amount,
      };
      // Record terminal state so retries with the same requestId return the same result
      // even if the user's balance later increases.
      tx.set(withdrawalKey, insufficient);
      return insufficient;
    }

    // Deduct/reserve the funds immediately
    tx.set(walletKey, balance - amount);
    const reserved: WithdrawalRecord = {
      status: "reserved",
      userId,
      amount,
    };
    tx.set(withdrawalKey, reserved);
    return reserved;
  });

  if (record.status !== "reserved") {
    return record.status;
  }

  // Step 2: Execute the payout with PayCo using requestId as the idempotency key.
  // If a previous attempt crashed during or after createPayout, PayCo will return
  // the exact same outcome (payout or error) without moving money twice.
  try {
    const payout = await ctx.payco.createPayout({
      amount,
      currency: "EUR",
      destination: userId,
      idempotencyKey: requestId,
    });

    // Step 3a: Mark withdrawal as paid_out.
    await ctx.db.set<WithdrawalRecord>(withdrawalKey, {
      status: "paid_out",
      userId,
      amount,
      payoutId: payout.id,
    });

    return "paid_out";
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;

    if (code === "payout_rejected") {
      // Step 3b: Payout was rejected by the bank. No money moved at PayCo.
      // Atomically refund the reserved money back to the wallet and transition state to "rejected".
      // Checking current.status === "reserved" inside the transaction prevents double-refunding
      // if two concurrent retries both receive "payout_rejected" from PayCo.
      await ctx.db.transaction((tx) => {
        const current = tx.get<WithdrawalRecord>(withdrawalKey);
        if (current && current.status === "reserved") {
          const balance = tx.get<number>(walletKey) ?? 0;
          tx.set(walletKey, balance + amount);
          tx.set<WithdrawalRecord>(withdrawalKey, {
            status: "rejected",
            userId,
            amount,
          });
        }
      });

      return "rejected";
    }

    // For transient errors (e.g., "timeout", network failures), leave the record in "reserved"
    // and rethrow so the caller or reconciliation job retries later.
    throw err;
  }
}
