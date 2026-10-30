const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

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
  choices?: { finish_reason?: string; message?: { content?: string | null } }[];
  usage?: { cost?: number };
  error?: { message?: string; code?: number };
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export async function complete(req: CompletionRequest): Promise<Completion> {
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    const res = await fetch(ENDPOINT, {
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
      }),
      signal: AbortSignal.timeout(900_000),
    });
    const body = (await res.json().catch(() => ({}))) as ChatResponse;
    const choice = body.choices?.[0];
    if (res.ok && !body.error && choice?.message) {
      return {
        content: choice.message.content ?? "",
        finishReason: choice.finish_reason,
        cost: body.usage?.cost ?? 0,
        servedBy: { model: body.model ?? req.model, provider: body.provider },
        ms: Date.now() - started,
        raw: body,
      };
    }
    const reason = `${res.status} ${body.error?.message ?? "no completion in response"}`;
    if (attempt >= 3 || !RETRYABLE.has(res.status)) throw new Error(`OpenRouter: ${reason}`);
    await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
  }
}
