// Wallet withdrawals: a lifecycle record per requestId, money reserved before the payout, released only on a definitive rejection.
import { errorCode, type Ctx } from "../../../src/world/index.ts";

type Result = "paid_out" | "insufficient_funds" | "rejected";

interface Withdrawal {
  status: "reserving" | "insufficient" | "reserved" | "paid_out" | "rejected";
}

const MAX_TRIES = 4;

export async function withdraw(req: { requestId: string; userId: string; amount: number }, ctx: Ctx): Promise<Result> {
  const key = `withdrawal:${req.requestId}`;
  const walletKey = `wallet:${req.userId}`;

  // Claim the request, then reserve. A retry that arrives while the first attempt is still reserving waits
  // for it below; the first attempt always finishes reserving in one Db call, so that wait is a few
  // milliseconds at most, and nothing can be reserved twice.
  if (await ctx.db.insertIfAbsent<Withdrawal>(key, { status: "reserving" })) {
    let reserved = false;
    // Take the money off the wallet first, atomically, so concurrent withdrawals cannot overdraw it.
    await ctx.db.update<number>(walletKey, (balance = 0) => {
      if (balance < req.amount) return balance;
      reserved = true;
      return balance - req.amount;
    });
    await ctx.db.set<Withdrawal>(key, { status: reserved ? "reserved" : "insufficient" });
    if (!reserved) return "insufficient_funds";
  }

  let record = await ctx.db.get<Withdrawal>(key);
  while (record?.status === "reserving") record = await ctx.db.get<Withdrawal>(key);
  if (record?.status === "insufficient") return "insufficient_funds";
  if (record?.status === "rejected") return "rejected";
  if (record?.status === "paid_out") return "paid_out";

  for (let tries = 1; ; tries++) {
    try {
      await ctx.payco.createPayout({ amount: req.amount, currency: "EUR", destination: req.userId, idempotencyKey: `withdrawal:${req.requestId}` });
      await ctx.db.update<Withdrawal>(key, () => ({ status: "paid_out" }));
      return "paid_out";
    } catch (err) {
      // Definitive: no money moved. Release the reservation exactly once.
      if (errorCode(err) === "payout_rejected") {
        let release = false;
        await ctx.db.update<Withdrawal>(key, (w) => {
          if (w?.status !== "reserved") return w!;
          release = true;
          return { status: "rejected" };
        });
        if (release) await ctx.db.update<number>(walletKey, (balance = 0) => balance + req.amount);
        return "rejected";
      }
      // A timeout is not a failure: the payout may have gone through. Keep the money reserved;
      // a retry with the same requestId reuses the idempotency key and settles it.
      if (errorCode(err) === "timeout" && tries < MAX_TRIES) continue;
      throw err;
    }
  }
}
