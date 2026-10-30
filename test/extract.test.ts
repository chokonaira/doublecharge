import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractCode } from "../src/models/extract.ts";

describe("extractCode", () => {
  it("takes the largest fenced block", () => {
    const reply = "Here:\n```ts\nexport const a = 1;\n```\nand a helper\n```ts\nexport function big() {\n  return 2;\n}\n```";
    assert.equal(extractCode(reply), "export function big() {\n  return 2;\n}\n");
  });

  it("accepts typescript, js and untagged fences", () => {
    assert.equal(extractCode("```typescript\nx\n```"), "x\n");
    assert.equal(extractCode("```\ny\n```"), "y\n");
  });

  it("returns undefined when there is no code block", () => {
    assert.equal(extractCode("I cannot do that."), undefined);
  });
});
