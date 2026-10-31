import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

export function verifyWebhook(
  rawBody: string,
  signatureHeader: string,
  secrets: string[],
  nowSeconds: number,
): unknown {
  let timestampText: string | undefined;
  const signatures: Buffer[] = [];

  for (const entry of signatureHeader.split(",")) {
    const separator = entry.indexOf("=");
    if (separator === -1) continue;

    const scheme = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();

    if (scheme === "t") {
      // Reject duplicate timestamps to avoid ambiguous signing inputs.
      if (timestampText !== undefined) {
        throw new Error("Invalid webhook signature");
      }
      timestampText = value;
    } else if (scheme === "v1" && /^[0-9a-fA-F]{64}$/.test(value)) {
      signatures.push(Buffer.from(value, "hex"));
    }
    // Unknown schemes and malformed signature candidates cannot match.
  }

  if (timestampText === undefined || !/^[0-9]+$/.test(timestampText)) {
    throw new Error("Invalid webhook signature");
  }

  const timestamp = Number(timestampText);
  if (
    !Number.isSafeInteger(timestamp) ||
    !Number.isFinite(nowSeconds) ||
    Math.abs(timestamp - nowSeconds) > 300 ||
    signatures.length === 0 ||
    secrets.length === 0
  ) {
    throw new Error("Invalid webhook signature");
  }

  // Preserve the header's timestamp spelling in the authenticated message.
  const signedPayload = `${timestampText}.${rawBody}`;
  let matched = false;

  for (const secret of secrets) {
    const expected = createHmac("sha256", secret)
      .update(signedPayload, "utf8")
      .digest();

    for (const signature of signatures) {
      // Both buffers are exactly 32 bytes. Evaluate every comparison,
      // even after finding a match.
      const matches = timingSafeEqual(expected, signature);
      matched = matches || matched;
    }
  }

  if (!matched) {
    throw new Error("Invalid webhook signature");
  }

  // Parse only authenticated data; invalid JSON throws.
  return JSON.parse(rawBody) as unknown;
}
