// Merges re-runs of trials that never ran (skipped by the budget guard, or turned away by the API) into
// a run. Each fill must be a run of the same command at the same commit and settings.
// npm run fill -- runs/<run> runs/<fill run> [more fill runs]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TASKS } from "../../tasks/index.ts";
import { fillRun } from "../report/fill.ts";
import type { TrialRecord } from "../report/records.ts";
import { renderSummary } from "../report/summary.ts";
import type { ReviewRecord } from "../review/records.ts";
import { renderReviewSummary } from "../review/summary.ts";

const [runDir, ...fillDirs] = process.argv.slice(2);
if (!runDir || fillDirs.length === 0) throw new Error("usage: npm run fill -- <run> <fill run> [more fill runs]");

const review = (JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8")) as { samples?: string[] }).samples !== undefined;
const render = review
  ? (records: unknown[], models: string[]) => renderReviewSummary(records as ReviewRecord[], models)
  : (records: unknown[], models: string[]) =>
      renderSummary(
        records as TrialRecord[],
        models,
        TASKS.filter((t) => (records as TrialRecord[]).some((r) => r.task === t.id)),
      );

const result = fillRun(runDir, fillDirs, render);
console.log(
  `Filled ${result.replaced} trials from ${fillDirs.length} runs; ${result.discarded} records from the fills were for trials that had run, or were skips, and are discarded.` +
    `${result.migrated ? ` ${result.migrated} earlier API failures were given an error field.` : ""} Trials that still never ran: ${result.left}.`,
);
