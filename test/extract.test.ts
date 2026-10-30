import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractCode } from "../src/models/extract.ts";

describe("extractCode", () => {
  it("prefers the block that exports the entry function over a larger one", () => {
    const reply = "```ts\nexport function checkout() {}\n```\n```ts\n// a long helper module\nexport const helper = 1;\nexport const more = 2;\n```";
    assert.equal(extractCode(reply, "checkout"), "export function checkout() {}\n");
  });

  it("falls back to the largest code block", () => {
    const reply = "```ts\nexport const a = 1;\n```\n```ts\nexport function big() {\n  return 2;\n}\n```";
    assert.equal(extractCode(reply), "export function big() {\n  return 2;\n}\n");
  });

  it("does not pair one block's closing fence with the next block's opening (review finding)", () => {
    const reply = "Run it with:\n```bash\nnpm test\n```\nImplementation:\n```ts\nexport async function checkout() {}\n```";
    assert.equal(extractCode(reply, "checkout"), "export async function checkout() {}\n");
  });

  it("accepts any case and common TypeScript/JavaScript tags, and ignores other languages", () => {
    assert.equal(extractCode("```TypeScript\nx\n```"), "x\n");
    assert.equal(extractCode("```tsx\ny\n```"), "y\n");
    assert.equal(extractCode("```\nz\n```"), "z\n");
    assert.equal(extractCode("```bash\nnpm test\n```"), undefined);
  });

  it("recognises export lists and arrow-function exports of the entry", () => {
    assert.equal(extractCode("```ts\nconst checkout = async () => {};\nexport { checkout };\n```\n```ts\n// unrelated but longer block of code here\n```", "checkout"), "const checkout = async () => {};\nexport { checkout };\n");
    assert.equal(extractCode("```ts\nexport const checkout = async () => {};\n```\n```ts\n// unrelated but longer block of code here\n```", "checkout"), "export const checkout = async () => {};\n");
  });

  it("returns undefined when there is no code block", () => {
    assert.equal(extractCode("I cannot do that."), undefined);
  });
});
