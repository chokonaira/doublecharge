import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ReviewRecord } from "../review/records.ts";
import type { TrialRecord } from "./records.ts";

/**
 * Fills a run's trials that never ran: ones the budget guard skipped, or calls the API turned away.
 * Each fill is another run of the same command at the same commit and settings. Every trial that never
 * ran takes the fill's record for it, whatever that record says (unless the fill skipped it too), and a
 * fill's record for any other trial is discarded whatever it says, so nothing is chosen by its outcome.
 */

interface Manifest {
  commit: string;
  graderHash: string;
  startedAt: string;
  system: string;
  models: string[];
  /** Part 2 runs only. */
  samples?: string[];
  schedules?: number;
  /** Part 2 runs only; runs from before code variants existed showed plain code. */
  codeVariant?: string;
  /** Part 1 runs only. */
  maxTokens?: number;
  /** Part 1 runs only; runs from before variants existed were "warned". */
  promptVariant?: string;
  fills?: { run: string; startedAt: string; commit: string; graderHash: string; replaced: string[]; discarded: string[] }[];
  migrated?: { reason: string; trials: string[] };
}

type AnyRecord = TrialRecord | ReviewRecord;

const read = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const isReview = (m: Manifest) => m.samples !== undefined;
const keyOf = (r: AnyRecord) => `${r.model} ${"sample" in r ? r.sample : r.task} ${r.trial}`;
const dirOf = (r: AnyRecord) => join(r.model.replace("/", "__"), "sample" in r ? r.sample : r.task, `t${r.trial}`);

/**
 * A review call that failed before any reply came back, as review runs before errors had their own
 * field stored it: no verdict, nothing spent, no time taken, and the error message as a note.
 */
const legacyError = (r: ReviewRecord) => r.verdict === "none" && r.error === undefined && r.cost === 0 && r.ms === 0 && r.note !== undefined;

function neverRan(r: AnyRecord): boolean {
  if ("sample" in r) return r.error !== undefined || legacyError(r);
  return r.status === "skipped" || r.status === "error";
}

const skipped = (r: AnyRecord) => !("sample" in r) && r.status === "skipped";

export interface FillResult {
  replaced: number;
  discarded: number;
  migrated: number;
  /** Trials that still never ran. */
  left: number;
}

export function fillRun(runDir: string, fillDirs: string[], render: (records: AnyRecord[], models: string[]) => string): FillResult {
  const manifest = read<Manifest>(join(runDir, "manifest.json"));
  const records = read<AnyRecord[]>(join(runDir, "records.json"));
  manifest.fills ??= [];
  let replacedAll = 0;
  let discardedAll = 0;
  for (const fillDir of fillDirs) {
    const fill = read<Manifest>(join(fillDir, "manifest.json"));
    const id = basename(fillDir);
    if (manifest.fills.some((f) => f.run === id)) throw new Error(`${id} is already merged into this run`);
    const same =
      fill.commit === manifest.commit &&
      fill.graderHash === manifest.graderHash &&
      fill.system === manifest.system &&
      isReview(fill) === isReview(manifest) &&
      fill.schedules === manifest.schedules &&
      fill.maxTokens === manifest.maxTokens &&
      (fill.promptVariant ?? "warned") === (manifest.promptVariant ?? "warned") &&
      (fill.codeVariant ?? "plain") === (manifest.codeVariant ?? "plain");
    if (!same) throw new Error(`${id} was not run at the same commit and settings as this run`);
    const replaced: string[] = [];
    const discarded: string[] = [];
    for (const r of read<AnyRecord[]>(join(fillDir, "records.json"))) {
      const i = records.findIndex((x) => keyOf(x) === keyOf(r));
      if (i < 0 || !neverRan(records[i]!) || skipped(r)) {
        discarded.push(keyOf(r));
        continue;
      }
      records[i] = r;
      rmSync(join(runDir, dirOf(r)), { recursive: true, force: true });
      cpSync(join(fillDir, dirOf(r)), join(runDir, dirOf(r)), { recursive: true });
      replaced.push(keyOf(r));
    }
    mkdirSync(join(runDir, "fills"), { recursive: true });
    writeFileSync(join(runDir, "fills", `${id}.manifest.json`), JSON.stringify(fill, null, 2));
    manifest.fills.push({ run: id, startedAt: fill.startedAt, commit: fill.commit, graderHash: fill.graderHash, replaced, discarded });
    replacedAll += replaced.length;
    discardedAll += discarded.length;
  }

  // Review calls that failed before any reply came back get the error field today's review command gives them.
  const migrated: string[] = [];
  for (const r of records) {
    if (!("sample" in r) || !legacyError(r)) continue;
    r.error = r.note;
    delete r.note;
    writeFileSync(join(runDir, dirOf(r), "record.json"), JSON.stringify(r, null, 2));
    migrated.push(keyOf(r));
  }
  if (migrated.length > 0) {
    const earlier = manifest.migrated?.trials ?? [];
    manifest.migrated = { reason: "calls that failed before any reply came back, stored as a note before errors had their own field", trials: [...earlier, ...migrated] };
  }

  writeFileSync(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(runDir, "records.json"), JSON.stringify(records, null, 2));
  writeFileSync(join(runDir, "summary.md"), `${render(records, manifest.models)}\n`);
  return { replaced: replacedAll, discarded: discardedAll, migrated: migrated.length, left: records.filter(neverRan).length };
}
