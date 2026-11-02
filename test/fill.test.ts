import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fillRun } from "../src/report/fill.ts";
import type { TrialRecord } from "../src/report/records.ts";
import type { ReviewRecord } from "../src/review/records.ts";

const settings = { commit: "abc1234", graderHash: "h", system: "s", models: ["lab/m"] };

function run(manifest: object, records: (TrialRecord | ReviewRecord)[]): string {
  const dir = mkdtempSync(join(tmpdir(), "doublecharge-fill-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ startedAt: "t", ...settings, ...manifest }));
  writeFileSync(join(dir, "records.json"), JSON.stringify(records));
  for (const r of records) {
    const trialDir = join(dir, "lab__m", "sample" in r ? r.sample : r.task, `t${r.trial}`);
    mkdirSync(trialDir, { recursive: true });
    writeFileSync(join(trialDir, "record.json"), JSON.stringify(r));
  }
  return dir;
}

const trial = (n: number, status: TrialRecord["status"]): TrialRecord => ({ model: "lab/m", task: "t", trial: n, status, scenarios: [], cost: status === "skipped" ? 0 : 0.1, ms: 0 });
const review = (n: number, extra: Partial<ReviewRecord>): ReviewRecord => ({
  model: "lab/m", sample: "s", task: "t", origin: "mutant", knownBug: true, trial: n, verdict: "UNSAFE", cost: 0.1, ms: 5, ...extra,
});
const render = (records: unknown[]) => `${records.length} records`;
const readRecords = <T>(dir: string) => JSON.parse(readFileSync(join(dir, "records.json"), "utf8")) as T[];

describe("fill", () => {
  it("replaces only trials that never ran, whatever the fill's records say", () => {
    const main = run({ maxTokens: 100 }, [trial(1, "pass"), trial(2, "skipped"), trial(3, "error")]);
    const fill = run({ maxTokens: 100 }, [trial(1, "fail"), trial(2, "fail"), trial(3, "skipped")]);
    const result = fillRun(main, [fill], render);
    assert.deepEqual(result, { replaced: 1, discarded: 2, migrated: 0, left: 1 });
    assert.deepEqual(
      readRecords<TrialRecord>(main).map((r) => r.status),
      ["pass", "fail", "error"],
    );
    const manifest = JSON.parse(readFileSync(join(main, "manifest.json"), "utf8")) as { fills: { replaced: string[]; discarded: string[] }[] };
    assert.deepEqual(manifest.fills[0]!.replaced, ["lab/m t 2"]);
    assert.equal(readFileSync(join(main, "summary.md"), "utf8"), "3 records\n");
  });

  it("refuses a fill run at another commit or with other settings, and the same fill twice", () => {
    const main = run({ maxTokens: 100 }, [trial(1, "skipped")]);
    assert.throws(() => fillRun(main, [run({ maxTokens: 100, commit: "def5678" }, [trial(1, "pass")])], render), /same commit and settings/);
    assert.throws(() => fillRun(main, [run({ maxTokens: 200 }, [trial(1, "pass")])], render), /same commit and settings/);
    assert.throws(() => fillRun(main, [run({ maxTokens: 100, promptVariant: "ordinary" }, [trial(1, "pass")])], render), /same commit and settings/);
    const fill = run({ maxTokens: 100 }, [trial(1, "pass")]);
    fillRun(main, [fill], render);
    assert.throws(() => fillRun(main, [fill], render), /already merged/);
  });

  it("counts a run from before prompt variants as warned", () => {
    const main = run({ maxTokens: 100 }, [trial(1, "skipped")]);
    assert.deepEqual(fillRun(main, [run({ maxTokens: 100, promptVariant: "warned" }, [trial(1, "pass")])], render).replaced, 1);
    const ordinary = run({ maxTokens: 100, promptVariant: "ordinary" }, [trial(1, "skipped")]);
    assert.deepEqual(fillRun(ordinary, [run({ maxTokens: 100, promptVariant: "ordinary" }, [trial(1, "pass")])], render).replaced, 1);
    const another = run({ maxTokens: 100, promptVariant: "ordinary" }, [trial(1, "skipped")]);
    assert.throws(() => fillRun(another, [run({ maxTokens: 100 }, [trial(1, "pass")])], render), /same commit and settings/);
  });

  it("in a review run, replaces calls the API turned away, and gives older ones an error field", () => {
    const turnedAway = review(1, { verdict: "none", cost: 0, ms: 0, note: "OpenRouter: 429 Rate limit exceeded" });
    const noVerdict = review(2, { verdict: "none", note: "no verdict line" });
    const blocked = review(3, { verdict: "none", cost: 0, ms: 0, note: "OpenRouter: 429 Rate limit exceeded" });
    const main = run({ samples: ["s"], schedules: 30 }, [turnedAway, noVerdict, blocked]);
    const fill = run({ samples: ["s"], schedules: 30 }, [review(1, {}), review(2, {}), review(3, { verdict: "none", cost: 0, ms: 0, note: "OpenRouter: 200 flagged" })]);
    const result = fillRun(main, [fill], render);
    // A reply with no verdict line is the reviewer's, so it is never replaced.
    assert.deepEqual(result, { replaced: 2, discarded: 1, migrated: 1, left: 1 });
    const [first, second, third] = readRecords<ReviewRecord>(main);
    assert.equal(first!.verdict, "UNSAFE");
    assert.equal(second!.note, "no verdict line");
    assert.equal(third!.error, "OpenRouter: 200 flagged");
    assert.equal(third!.note, undefined);
  });
});
