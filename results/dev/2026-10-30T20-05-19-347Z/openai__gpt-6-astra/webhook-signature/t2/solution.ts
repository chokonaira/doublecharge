import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

export function verifyWebhook(
  rawBody: string,
  signatureHeader: string,
  secrets: string[],
  nowSeconds: number,
): unknown {
  const invalid = (): never => {
    throw new Error("Invalid webhook signature or timestamp");
  };

  let timestampText: string | undefined;
  const signatures: Buffer[] = [];

  for (const part of signatureHeader.split(",")) {
    const entry = part.trim();
    const separator = entry.indexOf("=");
    const scheme = (separator < 0 ? entry : entry.slice(0, separator)).trim();
    const value = separator < 0 ? "" : entry.slice(separator + 1).trim();

    if (scheme === "t") {
      // Reject ambiguous timestamps rather than choosing one.
      if (timestampText !== undefined || !/^-?\d+$/.test(value)) {
        invalid();
      }
      timestampText = value;
    } else if (scheme === "v1" && /^[0-9a-fA-F]{64}$/.test(value)) {
      signatures.push(Buffer.from(value, "hex"));
    }
    // Unknown schemes and unusable signatures cannot authenticate a request.
  }

  if (timestampText === undefined) {
    invalid();
  }

  const timestamp = Number(timestampText);
  if (
    !Number.isSafeInteger(timestamp) ||
    !Number.isFinite(nowSeconds) ||
    Math.abs(nowSeconds - timestamp) > 300 ||
    signatures.length === 0 ||
    secrets.length === 0
  ) {
    invalid();
  }

  // Preserve the timestamp's header representation in the signed message.
  const message = `${timestampText}.${rawBody}`;
  let matched = false;

  for (const secret of secrets) {
    const expected = createHmac("sha256", secret)
      .update(message, "utf8")
      .digest();

    for (const signature of signatures) {
      // Both buffers are exactly 32 bytes. Do not stop at the first match.
      const matches = timingSafeEqual(expected, signature);
      matched = matches || matched;
    }
  }

  if (!matched) {
    invalid();
  }

  return JSON.parse(rawBody) as unknown;
}
