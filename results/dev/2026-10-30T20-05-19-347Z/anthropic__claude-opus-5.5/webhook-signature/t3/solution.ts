import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 300;
const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;

/**
 * Verifies a PayCo webhook signature and returns the parsed JSON body.
 * Throws if the header is malformed, no v1 signature matches any secret,
 * the timestamp is outside the tolerance window, or the body is not valid JSON.
 */
export function verifyWebhook(
  rawBody: string,
  signatureHeader: string,
  secrets: string[],
  nowSeconds: number
): unknown {
  if (typeof rawBody !== "string") throw new Error("Invalid webhook: body must be a string");
  if (typeof signatureHeader !== "string" || signatureHeader.length === 0) {
    throw new Error("Invalid webhook: missing signature header");
  }
  if (!Array.isArray(secrets)) throw new Error("Invalid webhook: no secrets configured");
  if (typeof nowSeconds !== "number" || !Number.isFinite(nowSeconds)) {
    throw new Error("Invalid webhook: invalid current time");
  }

  // Skip empty secrets: an empty HMAC key would make signatures forgeable.
  const usableSecrets = secrets.filter((s) => typeof s === "string" && s.length > 0);
  if (usableSecrets.length === 0) throw new Error("Invalid webhook: no secrets configured");

  // Parse header: comma-separated key=value pairs. Unknown schemes (e.g. v0) are ignored.
  let tRaw: string | undefined;
  const v1Signatures: Buffer[] = [];
  for (const part of signatureHeader.split(",")) {
    const item = part.trim();
    const eq = item.indexOf("=");
    if (eq <= 0) continue;
    const key = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (key === "t") {
      if (tRaw !== undefined) throw new Error("Invalid webhook: duplicate timestamp");
      tRaw = value;
    } else if (key === "v1") {
      // Only well-formed SHA-256 hex digests are considered; others can never match.
      if (HEX_SHA256.test(value)) v1Signatures.push(Buffer.from(value, "hex"));
    }
  }

  if (tRaw === undefined || !/^\d{1,15}$/.test(tRaw)) {
    throw new Error("Invalid webhook: missing or malformed timestamp");
  }
  if (v1Signatures.length === 0) {
    throw new Error("Invalid webhook: no v1 signatures");
  }

  const t = Number(tRaw);
  if (Math.abs(nowSeconds - t) > TOLERANCE_SECONDS) {
    throw new Error("Invalid webhook: timestamp outside tolerance");
  }

  // Signed payload uses the timestamp exactly as it appears in the header.
  const signedPayload = `${tRaw}.${rawBody}`;

  // Check every (secret, signature) pair without early exit so timing does not
  // reveal which pair matched; each comparison itself is constant-time.
  let matched = false;
  for (const secret of usableSecrets) {
    const expected = createHmac("sha256", secret).update(signedPayload, "utf8").digest();
    for (const sig of v1Signatures) {
      if (sig.length === expected.length && timingSafeEqual(sig, expected)) {
        matched = true;
      }
    }
  }

  if (!matched) throw new Error("Invalid webhook: signature mismatch");

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new Error("Invalid webhook: body is not valid JSON");
  }
}
