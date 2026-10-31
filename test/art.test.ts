import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const FILES = ["hero-light.svg", "hero-dark.svg", "architecture-light.svg", "architecture-dark.svg"];

describe("README pictures", () => {
  const out = mkdtempSync(join(tmpdir(), "doublecharge-art-"));
  execFileSync(process.execPath, ["--no-warnings", join(ROOT, "src/cli/art.ts"), "--review", join(ROOT, "results/review-2026-10-31T09-22-41-037Z"), "--out", out]);

  it("are exactly what the generator draws from today's run and repository", () => {
    for (const file of FILES) assert.equal(readFileSync(join(ROOT, "docs", file), "utf8"), readFileSync(join(out, file), "utf8"), `docs/${file} is stale: run npm run art`);
  });

  it("are plain SVG that GitHub will show: no scripts, no external loads, a title for screen readers", () => {
    for (const file of FILES) {
      const svg = readFileSync(join(out, file), "utf8");
      assert.ok(svg.startsWith("<svg "), file);
      assert.doesNotMatch(svg, /<script|href=|url\(|@import/i, file);
      assert.match(svg, /<title id="title">[^<]+<\/title>/, file);
    }
  });

  it("show the hero run's own calls, and what it charged", () => {
    const hero = readFileSync(join(out, "hero-light.svg"), "utf8");
    const result = JSON.parse(readFileSync(join(ROOT, "results/review-2026-10-31T09-22-41-037Z/anthropic__claude-opus-5.5/checkout--mutant-no-idempotency-key/t1/attack-result.rejudged.json"), "utf8")) as { trace: { call: string; result: string }[] };
    const charges = result.trace.filter((t) => t.call.startsWith("payco.createCharge") && t.result.startsWith("processed")).map((t) => Number(t.call.match(/"amount":(\d+)/)![1]));
    const total = (charges.reduce((a, b) => a + b, 0) / 100).toFixed(2);
    assert.match(hero, /processed, but the response was lost \(timeout\)/);
    assert.match(hero, new RegExp(`class="line total"[^>]*>€${total.replace(".", "\\.")}<`), "the last total is the sum of the trace's charges");
    assert.match(hero, new RegExp(`class="verdict"[^>]*>CHARGED ${charges.length === 2 ? "TWICE" : `${charges.length} TIMES`}<`));
    // Reduced motion shows the final frame: one total, the last one.
    assert.equal(hero.match(/class="row later"/g)?.length, 1);
  });
});
