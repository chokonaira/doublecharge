const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export interface CompletionRequest {
  apiKey: string;
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
}

export interface Completion {
  content: string;
  finishReason: string | undefined;
  /** USD, as billed by OpenRouter. */
  cost: number;
  /** Model and upstream provider that actually served the request. */
  servedBy: { model: string; provider: string | undefined };
  ms: number;
  raw: unknown;
}

interface ChatResponse {
  model?: string;
  provider?: string;
  choices?: { finish_reason?: string | null; message?: { content?: string | null }; delta?: { content?: string | null } }[];
  usage?: { cost?: number };
  error?: { message?: string; code?: number };
}

/** HTTP statuses worth another try. A 200 with no completion (an upstream hiccup) is retried too. */
const RETRYABLE = new Set([200, 408, 429, 500, 502, 503, 504]);

class Retryable extends Error {}

/**
 * Reads a streamed reply. Streaming keeps bytes flowing while a model reasons for minutes, so a long
 * review never trips a client's wait-for-headers timeout.
 */
async function readStream(res: Response): Promise<ChatResponse> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const reply: ChatResponse = { choices: [{ message: { content: "" } }] };
  let buffered = "";
  let content = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += value;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue; // blank lines and ": keep-alive" comments
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      const chunk = JSON.parse(data) as ChatResponse;
      if (chunk.error) return { error: chunk.error };
      reply.model ??= chunk.model;
      reply.provider ??= chunk.provider;
      if (chunk.usage) reply.usage = chunk.usage;
      const choice = chunk.choices?.[0];
      content += choice?.delta?.content ?? "";
      if (choice?.finish_reason) reply.choices![0]!.finish_reason = choice.finish_reason;
    }
  }
  reply.choices![0]!.message!.content = content;
  return reply;
}

export interface CompleteOptions {
  /** Defaults to OPENROUTER_BASE_URL, then OpenRouter's public API. */
  baseUrl?: string;
  retryDelayMs?: number;
}

export async function complete(req: CompletionRequest, opts: CompleteOptions = {}): Promise<Completion> {
  const endpoint = `${opts.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL}/chat/completions`;
  const retryDelayMs = opts.retryDelayMs ?? 5000;
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${req.apiKey}`, "Content-Type": "application/json", "X-Title": "DoubleCharge" },
        body: JSON.stringify({
          model: req.model,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.prompt },
          ],
          max_tokens: req.maxTokens,
          usage: { include: true },
          stream: true,
        }),
        signal: AbortSignal.timeout(900_000),
      });
      const streamed = res.ok && (res.headers.get("content-type") ?? "").includes("text/event-stream");
      const body = streamed ? await readStream(res) : ((await res.json().catch(() => ({}))) as ChatResponse);
      const choice = body.choices?.[0];
      if (res.ok && !body.error && choice?.message && (choice.message.content || choice.finish_reason)) {
        return {
          content: choice.message.content ?? "",
          finishReason: choice.finish_reason ?? undefined,
          cost: body.usage?.cost ?? 0,
          servedBy: { model: body.model ?? req.model, provider: body.provider },
          ms: Date.now() - started,
          raw: body,
        };
      }
      const reason = `${res.status} ${body.error?.message ?? "no completion in response"}`;
      if (!RETRYABLE.has(res.status)) throw new Error(`OpenRouter: ${reason}`);
      throw new Retryable(`OpenRouter: ${reason}`);
    } catch (e) {
      // Network failures (a dropped connection, a reset) and retryable statuses get another try.
      const retryable = e instanceof Retryable || (e instanceof TypeError && /fetch failed|terminated/i.test(e.message));
      if (!retryable || attempt >= 3) throw e instanceof Retryable ? new Error(e.message) : e;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
}
