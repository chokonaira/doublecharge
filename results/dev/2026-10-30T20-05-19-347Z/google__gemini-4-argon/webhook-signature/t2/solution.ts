import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhook(
  rawBody: string,
  signatureHeader: string,
  secrets: string[],
  nowSeconds: number
): unknown {
  if (typeof rawBody !== 'string') {
    throw new Error('Invalid rawBody');
  }
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) {
    throw new Error('Missing or invalid signature header');
  }
  if (!Array.isArray(secrets) || secrets.length === 0) {
    throw new Error('No secrets provided');
  }
  if (typeof nowSeconds !== 'number' || !Number.isFinite(nowSeconds)) {
    throw new Error('Invalid nowSeconds');
  }

  let timestampStr: string | undefined;
  const v1Signatures: Buffer[] = [];

  const parts = signatureHeader.split(',');
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;

    const key = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();

    if (key === 't') {
      if (timestampStr !== undefined) {
        throw new Error('Multiple timestamps in signature header');
      }
      timestampStr = value;
    } else if (key === 'v1') {
      // SHA-256 hex digest is 64 hex characters (32 bytes)
      if (/^[0-9a-fA-F]{64}$/.test(value)) {
        v1Signatures.push(Buffer.from(value, 'hex'));
      }
    }
    // Other schemes (e.g. v0) are ignored
  }

  if (!timestampStr || !/^\d+$/.test(timestampStr)) {
    throw new Error('Invalid or missing timestamp in signature header');
  }

  const timestamp = Number(timestampStr);
  if (!Number.isSafeInteger(timestamp)) {
    throw new Error('Timestamp is not a safe integer');
  }

  if (v1Signatures.length === 0) {
    throw new Error('No valid v1 signatures found in header');
  }

  // Compute expected signatures for all valid secrets
  const signedPayload = `${timestampStr}.${rawBody}`;
  const expectedSignatures: Buffer[] = [];

  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      const hmac = createHmac('sha256', secret)
        .update(signedPayload, 'utf8')
        .digest();
      expectedSignatures.push(hmac);
    }
  }

  if (expectedSignatures.length === 0) {
    throw new Error('No valid non-empty secrets provided');
  }

  // Constant-time comparison across all pairs of (expected, provided)
  let matched = false;
  for (const expected of expectedSignatures) {
    for (const provided of v1Signatures) {
      if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
        matched = true;
      }
    }
  }

  if (!matched) {
    throw new Error('Signature verification failed');
  }

  // Check timestamp tolerance (within 300 seconds in either direction)
  if (Math.abs(nowSeconds - timestamp) > 300) {
    throw new Error('Webhook timestamp outside of tolerance window');
  }

  return JSON.parse(rawBody);
}
