import type { Scheduler } from "../world/index.ts";

/** Picks which waiting world call resumes next, given the step number and how many are waiting. */
export type Pick = (step: number, waiting: number) => number;

const realImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Holds every world call at its scheduling point and releases them one at a time, in the order
 * `pick` chooses. Choosing 0 every time releases calls in arrival order, which is the default world.
 * The sequence of choices is recorded, so any interleaving can be replayed exactly.
 */
export class ControlledScheduler implements Scheduler {
  readonly choices: number[] = [];
  private readonly waiting: (() => void)[] = [];
  private running = true;
  private readonly pick: Pick;

  constructor(pick: Pick) {
    this.pick = pick;
  }

  yield(): Promise<void> {
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  async drive(): Promise<void> {
    while (this.running) {
      // Let everything runnable reach its next scheduling point before choosing.
      await realImmediate();
      await realImmediate();
      if (!this.running || this.waiting.length === 0) continue;
      const choice = Math.min(Math.max(0, this.pick(this.choices.length, this.waiting.length)), this.waiting.length - 1);
      this.choices.push(choice);
      this.waiting.splice(choice, 1)[0]!();
    }
  }

  stop(): void {
    this.running = false;
  }
}
