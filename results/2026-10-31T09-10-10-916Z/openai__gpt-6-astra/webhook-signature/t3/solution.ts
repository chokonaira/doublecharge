import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

export function verifyWebhook(
  rawBody: string,
  signatureHeader: string,
  secrets: string[],
  nowSeconds: number,
): unknown {
  const invalid = (): Error => new Error("Invalid webhook signature");

  let timestampText: string | undefined;
  const signatures: Buffer[] = [];

  for (const part of signatureHeader.split(",")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;

    const scheme = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (scheme === "t") {
      // Reject ambiguous headers rather than choosing between timestamps.
      if (timestampText !== undefined) throw invalid();
      timestampText = value;
    } else if (scheme === "v1" && /^[0-9a-fA-F]{64}$/.test(value)) {
      // Validate before decoding: Buffer.from otherwise tolerates invalid hex.
      signatures.push(Buffer.from(value, "hex"));
    }
    // Unknown schemes and malformed signature candidates are ignored.
  }

  if (timestampText === undefined || !/^-?\d+$/.test(timestampText)) {
    throw invalid();
  }

  const timestamp = Number(timestampText);
  if (
    !Number.isSafeInteger(timestamp) ||
    !Number.isFinite(nowSeconds) ||
    Math.abs(timestamp - nowSeconds) > 300 ||
    signatures.length === 0 ||
    secrets.length === 0
  ) {
    throw invalid();
  }

  // Preserve the timestamp's original representation and the exact raw body.
  const signedPayload = `${timestampText}.${rawBody}`;
  let matched = false;

  for (const secret of secrets) {
    const expected = createHmac("sha256", secret)
      .update(signedPayload, "utf8")
      .digest();

    for (const signature of signatures) {
      // Both buffers are exactly 32 bytes. Do not stop at the first match.
      if (timingSafeEqual(expected, signature)) matched = true;
    }
  }

  if (!matched) throw invalid();

  return JSON.parse(rawBody) as unknown;
}
