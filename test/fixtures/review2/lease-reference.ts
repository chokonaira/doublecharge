// The checkout reference, unchanged, wrapped in a 30 s lease that waiting presses poll every 100 ms
// (the same constants as Gemini 4 Argon's checkout). The lease only reduces concurrency; the body is
// the reference, which is correct without it.
import { randomUUID } from "node:crypto";
import { checkout as body } from "../../../tasks/checkout/reference.ts";
import type { Ctx } from "../../../src/world/index.ts";
const TTL = 30_000;
const POLL = 100;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export async function checkout(orderId: string, ctx: Ctx): Promise<"paid" | "declined"> {
  const leaseKey = `lease:${orderId}`;
  const me = randomUUID();
  for (;;) {
    const now = Date.now();
    const got = await ctx.db.update<{ owner: string; until: number }>(leaseKey, (l) => (!l || l.until <= now ? { owner: me, until: now + TTL } : l));
    if (got.owner === me) break;
    await sleep(POLL);
  }
  try {
    return await body(orderId, ctx);
  } finally {
    await ctx.db.transaction((tx) => {
      if (tx.get<{ owner: string }>(leaseKey)?.owner === me) tx.delete(leaseKey);
    });
  }
}
