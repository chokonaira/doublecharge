import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { passHatK, rateWithInterval, wilson } from "../src/report/stats.ts";

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
  });
});
