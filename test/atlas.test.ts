import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "..");

describe("failure atlas", () => {
  it("embeds a run as data that model code cannot break out of", () => {
    const run = mkdtempSync(join(tmpdir(), "doublecharge-atlas-"));
    const hostile = 'export const x = "</script><script>window.pwned = 1</script>";\n';
    writeFileSync(join(run, "manifest.json"), JSON.stringify({ models: ["lab/model"], startedAt: "2026-10-31T00:00:00.000Z", commit: "abc1234", graderHash: "f".repeat(64) }));
    writeFileSync(join(run, "records.json"), JSON.stringify([{ model: "lab/model", task: "checkout", trial: 1, status: "fail", scenarios: [{ scenario: "card declined", pass: false, detail: "<b>not bold</b>" }], cost: 0, ms: 0 }]));
    mkdirSync(join(run, "lab__model", "checkout", "t1"), { recursive: true });
    writeFileSync(join(run, "lab__model", "checkout", "t1", "solution.ts"), hostile);
    const out = join(run, "atlas.html");
    execFileSync(process.execPath, ["--no-warnings", join(ROOT, "src/cli/atlas.ts"), "--eval", run, "--out", out]);

    const page = readFileSync(out, "utf8");
    const embedded = page.slice(page.indexOf('id="atlas-data">') + 'id="atlas-data">'.length, page.indexOf("</script>", page.indexOf('id="atlas-data">')));
    assert.ok(!embedded.includes("<"), "no raw < inside the embedded data");
    const data = JSON.parse(embedded) as { eval: { records: { solution: string; scenarios: { detail: string }[] }[] } };
    assert.equal(data.eval.records[0]?.solution, hostile);
    assert.equal(data.eval.records[0]?.scenarios[0]?.detail, "<b>not bold</b>");
    assert.equal(page.match(/<script>/g)?.length, 1, "only the page's own script element");
    assert.ok(!page.includes("/*DATA*/"));
  });
});
