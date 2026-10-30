import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { complete } from "../src/models/openrouter.ts";

let server: Server;
let baseUrl: string;
let requests: { auth: string | undefined; body: { model: string; max_tokens: number; messages: { role: string }[] } }[] = [];
let script: { status: number; body: unknown }[] = [];

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      const next = script.shift() ?? { status: 500, body: {} };
      res.writeHead(next.status, { "Content-Type": "application/json" }).end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

const ok = { model: "lab/model-x", provider: "Lab", choices: [{ finish_reason: "stop", message: { content: "```ts\nexport {};\n```" } }], usage: { cost: 0.0123 } };
const request = { apiKey: "sk-test", model: "lab/model", system: "sys", prompt: "task", maxTokens: 99 };

describe("OpenRouter client", () => {
  it("sends the request and reads content, cost and who served it", async () => {
    requests = [];
    script = [{ status: 200, body: ok }];
    const reply = await complete(request, { baseUrl, retryDelayMs: 1 });
    assert.equal(reply.content, "```ts\nexport {};\n```");
    assert.equal(reply.cost, 0.0123);
    assert.equal(reply.finishReason, "stop");
    assert.deepEqual(reply.servedBy, { model: "lab/model-x", provider: "Lab" });
    assert.equal(requests[0]?.auth, "Bearer sk-test");
    assert.equal(requests[0]?.body.max_tokens, 99);
    assert.deepEqual(requests[0]?.body.messages.map((m) => m.role), ["system", "user"]);
  });

  it("retries rate limits and server errors", async () => {
    requests = [];
    script = [{ status: 429, body: { error: { message: "slow down" } } }, { status: 502, body: {} }, { status: 200, body: ok }];
    const reply = await complete(request, { baseUrl, retryDelayMs: 1 });
    assert.equal(requests.length, 3);
    assert.equal(reply.cost, 0.0123);
  });

  it("gives up after three attempts", async () => {
    script = [{ status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} }];
    await assert.rejects(complete(request, { baseUrl, retryDelayMs: 1 }), /OpenRouter: 503/);
  });

  it("does not retry a request error", async () => {
    requests = [];
    script = [{ status: 402, body: { error: { message: "insufficient credits" } } }];
    await assert.rejects(complete(request, { baseUrl, retryDelayMs: 1 }), /402 insufficient credits/);
    assert.equal(requests.length, 1);
  });

  it("treats a 200 without a completion as an error", async () => {
    script = [{ status: 200, body: { error: { message: "upstream failed", code: 502 } } }];
    await assert.rejects(complete(request, { baseUrl, retryDelayMs: 1 }), /upstream failed/);
  });
});
