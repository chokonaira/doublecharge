import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadEnv, requireEnv } from "../src/env.ts";

describe("env", () => {
  it("returns a set variable", () => {
    process.env.DOUBLECHARGE_TEST_VAR = "value";
    assert.equal(requireEnv("DOUBLECHARGE_TEST_VAR"), "value");
  });

  it("explains how to fix a missing variable", () => {
    delete process.env.DOUBLECHARGE_TEST_MISSING;
    assert.throws(() => requireEnv("DOUBLECHARGE_TEST_MISSING"), /Copy \.env\.example to \.env/);
  });

  it("does not read .env when told to skip it", () => {
    process.env.DOUBLECHARGE_SKIP_DOTENV = "1";
    delete process.env.OPENROUTER_API_KEY;
    loadEnv();
    assert.equal(process.env.OPENROUTER_API_KEY, undefined);
  });
});
