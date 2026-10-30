/*
 * Safety strategy: atomically reserve wallet funds and persist the withdrawal,
 * then use a stable PayCo idempotency key. Refund only on payout_rejected.
 *
 * Limitation: the full requirement is impossible if an instance dies and nobody
 * retries. A crash after reservation can leave funds reserved indefinitely, even
 * before PayCo has received the payout. The durable record permits recovery by
 * calling withdraw again with the original request, but these APIs provide no
 * autonomous recovery worker. Pending reservations must not expire: a payout
 * might already have succeeded. Guaranteed eventual completion requires a
 * durable job runner/reconciler outside this function.
 *
 * Other wallet writers must also use atomic updates/transactions; unconditional
 * stale overwrites by other services cannot be made safe by this function.
 */

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
  shipping: unknown;
}

type Result = "paid_out" | "insufficient_funds" | "rejected";

type Withdrawal = {
  userId: string;
  amount: number;
  idempotencyKey: string;
} & (
  | { status: "pending" }
  | { status: "paid_out"; payoutId: string }
  | { status: "rejected" }
);

function balanceOf(tx: Tx, key: string): number {
  // An absent wallet has no funds.
  const balance = tx.get<number>(key) ?? 0;
  if (!Number.isSafeInteger(balance) || balance < 0) {
    throw new Error(`Invalid wallet balance at ${key}`);
  }
  return balance;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function assertSameRequest(
  record: Withdrawal,
  userId: string,
  amount: number,
  idempotencyKey: string,
): void {
  if (
    record.userId !== userId ||
    record.amount !== amount ||
    record.idempotencyKey !== idempotencyKey
  ) {
    throw Object.assign(
      new Error("requestId was already used with different parameters"),
      { code: "idempotency_mismatch" },
    );
  }
}

export async function withdraw(
  req: { requestId: string; userId: string; amount: number },
  ctx: Ctx,
): Promise<"paid_out" | "insufficient_funds" | "rejected"> {
  // Snapshot parameters before any await.
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

  // Reserve this namespace exclusively for this withdrawal implementation.
  // requestId is globally scoped, not scoped separately to each user.
  const recordKey = `wallet-withdrawal:v1:${requestId}`;
  const idempotencyKey = recordKey;
  const walletKey = `wallet:${userId}`;

  const record = await ctx.db.transaction<Withdrawal | undefined>((tx) => {
    const existing = tx.get<Withdrawal>(recordKey);
    if (existing !== undefined) {
      assertSameRequest(existing, userId, amount, idempotencyKey);
      return existing;
    }

    const balance = balanceOf(tx, walletKey);
    if (balance < amount) {
      // Literally change nothing, including request bookkeeping. An attempt
      // that never reserves funds may recheck the balance on a later retry.
      return undefined;
    }

    const pending: Withdrawal = {
      userId,
      amount,
      idempotencyKey,
      status: "pending",
    };

    tx.set(walletKey, balance - amount);
    tx.set(recordKey, pending);
    return pending;
  });

  if (record === undefined) return "insufficient_funds";
  if (record.status !== "pending") return record.status;

  async function finish(
    outcome:
      | { status: "paid_out"; payoutId: string }
      | { status: "rejected" },
  ): Promise<Result> {
    return ctx.db.transaction<Result>((tx) => {
      const current = tx.get<Withdrawal>(recordKey);
      if (current === undefined) {
        throw new Error("Withdrawal reservation is missing");
      }
      assertSameRequest(current, userId, amount, idempotencyKey);

      if (current.status !== "pending") {
        if (
          current.status !== outcome.status ||
          (current.status === "paid_out" &&
            outcome.status === "paid_out" &&
            current.payoutId !== outcome.payoutId)
        ) {
          throw new Error("Conflicting PayCo outcomes for one idempotency key");
        }
        return current.status;
      }

      if (outcome.status === "rejected") {
        const balance = balanceOf(tx, walletKey);
        const refunded = balance + amount;
        if (!Number.isSafeInteger(refunded)) {
          // Leave the reservation intact rather than lose cents to rounding.
          throw new RangeError("Refund would exceed safe integer precision");
        }
        tx.set(walletKey, refunded);
      }

      // Settlement and any refund commit together, so concurrent retries
      // cannot refund twice or debit the wallet a second time.
      tx.set<Withdrawal>(recordKey, {
        userId,
        amount,
        idempotencyKey,
        ...outcome,
      });
      return outcome.status;
    });
  }

  let payout: Payout;
  try {
    // Concurrent retries may all call PayCo; its idempotency contract makes
    // them one payout. Never generate a replacement key on a retry.
    payout = await ctx.payco.createPayout({
      amount,
      currency: "EUR",
      destination: userId,
      idempotencyKey,
    });
  } catch (error: unknown) {
    if (hasCode(error, "payout_rejected")) {
      return finish({ status: "rejected" });
    }

    // Timeout, idempotency_mismatch, and unknown errors are not proof that
    // no money moved. Keep the reservation and propagate the error for retry.
    throw error;
  }

  if (
    typeof payout.id !== "string" ||
    payout.id.length === 0 ||
    payout.amount !== amount ||
    payout.currency !== "EUR" ||
    payout.destination !== userId
  ) {
    // Do not refund an anomalous response: a payout may have occurred.
    throw new Error("PayCo returned an inconsistent payout");
  }

  return finish({ status: "paid_out", payoutId: payout.id });
}
