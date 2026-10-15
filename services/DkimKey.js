// ─── DkimKey — validate DKIM public keys (controller) ─────────────────────────
//
// The controller receives the base64 DKIM public key from the mail-node and
// publishes it to Cloudflare. A key truncated by the old mail-node multi-segment
// parsing bug is still valid base64 and still "has a p=", but its bytes are an
// incomplete DER structure that no verifier (Gmail: "invalid public key") will
// accept. isValidDkimPublicKey decodes and parses the key so the controller can:
//   • refuse to publish an invalid/truncated key, and
//   • detect that a previously-stored key is truncated and needs repair.
//
// This mirrors mail-node/services/DkimKey.js; the two packages do not share code.

import { createPublicKey } from 'node:crypto';

export function isValidDkimPublicKey(base64) {
  if (!base64 || typeof base64 !== 'string') return false;
  const clean = base64.replace(/\s/g, '');
  if (!clean) return false;
  try {
    const der = Buffer.from(clean, 'base64');
    if (der.length < 100) return false; // too short to be a real RSA SPKI
    createPublicKey({ key: der, format: 'der', type: 'spki' });
    return true;
  } catch {
    return false;
  }
}
