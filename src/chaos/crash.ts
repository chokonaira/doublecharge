import type { Loader, Scenario } from "../tasks/types.ts";
import { callsSincePlan, planCrash, type CrashMode, type TraceEntry } from "../world/index.ts";
import { runScheduled } from "./explore.ts";

export interface CrashFinding {
  /** The solution's world call at which its instance was killed. */
  at: number;
  mode: CrashMode;
  detail: string;
  trace: TraceEntry[];
}

export interface CrashResult {
  scenario: string;
  /** Crash points tried: every world call of the clean run, killed before and after it. */
  points: number;
  failures: number;
  finding?: CrashFinding;
}

const inOrder = () => 0;

/**
 * Kills the solution's instance at every world call of a scenario, once before the call reaches the
 * service and once just after the service has acted on it. Callers retry as usual. Every run must
 * still reach the scenario's correct outcome. Deterministic: calls resume in arrival order.
 */
export async function exploreCrashes(
  scenario: Scenario,
  load: Loader,
  opts: { timeoutMs: number; beforeRun?: () => Promise<void> | void },
): Promise<CrashResult> {
  const beforeRun = opts.beforeRun ?? (() => {});
  await beforeRun();
  planCrash(undefined);
  await runScheduled(scenario, load, inOrder, opts.timeoutMs);
  const calls = callsSincePlan();

  let failures = 0;
  let finding: CrashFinding | undefined;
  for (let at = 1; at <= calls; at++) {
    for (const mode of ["before", "after"] as const) {
      await beforeRun();
      planCrash({ at, mode });
      const run = await runScheduled(scenario, load, inOrder, opts.timeoutMs);
      planCrash(undefined);
      if (run.outcome.pass) continue;
      failures++;
      finding ??= { at, mode, detail: run.outcome.detail, trace: run.trace };
    }
  }
  return { scenario: scenario.name, points: calls * 2, failures, finding };
}
