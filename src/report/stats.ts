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

/** log C(n, k), summed term by term so it stays finite where C(n, k) itself would overflow. */
function logChoose(n: number, k: number): number {
  let sum = 0;
  for (let i = 1; i <= Math.min(k, n - k); i++) sum += Math.log((n - Math.min(k, n - k) + i) / i);
  return sum;
}

/** One stratum of a two-arm comparison: a successes of n trials in the first arm, b of m in the second. */
export interface Stratum {
  a: number;
  n: number;
  b: number;
  m: number;
}

/**
 * Two-sided exact stratified test of two arms (the exact Cochran-Mantel-Haenszel test for 2x2xK tables):
 * if the arms had the same success rate within every stratum, the chance of first-arm successes as
 * unlikely as those seen, given every stratum's totals. Strata whose rates differ, such as an easy task
 * and a hard one, are compared only within themselves, and a stratum where one arm has no trials, or
 * where every trial succeeded or every one failed, carries no information and drops out. Exact at any
 * sample size. With one stratum it is Fisher's exact test.
 */
export function stratifiedExact(strata: Stratum[]): number {
  let dist = [1];
  let low = 0;
  let seen = 0;
  for (const { a, n, b, m } of strata) {
    if (n === 0 || m === 0) continue;
    const successes = a + b;
    const from = Math.max(0, successes - m);
    const to = Math.min(n, successes);
    const total = logChoose(n + m, successes);
    const pmf = Array.from({ length: to - from + 1 }, (_, i) => Math.exp(logChoose(n, from + i) + logChoose(m, successes - from - i) - total));
    const next: number[] = Array.from({ length: dist.length + pmf.length - 1 }, () => 0);
    dist.forEach((p, i) => pmf.forEach((q, j) => (next[i + j]! += p * q)));
    dist = next;
    low += from;
    seen += a;
  }
  const observed = dist[seen - low]!;
  return Math.min(1, dist.filter((p) => p <= observed * (1 + 1e-7)).reduce((sum, p) => sum + p, 0));
}

/** Two-sided Fisher exact test of a/n against b/m: the stratified test with a single stratum. */
export function fisherExact(a: number, n: number, b: number, m: number): number {
  return stratifiedExact([{ a, n, b, m }]);
}

/**
 * The Mantel-Haenszel risk difference: the first arm's success rate minus the second's, averaged over
 * strata weighted by size, so a hard task cannot pass for an effect of the arm. Undefined with no strata.
 */
export function riskDifference(strata: Stratum[]): number | undefined {
  const used = strata.filter((s) => s.n > 0 && s.m > 0);
  const weight = used.reduce((sum, s) => sum + (s.n * s.m) / (s.n + s.m), 0);
  if (weight === 0) return undefined;
  return used.reduce((sum, s) => sum + (s.a * s.m - s.b * s.n) / (s.n + s.m), 0) / weight;
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
