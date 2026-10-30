import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhook(rawBody: string, signatureHeader: string, secrets: string[], nowSeconds: number): unknown {
  let t: number | undefined;
  const signatures: Buffer[] = [];
  for (const part of signatureHeader.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t" && /^\d+$/.test(value)) t = Number(value);
    if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) signatures.push(Buffer.from(value.toLowerCase(), "utf8"));
  }
  if (t === undefined || signatures.length === 0) throw new Error("malformed signature header");
  if (Math.abs(nowSeconds - t) > 300) throw new Error("timestamp outside tolerance");

  const matches = secrets.some((secret) => {
    const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"), "utf8");
    return signatures.some((signature) => timingSafeEqual(expected, signature));
  });
  if (!matches) throw new Error("no matching signature");
  return JSON.parse(rawBody);
}
