import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);

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
