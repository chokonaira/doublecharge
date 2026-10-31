import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 300;
const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;

/**
 * Verifies a PayCo webhook signature header and returns the parsed JSON body.
 * Throws on any verification failure.
 */
export function verifyWebhook(
  rawBody: string,
  signatureHeader: string,
  secrets: string[],
  nowSeconds: number
): unknown {
  if (typeof rawBody !== "string") throw new Error("Invalid webhook body");
  if (typeof signatureHeader !== "string" || signatureHeader.length === 0) {
    throw new Error("Missing webhook signature header");
  }
  if (!Array.isArray(secrets)) {
    throw new Error("No webhook secrets configured");
  }
  const usableSecrets = secrets.filter((s) => typeof s === "string" && s.length > 0);
  if (usableSecrets.length === 0) {
    throw new Error("No webhook secrets configured");
  }
  if (typeof nowSeconds !== "number" || !Number.isFinite(nowSeconds)) {
    throw new Error("Invalid current time");
  }

  // Parse header: comma-separated key=value pairs. Unknown schemes are ignored.
  let timestampRaw: string | undefined;
  let timestampCount = 0;
  const v1Signatures: Buffer[] = [];

  for (const part of signatureHeader.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t") {
      timestampCount++;
      timestampRaw = value;
    } else if (key === "v1") {
      // Only well-formed SHA-256 hex digests can ever match; skip anything else.
      if (HEX_SHA256.test(value)) {
        v1Signatures.push(Buffer.from(value, "hex"));
      }
    }
    // Other schemes (e.g. v0) are deliberately ignored.
  }

  // Exactly one timestamp is required; ambiguity is rejected.
  if (timestampCount !== 1 || timestampRaw === undefined || !/^\d+$/.test(timestampRaw)) {
    throw new Error("Invalid or missing webhook timestamp");
  }
  const timestamp = Number(timestampRaw);
  if (!Number.isSafeInteger(timestamp)) {
    throw new Error("Invalid webhook timestamp");
  }
  if (v1Signatures.length === 0) {
    throw new Error("No v1 webhook signature found");
  }

  // Sign exactly the timestamp text as received, so the signed payload matches PayCo's.
  const signedPayload = `${timestampRaw}.${rawBody}`;

  // Check every (secret, signature) pair without early exit to avoid leaking
  // which pair matched via timing.
  let matched = false;
  for (const secret of usableSecrets) {
    const expected = createHmac("sha256", secret).update(signedPayload, "utf8").digest();
    for (const sig of v1Signatures) {
      // Lengths are guaranteed equal (32 bytes) by the hex regex above.
      if (sig.length === expected.length && timingSafeEqual(sig, expected)) {
        matched = true;
      }
    }
  }

  if (!matched) {
    throw new Error("Webhook signature verification failed");
  }

  if (Math.abs(nowSeconds - timestamp) > TOLERANCE_SECONDS) {
    throw new Error("Webhook timestamp outside tolerance");
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new Error("Webhook body is not valid JSON");
  }
}
