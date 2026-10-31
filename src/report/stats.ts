/** 95% Wilson score interval for `successes` out of `trials`. Sound at small n and at 0% or 100%, unlike the normal approximation. */
export function wilson(successes: number, trials: number): [number, number] {
  if (trials === 0) return [0, 1];
  const z = 1.96;
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const centre = (p + (z * z) / (2 * trials)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const choose = (n: number, k: number): number => {
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return result;
};

/**
 * pass^k: the chance that k fresh trials of the same task all succeed, averaged over tasks (the
 * unbiased estimator from tau-bench: C(c, k) / C(n, k) per task with c successes in n trials).
 * Tasks with fewer than k graded trials are left out; undefined when none are left.
 */
export function passHatK(tasks: { trials: number; successes: number }[], k: number): number | undefined {
  if (k < 1) return undefined;
  const usable = tasks.filter((t) => t.trials >= k);
  if (usable.length === 0) return undefined;
  return usable.reduce((sum, t) => sum + choose(t.successes, k) / choose(t.trials, k), 0) / usable.length;
}

/** A whole percentage that never rounds a near miss up to 100% or a rare success down to 0%. */
export function percent(x: number): string {
  const rounded = Math.round(100 * x);
  return `${x < 1 && rounded === 100 ? 99 : x > 0 && rounded === 0 ? 1 : rounded}%`;
}

/** "12/15 (80%, 95% CI 55-93%)" */
export function rateWithInterval(successes: number, trials: number): string {
  if (trials === 0) return "-";
  const [low, high] = wilson(successes, trials);
  return `${successes}/${trials} (${percent(successes / trials)}, 95% CI ${Math.round(100 * low)}-${Math.round(100 * high)}%)`;
}
