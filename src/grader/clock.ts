// Virtual time for solution code. Delays cost nothing, yet run in a deterministic order: the clock
// jumps to the next timer only when no world call is in flight, so a solution's own deadline can
// never race the simulated network. Covers globalThis timers, node:timers, node:timers/promises
// (including scheduler.wait) and Date.
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pendingCalls, timeMoved } from "../world/index.ts";

/** Fixed start of virtual time, so runs are reproducible. */
export const EPOCH = Date.UTC(2026, 10, 1);

interface Timer {
  id: number;
  due: number;
  seq: number;
  fn: (...args: unknown[]) => void;
  args: unknown[];
  interval?: number;
  /** The async context the timer was set in: the request (and instance) that owns the callback. */
  context: <R>(fn: () => R) => R;
}

export interface VirtualClock {
  /** Back to EPOCH with no timers pending. */
  reset(): void;
  start(): void;
  stop(): Promise<void>;
  now(): number;
}

type TimerArgs = [fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]];

export function installVirtualClock(onTimerError: (error: unknown) => void): VirtualClock {
  const require = createRequire(import.meta.url);
  const realImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));
  const RealDate = Date;
  const timers = new Map<number, Timer>();
  let now = EPOCH;
  let seq = 0;
  let nextId = 1;
  let running = false;
  let driving: Promise<void> = Promise.resolve();

  const toId = (handle: unknown): number | undefined => (typeof handle === "number" ? handle : (handle as { id?: number } | undefined)?.id);

  function schedule([fn, ms, ...args]: TimerArgs, repeat: boolean) {
    const delay = Math.max(repeat ? 1 : 0, Number(ms) || 0);
    const timer: Timer = { id: nextId++, due: now + delay, seq: seq++, fn, args, interval: repeat ? delay : undefined, context: AsyncLocalStorage.snapshot() };
    timers.set(timer.id, timer);
    const handle = {
      id: timer.id,
      ref: () => handle,
      unref: () => handle,
      hasRef: () => true,
      refresh: () => {
        timer.due = now + delay;
        return handle;
      },
      close: () => timers.delete(timer.id),
      [Symbol.toPrimitive]: () => timer.id,
    };
    return handle;
  }

  const virtualSetTimeout = (...args: TimerArgs) => schedule(args, false);
  const virtualSetInterval = (...args: TimerArgs) => schedule(args, true);
  const virtualClear = (handle: unknown) => {
    const id = toId(handle);
    if (id !== undefined) timers.delete(id);
  };

  function sleep(ms: number | undefined, value?: unknown, options?: { signal?: AbortSignal }): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const signal = options?.signal;
      if (signal?.aborted) return reject(signal.reason);
      const handle = virtualSetTimeout(() => resolve(value), ms);
      signal?.addEventListener("abort", () => (virtualClear(handle), reject(signal.reason)), { once: true });
    });
  }

  async function* every(ms: number | undefined, value?: unknown, options?: { signal?: AbortSignal }) {
    while (true) {
      await sleep(ms, undefined, options);
      yield value;
    }
  }

  class VirtualDate extends RealDate {
    constructor(...args: [] | [string | number | Date] | [number, number, ...number[]]) {
      if (args.length === 0) super(now);
      else super(...(args as [number, number]));
    }
    static override now(): number {
      return now;
    }
  }

  Object.assign(globalThis, { setTimeout: virtualSetTimeout, setInterval: virtualSetInterval, clearTimeout: virtualClear, clearInterval: virtualClear, Date: VirtualDate });
  Object.assign(require("node:timers"), { setTimeout: virtualSetTimeout, setInterval: virtualSetInterval, clearTimeout: virtualClear, clearInterval: virtualClear });
  const timersPromises = require("node:timers/promises") as typeof import("node:timers/promises");
  Object.assign(timersPromises, { setTimeout: sleep, setInterval: every });
  Object.assign(timersPromises.scheduler, { wait: (ms: number, options?: { signal?: AbortSignal }) => sleep(ms, undefined, options) });
  syncBuiltinESMExports();

  function nextDue(): Timer | undefined {
    let next: Timer | undefined;
    for (const timer of timers.values()) if (!next || timer.due < next.due || (timer.due === next.due && timer.seq < next.seq)) next = timer;
    return next;
  }

  async function drive(): Promise<void> {
    while (running) {
      await realImmediate();
      await realImmediate();
      if (!running || pendingCalls() > 0) continue;
      const timer = nextDue();
      if (!timer) continue;
      if (timer.due > now) timeMoved(timer.due - now);
      now = Math.max(now, timer.due);
      if (timer.interval !== undefined) {
        timer.due = now + timer.interval;
        timer.seq = seq++;
      } else {
        timers.delete(timer.id);
      }
      try {
        // Run the callback as part of the request that set it: its world calls count as that request's
        // calls, can be paused or crashed, and are refused once its instance has been killed.
        timer.context(() => timer.fn(...timer.args));
      } catch (error) {
        onTimerError(error);
      }
    }
  }

  return {
    reset() {
      timers.clear();
      now = EPOCH;
    },
    start() {
      running = true;
      driving = drive();
    },
    async stop() {
      running = false;
      await driving;
    },
    now: () => now,
  };
}
