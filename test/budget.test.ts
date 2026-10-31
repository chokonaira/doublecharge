import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Budget } from "../src/models/budget.ts";

/** Runs `costs` as calls, `concurrency` at a time, like the eval and review commands; returns what ran. */
async function pool(budget: Budget, costs: number[], concurrency: number): Promise<number[]> {
  const ran: number[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let i = next++; i < costs.length; i = next++) {
        if (!(await budget.start())) continue;
        await budget.track(new Promise<{ cost: number }>((resolve) => setImmediate(() => resolve({ cost: costs[i]! }))));
        ran.push(i);
      }
    }),
  );
  return ran.sort((a, b) => a - b);
}

describe("budget", () => {
  it("waits for calls in flight instead of skipping on the first estimate", async () => {
    // Before any call returns, each is assumed to cost $0.50: six at once would "exceed" $1.50.
    assert.deepEqual(await pool(new Budget(1.5), Array(6).fill(0.01), 6), [0, 1, 2, 3, 4, 5]);
  });

  it("stops once money actually spent reaches the limit", async () => {
    assert.deepEqual(await pool(new Budget(1), [0.6, 0.6, 0.6], 1), [0, 1]);
  });

  it("bounds overshoot by the calls in flight, sized by the dearest call seen", async () => {
    const ran = await pool(new Budget(1), Array(20).fill(0.3), 4);
    assert.ok(ran.length >= 3 && ran.length <= 4, `ran ${ran.length}`);
  });

  it("frees the slot of a call that failed", async () => {
    const budget = new Budget(0.4);
    assert.ok(await budget.start());
    await assert.rejects(budget.track(Promise.reject(new Error("network"))));
    assert.ok(await budget.start());
  });
});
