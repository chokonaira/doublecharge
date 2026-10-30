import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Everything that decides a verdict: the grader, the world, the tasks and the toolchain versions. */
const GRADING_INPUTS = ["src", "tasks", "package.json", "package-lock.json"];

export interface Provenance {
  commit: string;
  /** True when any grading input differs from the commit. */
  dirty: boolean;
  /** sha256 over the grading inputs as they are on disk, so a run can be matched to exact code. */
  graderHash: string;
}

const git = (root: string, args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

export function provenance(root: string): Provenance {
  const files = git(root, ["ls-files", "--", ...GRADING_INPUTS]).split("\n").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(readFileSync(join(root, file))).update("\0");
  return {
    commit: git(root, ["rev-parse", "--short", "HEAD"]),
    dirty: git(root, ["status", "--porcelain", "--untracked-files=all", "--", ...GRADING_INPUTS]) !== "",
    graderHash: hash.digest("hex"),
  };
}
