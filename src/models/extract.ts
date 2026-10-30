const FENCE = /```(?:ts|typescript|js|javascript)?[ \t]*\n([\s\S]*?)```/g;

/** Returns the largest fenced code block in a model reply, or undefined when there is none. */
export function extractCode(reply: string): string | undefined {
  const blocks = [...reply.matchAll(FENCE)].map((m) => m[1] ?? "");
  return blocks.sort((a, b) => b.length - a.length)[0];
}
