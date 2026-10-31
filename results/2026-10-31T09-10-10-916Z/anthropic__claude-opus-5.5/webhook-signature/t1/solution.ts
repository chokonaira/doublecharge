import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 300;
const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;
const UNIX_SECONDS = /^\d{1,15}$/;

/**
 * Verifies a PayCo webhook signature and returns the parsed JSON body.
 * Throws on any failure: malformed header, stale or future timestamp,
 * no matching signature, or a body that is not valid JSON.
 */
export function verifyWebhook(
  rawBody: string,
  signatureHeader: string,
  secrets: string[],
  nowSeconds: number,
): unknown {
  if (typeof rawBody !== "string") throw new Error("Invalid webhook body");
  if (typeof signatureHeader !== "string" || signatureHeader.length === 0) {
    throw new Error("Missing webhook signature header");
  }
  if (!Array.isArray(secrets)) throw new Error("No webhook secrets configured");

  // Empty secrets are skipped: an HMAC keyed with "" is not a real secret.
  const usableSecrets = secrets.filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  if (usableSecrets.length === 0) throw new Error("No webhook secrets configured");

  if (typeof nowSeconds !== "number" || !Number.isFinite(nowSeconds)) {
    throw new Error("Invalid current time");
  }

  // Parse the header into a timestamp and v1 signatures.
  let timestampStr: string | undefined;
  const v1Signatures: Buffer[] = [];

  for (const rawPart of signatureHeader.split(",")) {
    const part = rawPart.trim();
    if (part.length === 0) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) continue; // malformed entry: ignore it
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();

    if (key === "t") {
      // Several t values are ambiguous, so the header is rejected.
      if (timestampStr !== undefined) throw new Error("Duplicate timestamp in signature header");
      timestampStr = value;
    } else if (key === "v1") {
      // Only well-formed 64-hex-char signatures are kept.
      // Buffer.from(...,'hex') silently truncates invalid input, so check first.
      if (HEX_SHA256.test(value)) {
        v1Signatures.push(Buffer.from(value, "hex"));
      }
    }
    // Other schemes (v0, ...) are ignored.
  }

  if (timestampStr === undefined || !UNIX_SECONDS.test(timestampStr)) {
    throw new Error("Missing or invalid timestamp in signature header");
  }
  if (v1Signatures.length === 0) {
    throw new Error("No v1 signature in signature header");
  }

  const timestamp = Number(timestampStr);
  if (!Number.isSafeInteger(timestamp)) throw new Error("Invalid timestamp");
  if (Math.abs(nowSeconds - timestamp) > TOLERANCE_SECONDS) {
    throw new Error("Webhook timestamp outside tolerance");
  }

  // The signed payload uses the timestamp exactly as it appears in the header.
  const signedPayload = `${timestampStr}.${rawBody}`;

  // Every (secret, signature) pair is checked without exiting early,
  // so timing does not reveal which pair matched.
  let matched = false;
  for (const secret of usableSecrets) {
    const expected = createHmac("sha256", secret).update(signedPayload, "utf8").digest();
    for (const sig of v1Signatures) {
      // Both are 32 bytes: the regex check guarantees it for sig.
      if (sig.length === expected.length && timingSafeEqual(sig, expected)) {
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
