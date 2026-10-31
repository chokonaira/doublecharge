import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 300;
const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;
const DIGITS = /^\d{1,15}$/;

/**
 * Verifies a PayCo webhook signature and returns the parsed JSON body.
 * Throws if the header is malformed, the timestamp is outside the tolerance
 * window, no v1 signature matches any active secret, or the body is not valid JSON.
 */
export function verifyWebhook(
  rawBody: string,
  signatureHeader: string,
  secrets: string[],
  nowSeconds: number
): unknown {
  if (typeof rawBody !== "string") throw new Error("Webhook body must be a raw string");
  if (typeof signatureHeader !== "string" || signatureHeader.length === 0) {
    throw new Error("Missing webhook signature header");
  }
  if (typeof nowSeconds !== "number" || !Number.isFinite(nowSeconds)) {
    throw new Error("Invalid current time");
  }
  const activeSecrets = (Array.isArray(secrets) ? secrets : []).filter(
    (s): s is string => typeof s === "string" && s.length > 0
  );
  if (activeSecrets.length === 0) throw new Error("No webhook secrets configured");

  // --- Parse header ---
  let timestamp: string | undefined;
  const v1Signatures: Buffer[] = [];

  for (const rawPart of signatureHeader.split(",")) {
    const part = rawPart.trim();
    if (part.length === 0) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) continue; // malformed element; ignore
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();

    if (key === "t") {
      // Reject ambiguous headers carrying more than one timestamp.
      if (timestamp !== undefined) throw new Error("Multiple timestamps in signature header");
      timestamp = value;
    } else if (key === "v1") {
      // Only well-formed SHA-256 hex digests are considered; others can never match.
      if (HEX_SHA256.test(value)) v1Signatures.push(Buffer.from(value, "hex"));
    }
    // Other schemes (e.g. v0) are ignored.
  }

  if (timestamp === undefined || !DIGITS.test(timestamp)) {
    throw new Error("Missing or invalid timestamp in signature header");
  }
  if (v1Signatures.length === 0) throw new Error("No v1 signature in header");

  // --- Timestamp tolerance (both directions) ---
  const t = Number(timestamp);
  if (Math.abs(nowSeconds - t) > TOLERANCE_SECONDS) {
    throw new Error("Webhook timestamp outside tolerance window");
  }

  // --- Signature check (constant-time comparisons) ---
  // Sign exactly the timestamp string as received, with the untouched raw body.
  const signedPayload = `${timestamp}.${rawBody}`;
  let matched = false;
  for (const secret of activeSecrets) {
    const expected = createHmac("sha256", secret).update(signedPayload, "utf8").digest();
    for (const sig of v1Signatures) {
      // Lengths are guaranteed equal (32 bytes) by the hex regex above.
      if (sig.length === expected.length && timingSafeEqual(sig, expected)) {
        matched = true; // keep looping to avoid leaking which entry matched
      }
    }
  }
  if (!matched) throw new Error("Webhook signature verification failed");

  // --- Parse body only after authentication ---
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    throw new Error("Webhook body is not valid JSON");
  }
}
