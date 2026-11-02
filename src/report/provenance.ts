import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Everything that decides a verdict: the grader, the world, the tasks and the toolchain versions. */
const GRADING_INPUTS = ["src", "tasks", "package.json", "package-lock.json"];

export interface Provenance {
  /** The commit, or "none" outside a git checkout (an unpacked source archive, say): the hash still identifies the code. */
  commit: string;
  /** True when any grading input differs from the commit. */
  dirty: boolean;
  /** sha256 over the grading inputs as they are on disk, so a run can be matched to exact code. */
  graderHash: string;
}

const git = (root: string, args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

function hashOf(root: string, files: string[]): string {
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(readFileSync(join(root, file))).update("\0");
  return hash.digest("hex");
}

function inCheckout(root: string): boolean {
  try {
    return git(root, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}

/** Every file under the grading inputs, as git ls-files would list a checkout of them. */
function filesOnDisk(root: string): string[] {
  const walk = (path: string): string[] =>
    statSync(path).isDirectory() ? readdirSync(path).filter((name) => name !== ".DS_Store").flatMap((name) => walk(join(path, name))) : [path];
  return GRADING_INPUTS.filter((input) => existsSync(join(root, input)))
    .flatMap((input) => walk(join(root, input)))
    .map((path) => relative(root, path).split(sep).join("/"))
    .sort();
}

export function provenance(root: string): Provenance {
  // Outside a checkout there is no commit to compare against, but the files are those git archive
  // packed, so the hash matches the one a checkout of the same commit gives.
  if (!inCheckout(root)) return { commit: "none", dirty: false, graderHash: hashOf(root, filesOnDisk(root)) };
  const files = git(root, ["ls-files", "--", ...GRADING_INPUTS]).split("\n").filter(Boolean).sort();
  return {
    commit: git(root, ["rev-parse", "--short", "HEAD"]),
    dirty: git(root, ["status", "--porcelain", "--untracked-files=all", "--", ...GRADING_INPUTS]) !== "",
    graderHash: hashOf(root, files),
  };
}
