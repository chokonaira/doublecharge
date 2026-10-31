import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { provenance } from "../src/report/provenance.ts";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "doublecharge-prov-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "README.md"), "docs\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return root;
}

describe("provenance", () => {
  it("is clean and stable for a committed tree", () => {
    const root = repo();
    const first = provenance(root);
    assert.equal(first.dirty, false);
    assert.match(first.graderHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(provenance(root), first);
  });

  it("flags edits and new files in grading inputs, and changes the hash", () => {
    const root = repo();
    const before = provenance(root);
    writeFileSync(join(root, "src/a.ts"), "export const a = 2;\n");
    const after = provenance(root);
    assert.equal(after.dirty, true);
    assert.notEqual(after.graderHash, before.graderHash);
    const fresh = repo();
    writeFileSync(join(fresh, "src/new.ts"), "export {};\n");
    assert.equal(provenance(fresh).dirty, true);
  });

  it("outside a git checkout, as in an unpacked submission zip, hashes the same files the same way", () => {
    const root = repo();
    mkdirSync(join(root, "tasks/t"), { recursive: true });
    writeFileSync(join(root, "tasks/t/prompt.md"), "spec\n");
    writeFileSync(join(root, "package.json"), "{}\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "more"], { cwd: root });
    const inRepo = provenance(root);
    const unpacked = mkdtempSync(join(tmpdir(), "doublecharge-zip-"));
    cpSync(root, unpacked, { recursive: true });
    rmSync(join(unpacked, ".git"), { recursive: true });
    const fromZip = provenance(unpacked);
    assert.deepEqual(fromZip, { commit: "none", dirty: false, graderHash: inRepo.graderHash });
  });

  it("ignores changes outside the grading inputs", () => {
    const root = repo();
    writeFileSync(join(root, "README.md"), "edited docs\n");
    assert.equal(provenance(root).dirty, false);
  });
});
