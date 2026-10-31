import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 300;
const HEX_SHA256_RE = /^[0-9a-fA-F]{64}$/;
const TIMESTAMP_RE = /^\d{1,15}$/;

/**
 * Verifies a PayCo webhook signature and returns the parsed JSON body.
 * Throws on any verification failure.
 *
 * Notes:
 * - The HMAC is computed over `${t}.${rawBody}` using the exact `t` string
 *   from the header, as PayCo signed it.
 * - rawBody must be the exact raw request body. Re-serialised JSON will not verify.
 * - Signatures are compared with crypto.timingSafeEqual on equal-length
 *   decoded buffers. Malformed v1 values are discarded before comparison.
 *   The fact that a header is malformed is not secret.
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
  if (!Array.isArray(secrets)) throw new Error("No webhook secrets configured");
  const usableSecrets = secrets.filter(
    (s): s is string => typeof s === "string" && s.length > 0
  );
  if (usableSecrets.length === 0) throw new Error("No webhook secrets configured");
  if (typeof nowSeconds !== "number" || !Number.isFinite(nowSeconds)) {
    throw new Error("Invalid current time");
  }

  // Parse the header.
  let timestamp: string | undefined;
  let timestampCount = 0;
  const signatures: Buffer[] = [];

  for (const part of signatureHeader.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t") {
      timestampCount++;
      timestamp = value;
    } else if (key === "v1") {
      if (HEX_SHA256_RE.test(value)) {
        signatures.push(Buffer.from(value, "hex"));
      }
    }
    // Other schemes (e.g. v0) are ignored.
  }

  // Reject a missing or ambiguous (repeated) timestamp.
  if (timestampCount !== 1 || timestamp === undefined || !TIMESTAMP_RE.test(timestamp)) {
    throw new Error("Invalid or missing webhook timestamp");
  }
  if (signatures.length === 0) {
    throw new Error("No valid v1 signature in webhook header");
  }

  const t = Number(timestamp);
  if (!Number.isSafeInteger(t) || Math.abs(nowSeconds - t) > TOLERANCE_SECONDS) {
    throw new Error("Webhook timestamp outside tolerance");
  }

  // Compare every signature against every secret without short-circuiting.
  const signedPayload = `${timestamp}.${rawBody}`;
  let matched = false;
  for (const secret of usableSecrets) {
    const expected = createHmac("sha256", secret).update(signedPayload, "utf8").digest();
    for (const sig of signatures) {
      // Both are 32 bytes (validated above), so timingSafeEqual will not throw.
      if (sig.length === expected.length && timingSafeEqual(sig, expected)) {
        matched = true;
      }
    }
  }

  if (!matched) {
    throw new Error("Webhook signature verification failed");
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new Error("Webhook body is not valid JSON");
  }
}
