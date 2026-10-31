import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

export function verifyWebhook(
  rawBody: string,
  signatureHeader: string,
  secrets: string[],
  nowSeconds: number,
): unknown {
  const reject = (): never => {
    throw new Error("Invalid PayCo webhook signature");
  };

  let timestampText: string | undefined;
  const signatures: Buffer[] = [];

  for (const entry of signatureHeader.split(",")) {
    const separator = entry.indexOf("=");
    if (separator === -1) continue;

    const scheme = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();

    if (scheme === "t") {
      // Reject ambiguous timestamps rather than choosing one.
      if (timestampText !== undefined) reject();
      timestampText = value;
    } else if (scheme === "v1" && /^[0-9a-fA-F]{64}$/.test(value)) {
      // Validate before decoding: Buffer.from otherwise tolerates invalid hex.
      signatures.push(Buffer.from(value, "hex"));
    }
    // Unknown schemes and malformed signatures cannot contribute a match.
  }

  if (timestampText === undefined || !/^-?\d+$/.test(timestampText)) {
    return reject();
  }

  const timestamp = Number(timestampText);
  if (
    !Number.isSafeInteger(timestamp) ||
    !Number.isFinite(nowSeconds) ||
    Math.abs(timestamp - nowSeconds) > 300 ||
    signatures.length === 0 ||
    secrets.length === 0
  ) {
    return reject();
  }

  let matched = 0;
  for (const secret of secrets) {
    // Preserve the timestamp's textual representation in the signed payload.
    const expected = createHmac("sha256", secret)
      .update(`${timestampText}.${rawBody}`, "utf8")
      .digest();

    for (const signature of signatures) {
      // Both buffers are exactly 32 bytes. Check every pair without early exit.
      matched |= Number(timingSafeEqual(expected, signature));
    }
  }

  if (matched === 0) return reject();

  // JSON parsing happens only after authentication; invalid JSON also throws.
  return JSON.parse(rawBody) as unknown;
}
