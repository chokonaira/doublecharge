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

type Result = "paid_out" | "insufficient_funds" | "rejected";

interface Withdrawal {
  userId: string;
  amount: number;
  payoutKey: string;
  status: "pending" | "paid_out" | "rejected";
  payoutId?: string;
}

function errorCode(error: unknown): unknown {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code: unknown }).code;
  }
  return undefined;
}

function balanceOf(tx: Tx, userId: string): number {
  const value = tx.get<number>(`wallet:${userId}`);
  // A missing wallet has no available funds.
  if (value === undefined) return 0;

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Wallet balance must be a nonnegative safe integer");
  }
  return value;
}

/**
 * Reserves funds atomically, then performs an idempotent payout.
 *
 * LIMITATION: Db and PayCo cannot be committed atomically. If this process dies
 * after reserving funds and nobody retries, the reservation can remain pending
 * indefinitely—even if PayCo has already paid or rejected it. Fully guaranteeing
 * the requested final-balance invariant for abandoned requests requires an
 * independent, durable recovery worker, which this runtime does not provide.
 * The record below preserves the information such a worker needs. Never refund
 * an uncertain payout: a timeout does not establish that no money moved.
 *
 * Other wallet writers must also use atomic updates/transactions rather than
 * stale read-then-set writes; otherwise no withdrawal implementation can prevent
 * those writers from overwriting a debit or refund.
 */
export async function withdraw(
  req: { requestId: string; userId: string; amount: number },
  ctx: Ctx,
): Promise<Result> {
  // Copy inputs before awaiting so callers cannot mutate an in-flight request.
  const { requestId, userId, amount } = req;

  if (typeof requestId !== "string" || requestId.length === 0) {
    throw new TypeError("requestId must be a nonempty string");
  }
  if (typeof userId !== "string" || userId.length === 0) {
    throw new TypeError("userId must be a nonempty string");
  }
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new RangeError("amount must be a positive safe integer in euro cents");
  }

  const recordKey = `wallet-withdrawal:v1:${requestId}`;
  const walletKey = `wallet:${userId}`;

  const started = await ctx.db.transaction<
    Withdrawal | "insufficient_funds"
  >((tx) => {
    const existing = tx.get<Withdrawal>(recordKey);
    if (existing !== undefined) {
      if (existing.userId !== userId || existing.amount !== amount) {
        throw Object.assign(
          new Error("requestId is already bound to a different withdrawal"),
          { code: "idempotency_mismatch" },
        );
      }
      return existing;
    }

    const balance = balanceOf(tx, userId);
    if (balance < amount) {
      // Literally change nothing. A failed funds check does not claim the ID;
      // a later retry may succeed if funds have since arrived.
      return "insufficient_funds";
    }

    const record: Withdrawal = {
      userId,
      amount,
      // Reserve this namespace exclusively for this operation. The runtime
      // specifies no key length limit or idempotency retention expiration.
      payoutKey: `wallet-withdrawal:payout:v1:${requestId}`,
      status: "pending",
    };

    tx.set(walletKey, balance - amount);
    tx.set(recordKey, record);
    return record;
  });

  if (started === "insufficient_funds") return started;
  if (started.status !== "pending") return started.status;

  async function finish(
    outcome: "paid_out" | "rejected",
    payoutId?: string,
  ): Promise<"paid_out" | "rejected"> {
    return ctx.db.transaction((tx) => {
      const current = tx.get<Withdrawal>(recordKey);
      if (
        current === undefined ||
        current.userId !== userId ||
        current.amount !== amount ||
        current.payoutKey !== started.payoutKey
      ) {
        throw new Error("Withdrawal record is missing or inconsistent");
      }

      if (current.status !== "pending") {
        if (current.status !== outcome) {
          throw new Error("Conflicting PayCo outcomes for the same payout key");
        }
        return current.status;
      }

      if (outcome === "rejected") {
        const refundedBalance = balanceOf(tx, userId) + current.amount;
        if (!Number.isSafeInteger(refundedBalance)) {
          // Leave the reservation pending rather than silently lose precision.
          throw new RangeError("Refund would exceed safe wallet precision");
        }
        tx.set(walletKey, refundedBalance);
      }

      tx.set<Withdrawal>(recordKey, {
        ...current,
        status: outcome,
        ...(payoutId === undefined ? {} : { payoutId }),
      });
      return outcome;
    });
  }

  let payout: Payout;
  try {
    // Concurrent callers and crash retries use exactly the same parameters/key.
    payout = await ctx.payco.createPayout({
      amount: started.amount,
      currency: "EUR",
      destination: started.userId,
      idempotencyKey: started.payoutKey,
    });
  } catch (error: unknown) {
    if (errorCode(error) === "payout_rejected") {
      // Refund and terminal status are committed together, exactly once.
      return finish("rejected");
    }

    // Timeout, idempotency mismatch, and unknown errors are not proof that
    // no payout happened. Retain the reservation and let the caller retry.
    throw error;
  }

  // Do not include this DB call in the PayCo error handler: a database failure
  // after a successful payout must never be mistaken for payout rejection.
  return finish("paid_out", payout.id);
}
