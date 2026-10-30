import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { TASKS } from "../tasks/index.ts";
import { exploreCrashes } from "../src/chaos/crash.ts";
import { explore, replay, runScheduled } from "../src/chaos/explore.ts";
import { seededRandom } from "../src/chaos/rng.ts";
import { compileSolution } from "../src/grader/compile.ts";
import { grade, passed } from "../src/grader/grade.ts";
import type { Loader } from "../src/tasks/types.ts";

const walletTask = TASKS.find((t) => t.id === "wallet-withdraw")!;
const sameRequestTwice = walletTask.scenarios.find((s) => s.name === "same request sent twice at once")!;

/** In-process loader: a fresh instance of the compiled solution per call. */
async function loaderFor(file: string): Promise<Loader> {
  const compiled = await compileSolution(join(import.meta.dirname, "../tasks/wallet-withdraw", file));
  if ("error" in compiled) throw new Error(compiled.error);
  let n = 0;
  return () => import(`data:text/javascript;base64,${Buffer.from(`${compiled.code}\n//# ${++n}`).toString("base64")}`) as Promise<Record<string, unknown>>;
}

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
    const load = await loaderFor("reference.ts");
    for (const scenario of walletTask.scenarios) {
      const run = await runScheduled(scenario, load, () => 0, 5000);
      assert.ok(run.outcome.pass, `${scenario.name}: ${run.outcome.detail}`);
    }
  });

  it("the reference survives random interleavings", async () => {
    const result = await explore(sameRequestTwice, await loaderFor("reference.ts"), { schedules: 40, seed: 1, timeoutMs: 5000 });
    assert.equal(result.failures, 0, result.finding?.detail);
  });

  it("finds, shrinks and replays a race that arrival order hides", async () => {
    const load = await loaderFor("mutants/naive.ts");
    const inOrder = await runScheduled(sameRequestTwice, load, () => 0, 5000);
    assert.ok(inOrder.outcome.pass, "the race should be invisible in arrival order");

    const result = await explore(sameRequestTwice, load, { schedules: 60, seed: 1, timeoutMs: 5000 });
    assert.ok(result.failures > 0 && result.finding);
    assert.ok(result.finding.deviations <= 3, `shrunk to ${result.finding.deviations} deviations`);
    assert.ok(result.finding.trace.some((step) => step.actor.startsWith("app send")));

    const again = await runScheduled(sameRequestTwice, load, replay(result.finding.choices), 5000);
    assert.equal(again.outcome.pass, false, "replaying the shrunk interleaving reproduces the failure");
    assert.equal(again.outcome.detail, result.finding.detail);
  });

  it("runs inside the sandboxed grader with the same verdicts", async () => {
    const report = await grade("wallet-withdraw", join(import.meta.dirname, "../tasks/wallet-withdraw/mutants/naive.ts"), { chaos: 30 });
    const found = report.chaos?.find((c) => c.scenario === "same request sent twice at once");
    assert.ok(found && found.failures > 0, JSON.stringify(report.chaos));
  });
});

describe("crash exploration", () => {
  const webhookTask = TASKS.find((t) => t.id === "webhook-handler")!;
  const duplicate = webhookTask.scenarios.find((s) => s.name === "duplicate delivery")!;
  const loader = async (task: string, file: string): Promise<Loader> => {
    const compiled = await compileSolution(join(import.meta.dirname, "../tasks", task, file));
    if ("error" in compiled) throw new Error(compiled.error);
    let n = 0;
    return () => import(`data:text/javascript;base64,${Buffer.from(`${compiled.code}\n//# ${++n}`).toString("base64")}`) as Promise<Record<string, unknown>>;
  };

  it("only scenarios whose callers retry are crash-eligible", () => {
    assert.ok(duplicate.crash);
    assert.equal(walletTask.scenarios.find((s) => s.name === "payout went through, response lost, user closed the app")?.crash, false);
  });

  it("the reference survives its instance being killed before and after every call", async () => {
    const result = await exploreCrashes(duplicate, await loader("webhook-handler", "reference.ts"), { timeoutMs: 5000 });
    assert.ok(result.points > 0);
    assert.equal(result.failures, 0, result.finding?.detail);
  });

  it("catches books written in two steps, and traces the kill", async () => {
    const result = await exploreCrashes(duplicate, await loader("webhook-handler", "mutants/separate-writes.ts"), { timeoutMs: 5000 });
    assert.ok(result.failures > 0 && result.finding);
    assert.equal(result.finding.mode, "after");
    assert.ok(result.finding.trace.some((step) => step.call === "instance killed"));
  });

  it("runs inside the sandboxed grader", async () => {
    const report = await grade("wallet-withdraw", join(import.meta.dirname, "../tasks/wallet-withdraw/mutants/reserve-then-record.ts"), { crash: true });
    assert.ok(passed(report), "the two-step bug is invisible without crashes");
    assert.ok(report.crash?.some((c) => c.failures > 0));
  });
});
