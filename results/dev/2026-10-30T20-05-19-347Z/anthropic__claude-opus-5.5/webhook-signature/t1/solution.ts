import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 300;
const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;
const DIGITS = /^\d{1,15}$/; // a plain non-negative integer, safely representable

/**
 * Verifies a PayCo webhook and returns the parsed JSON body.
 * Throws an Error if the header is malformed, the timestamp is outside the
 * tolerance window, no v1 signature matches any secret, or the body is not valid JSON.
 */
export function verifyWebhook(
  rawBody: string,
  signatureHeader: string,
  secrets: string[],
  nowSeconds: number
): unknown {
  if (typeof rawBody !== "string") throw new Error("Webhook body must be a string");
  if (typeof signatureHeader !== "string" || signatureHeader.length === 0) {
    throw new Error("Missing webhook signature header");
  }
  if (!Number.isFinite(nowSeconds)) throw new Error("Invalid current time");

  const usableSecrets = (Array.isArray(secrets) ? secrets : []).filter(
    (s): s is string => typeof s === "string" && s.length > 0
  );
  if (usableSecrets.length === 0) throw new Error("No webhook secrets configured");

  // Parse the header.
  let timestamp: string | undefined;
  const v1Signatures: Buffer[] = [];

  for (const rawPart of signatureHeader.split(",")) {
    const part = rawPart.trim();
    if (part.length === 0) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) continue; // Ignore malformed or unknown fragments.
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();

    if (key === "t") {
      // Reject multiple timestamps: it would be ambiguous which one was signed.
      if (timestamp !== undefined) throw new Error("Multiple timestamps in signature header");
      timestamp = value;
    } else if (key === "v1") {
      // Skip v1 values that are not well-formed hex SHA-256 digests.
      if (HEX_SHA256.test(value)) v1Signatures.push(Buffer.from(value, "hex"));
    }
    // Other schemes (v0, etc.) are ignored.
  }

  if (timestamp === undefined || !DIGITS.test(timestamp)) {
    throw new Error("Missing or invalid timestamp in signature header");
  }
  if (v1Signatures.length === 0) throw new Error("No v1 signature in signature header");

  const t = Number(timestamp);
  if (Math.abs(nowSeconds - t) > TOLERANCE_SECONDS) {
    throw new Error("Webhook timestamp outside tolerance window");
  }

  // Sign the exact timestamp string from the header.
  const signedPayload = `${timestamp}.${rawBody}`;
  let matched = false;
  for (const secret of usableSecrets) {
    const expected = createHmac("sha256", secret).update(signedPayload, "utf8").digest();
    for (const candidate of v1Signatures) {
      // Both buffers are 32 bytes (enforced by the regex), so timingSafeEqual cannot throw.
      // Do not short-circuit, so timing does not reveal which entry matched.
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
        matched = true;
      }
    }
  }
  if (!matched) throw new Error("Webhook signature verification failed");

  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    throw new Error("Webhook body is not valid JSON");
  }
}
