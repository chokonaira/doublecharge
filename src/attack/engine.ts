import type { Outcome, Scenario } from "../tasks/types.ts";
import { asActor, callMatcher, crashOnce, pauseOnce, waitBeforeRetry } from "../world/index.ts";
import { AttackInvalid, type Attack, type AttackAdapter, type AttackRequest, type AttackWorld } from "./types.ts";

/** Runs a parsed attack: its steps (with pauses and crashes), then settling, then the task's rules. */
async function runAttack(attack: Attack, world: AttackWorld): Promise<Outcome> {
  const unanswered: AttackRequest[] = [];

  async function runRequest(request: AttackRequest): Promise<void> {
    if (world.isInstant(request)) {
      await world.perform(request);
      return;
    }
    if (request.crash) crashOnce({ actor: request.id, when: request.crash.when, call: callMatcher(request.crash.call, request.crash.occurrence) });
    const pause = request.pause;
    const claim = pause ? pauseOnce({ actor: request.id, when: pause.when, call: callMatcher(pause.call, pause.occurrence), run: () => runSteps(pause.meanwhile) }) : () => false;
    if (!(await answers(request))) unanswered.push(request);
    // A pause whose call never came still runs its meanwhile steps, once, when the request is over.
    if (pause && claim()) await runSteps(pause.meanwhile);
  }

  /** Sends a request, retrying as the caller would; whether it answered. */
  async function answers(request: AttackRequest): Promise<boolean> {
    for (let attempt = 0; attempt <= request.retries; attempt++) {
      if (attempt > 0) await waitBeforeRetry();
      const label = attempt === 0 ? request.id : `${request.id} retry ${attempt}`;
      try {
        const value = await asActor(label, () => world.perform(request));
        world.answered(request, value, label);
        return true;
      } catch (e) {
        if (e instanceof AttackInvalid) throw e;
        // no answer: the caller tries again if it has retries left
      }
    }
    return false;
  }

  async function runSteps(steps: AttackRequest[][]): Promise<void> {
    for (const group of steps) await Promise.all(group.map(runRequest));
  }

  await runSteps(attack.steps);
  await world.settle(unanswered);
  return world.check();
}

export const INVALID = "invalid attack: ";

/**
 * An attack as a scenario, so it runs through the same sandbox, scheduler and chaos search. The
 * outcome fails when the attack breaks a rule. An attack that asks for the impossible passes, with
 * a detail starting with INVALID, so it can never count as a confirmed bug.
 */
export function attackScenario(attack: Attack, adapter: AttackAdapter): Scenario {
  return {
    name: "attack",
    crash: false,
    run: async (load) => {
      try {
        return await runAttack(attack, adapter.create(load, attack));
      } catch (e) {
        if (e instanceof AttackInvalid) return { pass: true, detail: `${INVALID}${e.message}` };
        throw e;
      }
    },
  };
}

/** Checks a list of rules, like the scenario `check`, keeping each broken rule's explanation. */
export function rules(conditions: [holds: boolean, broken: string][]): Outcome {
  const broken = conditions.filter(([holds]) => !holds).map(([, why]) => why);
  return broken.length ? { pass: false, detail: broken.join("; ") } : { pass: true, detail: "every rule held" };
}

/** Repeats a request until it answers, as a caller or reconciliation job would. */
export async function repeatUntilAnswered(
  label: string,
  attempt: () => Promise<unknown>,
  onAnswer: (value: unknown, attemptLabel: string) => void,
  attempts = 5,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    await waitBeforeRetry();
    const name = `${label} settle ${i + 1}`;
    try {
      onAnswer(await asActor(name, attempt), name);
      return true;
    } catch {
      // still no answer
    }
  }
  return false;
}
