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

  if (!Number.isFinite(nowSeconds)) reject();

  let timestampText: string | undefined;
  const signatures: Buffer[] = [];

  for (const part of signatureHeader.split(",")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;

    const scheme = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (scheme === "t") {
      // Reject duplicate timestamps rather than interpret an ambiguous header.
      if (timestampText !== undefined) reject();
      timestampText = value;
    } else if (scheme === "v1" && /^[0-9a-fA-F]{64}$/.test(value)) {
      signatures.push(Buffer.from(value, "hex"));
    }
    // Unknown schemes and malformed signatures cannot contribute a match.
  }

  if (timestampText === undefined || !/^[0-9]+$/.test(timestampText)) {
    reject();
  }

  const timestamp = Number(timestampText);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(timestamp - nowSeconds) > 300 ||
    signatures.length === 0 ||
    secrets.length === 0
  ) {
    reject();
  }

  // Preserve the header's timestamp spelling in the authenticated payload.
  const payload = `${timestampText}.${rawBody}`;
  let matched = false;

  for (const secret of secrets) {
    const expected = createHmac("sha256", secret)
      .update(payload, "utf8")
      .digest();

    for (const signature of signatures) {
      // All decoded signatures are exactly 32 bytes. Evaluate every pair,
      // without stopping when a matching secret or signature is found.
      const equal = timingSafeEqual(expected, signature);
      matched = equal || matched;
    }
  }

  if (!matched) reject();

  return JSON.parse(rawBody) as unknown;
}
