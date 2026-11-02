import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fisherExact, passHatK, percent, rateWithInterval, riskDifference, stratifiedExact, wilson } from "../src/report/stats.ts";

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 0.001, `${actual} is not ${expected}`);

describe("wilson", () => {
  it("stays inside [0, 1] and is not degenerate at 0% or 100%", () => {
    const [low0, high0] = wilson(0, 10);
    near(low0, 0);
    near(high0, 0.2775);
    const [low1, high1] = wilson(10, 10);
    near(low1, 0.7225);
    near(high1, 1);
  });

  it("is symmetric around one half", () => {
    const [low, high] = wilson(2, 4);
    near(low + high, 1);
    assert.equal(rateWithInterval(2, 4), "2/4 (50%, 95% CI 15-85%)");
  });

  it("knows nothing from no trials", () => {
    assert.deepEqual(wilson(0, 0), [0, 1]);
    assert.equal(rateWithInterval(0, 0), "-");
  });
});

describe("fisherExact", () => {
  it("matches known two-sided values", () => {
    near(fisherExact(3, 4, 1, 4), 0.4857); // the lady tasting tea
    near(fisherExact(25, 27, 20, 27), 0.1415);
    near(fisherExact(25, 27, 18, 27), 0.0394);
    near(fisherExact(0, 10, 10, 10), 0.0000108);
  });

  it("is 1 when the rates are the same, and symmetric in its arms", () => {
    assert.equal(fisherExact(5, 5, 5, 5), 1);
    assert.equal(fisherExact(3, 6, 3, 6), 1);
    near(fisherExact(20, 27, 25, 27), fisherExact(25, 27, 20, 27));
  });

  it("stays exact where the binomial coefficients themselves would overflow", () => {
    near(fisherExact(300, 600, 300, 600), 1);
    near(fisherExact(700, 1000, 640, 1000), 0.0049);
  });
});

describe("stratifiedExact", () => {
  it("is Fisher's test with one stratum, and drops strata that carry no information", () => {
    near(stratifiedExact([{ a: 25, n: 27, b: 20, m: 27 }]), fisherExact(25, 27, 20, 27));
    const informative = [{ a: 5, n: 5, b: 1, m: 5 }, { a: 4, n: 5, b: 2, m: 5 }];
    const uninformative = [{ a: 5, n: 5, b: 5, m: 5 }, { a: 0, n: 5, b: 0, m: 5 }, { a: 3, n: 0, b: 2, m: 4 }];
    near(stratifiedExact([...informative, ...uninformative]), stratifiedExact(informative));
    assert.equal(stratifiedExact([]), 1);
  });

  it("matches the exact Cochran-Mantel-Haenszel test", () => {
    near(stratifiedExact([{ a: 2, n: 2, b: 0, m: 2 }, { a: 1, n: 1, b: 0, m: 2 }]), 0.0556);
    near(stratifiedExact([{ a: 5, n: 5, b: 1, m: 5 }, { a: 4, n: 5, b: 2, m: 5 }]), 0.0238);
  });

  it("does not let a hard stratum pass for an effect when the arms differ in size", () => {
    // Within each stratum the arms have the same rate, but the second arm ran mostly the hard one.
    const strata = [{ a: 18, n: 20, b: 9, m: 10 }, { a: 2, n: 20, b: 9, m: 90 }];
    near(stratifiedExact(strata), 1);
    assert.ok(fisherExact(20, 40, 18, 100) < 0.001, "pooling would call it a difference");
    near(riskDifference(strata)!, 0);
  });
});

describe("riskDifference", () => {
  it("weights each stratum's difference by its size", () => {
    near(riskDifference([{ a: 2, n: 2, b: 0, m: 2 }, { a: 1, n: 1, b: 0, m: 2 }])!, 1);
    near(riskDifference([{ a: 4, n: 4, b: 2, m: 4 }])!, 0.5);
    assert.equal(riskDifference([{ a: 1, n: 0, b: 1, m: 2 }]), undefined);
  });
});

describe("percent", () => {
  it("never shows a near miss as 100% or a rare success as 0%", () => {
    assert.equal(percent(249 / 250), "99%");
    assert.equal(percent(1 / 250), "1%");
    assert.equal(percent(1), "100%");
    assert.equal(percent(0), "0%");
    assert.equal(percent(2 / 3), "67%");
  });
});

describe("passHatK", () => {
  const tasks = [
    { trials: 3, successes: 3 },
    { trials: 3, successes: 2 },
    { trials: 3, successes: 0 },
  ];

  it("is the mean pass rate at k = 1", () => near(passHatK(tasks, 1)!, (1 + 2 / 3 + 0) / 3));

  it("only counts a task at k = n when every trial passed", () => near(passHatK(tasks, 3)!, 1 / 3));

  it("uses the unbiased estimator in between", () => near(passHatK(tasks, 2)!, (1 + 1 / 3 + 0) / 3));

  it("leaves out tasks with fewer than k trials", () => {
    near(passHatK([{ trials: 3, successes: 3 }, { trials: 1, successes: 0 }], 3)!, 1);
    assert.equal(passHatK([{ trials: 2, successes: 2 }], 3), undefined);
    assert.equal(passHatK([{ trials: 0, successes: 0 }], 0), undefined);
  });
});
