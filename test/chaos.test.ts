import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TASKS } from "../tasks/index.ts";
import { explore, replay, runScheduled } from "../src/chaos/explore.ts";
import { seededRandom } from "../src/chaos/rng.ts";

const walletTask = TASKS.find((t) => t.id === "wallet-withdraw")!;
const sameRequestTwice = walletTask.scenarios.find((s) => s.name === "same request sent twice at once")!;
const load = async (file: string) => (await import(`../tasks/wallet-withdraw/${file}`)) as Record<string, unknown>;

describe("seededRandom", () => {
  it("repeats the same sequence for the same seed", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
    assert.notEqual(seededRandom(1)(), seededRandom(2)());
  });
});

describe("chaos exploration", () => {
  it("arrival-order scheduling matches the default world", async () => {
    const reference = await load("reference.ts");
    for (const scenario of walletTask.scenarios) {
      const run = await runScheduled(scenario, reference, () => 0, 5000);
      assert.ok(run.outcome.pass, `${scenario.name}: ${run.outcome.detail}`);
    }
  });

  it("the reference survives random interleavings", async () => {
    const reference = await load("reference.ts");
    const result = await explore(sameRequestTwice, reference, { schedules: 40, seed: 1, timeoutMs: 5000 });
    assert.equal(result.failures, 0, result.finding?.detail);
  });

  it("finds, shrinks and replays a race that arrival order hides", async () => {
    const naive = await load("mutants/naive.ts");
    const inOrder = await runScheduled(sameRequestTwice, naive, () => 0, 5000);
    assert.ok(inOrder.outcome.pass, "the race should be invisible in arrival order");

    const result = await explore(sameRequestTwice, naive, { schedules: 60, seed: 1, timeoutMs: 5000 });
    assert.ok(result.failures > 0 && result.finding);
    assert.ok(result.finding.deviations <= 3, `shrunk to ${result.finding.deviations} deviations`);
    assert.ok(result.finding.trace.length > 0);

    const again = await runScheduled(sameRequestTwice, naive, replay(result.finding.choices), 5000);
    assert.equal(again.outcome.pass, false, "replaying the shrunk interleaving reproduces the failure");
    assert.equal(again.outcome.detail, result.finding.detail);
  });
});
