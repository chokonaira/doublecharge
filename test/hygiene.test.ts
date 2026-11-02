import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "..");
/** The files that ship: those git tracks, or in an unpacked source archive (no .git), every file there. */
function shipped(): string[] {
  try {
    return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
  } catch {
    const walk = (dir: string): string[] =>
      readdirSync(dir)
        .filter((name) => name !== "node_modules" && name !== ".git")
        .flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [relative(ROOT, join(dir, name))]));
    return walk(ROOT);
  }
}
const tracked = shipped();

describe("repository hygiene", () => {
  it("contains no machine-specific absolute paths", () => {
    const offenders = tracked.filter((file) => /\.(ts|md|json|yml)$/.test(file) && /\/(Users|home)\/[a-z]/.test(readFileSync(join(ROOT, file), "utf8")));
    assert.deepEqual(offenders, []);
  });

  it("contains no API keys", () => {
    const offenders = tracked.filter((file) => /sk-or-v1-[0-9a-f]{20,}/.test(readFileSync(join(ROOT, file), "utf8")));
    assert.deepEqual(offenders, []);
  });
});
