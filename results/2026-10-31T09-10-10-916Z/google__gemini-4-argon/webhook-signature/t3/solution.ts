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
  if (typeof signatureHeader !== 'string' || !signatureHeader) {
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
    if (eqIdx === -1) {
      continue;
    }
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();

    if (key === 't') {
      if (timestampStr !== undefined) {
        throw new Error('Multiple timestamps in signature header');
      }
      timestampStr = val;
    } else if (key === 'v1') {
      // SHA-256 hex digest is always 64 hex characters (32 bytes)
      if (/^[0-9a-fA-F]{64}$/.test(val)) {
        v1Signatures.push(Buffer.from(val, 'hex'));
      }
    }
    // Other schemes (e.g., v0) are ignored
  }

  if (timestampStr === undefined || !/^\d+$/.test(timestampStr)) {
    throw new Error('Invalid or missing timestamp');
  }

  const timestamp = Number(timestampStr);
  if (!Number.isSafeInteger(timestamp)) {
    throw new Error('Timestamp is not a safe integer');
  }

  if (Math.abs(nowSeconds - timestamp) > 300) {
    throw new Error('Timestamp outside the 300s tolerance window');
  }

  if (v1Signatures.length === 0) {
    throw new Error('No valid v1 signatures found');
  }

  const signedPayload = `${timestampStr}.${rawBody}`;
  let matched = false;

  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) {
      continue;
    }
    const expectedSig = createHmac('sha256', secret).update(signedPayload, 'utf8').digest();

    for (const sig of v1Signatures) {
      if (sig.length === expectedSig.length && timingSafeEqual(sig, expectedSig)) {
        matched = true;
      }
    }
  }

  if (!matched) {
    throw new Error('Signature verification failed');
  }

  return JSON.parse(rawBody);
}
