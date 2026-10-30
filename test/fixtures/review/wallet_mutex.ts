// Uses only non-atomic get/set; correctness comes from an in-process mutex, which does nothing
// once the service runs on more than one instance (the db is described as a remote store).
type Result = "paid_out" | "insufficient_funds" | "rejected";
const locks = new Map<string, Promise<void>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => mine);
  locks.set(key, chained);
  await prev;
  try { return await fn(); } finally { release(); if (locks.get(key) === chained) locks.delete(key); }
}
const code = (e: unknown) => (e as { code?: string })?.code;
export async function withdraw(req: { requestId: string; userId: string; amount: number }, ctx: any): Promise<Result> {
  return withLock(req.userId, async () => {
    const key = `withdrawal:${req.requestId}`;
    const rec = await ctx.db.get(key) as { status: string } | undefined;
    if (rec?.status === "paid_out" || rec?.status === "rejected") return rec.status as Result;
    if (rec?.status === "insufficient") return "insufficient_funds";
    if (!rec) {
      const balance = ((await ctx.db.get(`wallet:${req.userId}`)) as number | undefined) ?? 0;
      if (balance < req.amount) { await ctx.db.set(key, { status: "insufficient" }); return "insufficient_funds"; }
      await ctx.db.set(`wallet:${req.userId}`, balance - req.amount);
      await ctx.db.set(key, { status: "reserved" });
    }
    for (let i = 1; ; i++) {
      try {
        await ctx.payco.createPayout({ amount: req.amount, currency: "EUR", destination: req.userId, idempotencyKey: key });
        await ctx.db.set(key, { status: "paid_out" });
        return "paid_out";
      } catch (e) {
        if (code(e) === "payout_rejected") {
          const b = ((await ctx.db.get(`wallet:${req.userId}`)) as number | undefined) ?? 0;
          await ctx.db.set(`wallet:${req.userId}`, b + req.amount);
          await ctx.db.set(key, { status: "rejected" });
          return "rejected";
        }
        if (code(e) === "timeout" && i < 4) continue;
        throw e;
      }
    }
  });
}
