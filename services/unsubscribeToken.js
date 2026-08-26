// ─── Unsubscribe token (HMAC-signed, opaque, no PII) ──────────────────────────
//
// Single source of truth for building and verifying recipient-facing unsubscribe
// URLs.  Used by:
//   • node-facing job endpoints (attach `unsubscribeUrl` to each dispatched job)
//   • the public unsubscribe endpoint (verify the token on GET/POST)
//
// Design goals (see deliverability audit P0 #1):
//   • The URL must NOT expose the recipient's email address.  The token carries
//     the contact's integer PK (`c`) — an opaque internal id, not PII — which the
//     endpoint resolves back to a contact row server-side.
//   • Tamper-resistant: the payload is signed with HMAC-SHA256 using a server-side
//     secret.  Changing `c` (to target another recipient) invalidates the signature.
//   • Self-contained: no DB write at send time; the token verifies statelessly.
//   • Same token works for both the visible-body flow and the RFC 8058 one-click flow.
//
// Token format:  base64url(payloadJSON) + "." + base64url(HMAC_SHA256(payloadB64))

import crypto from 'crypto';

// Recipient-facing base URL.  MUST be under the sending domain (e.g. serawin.net)
// so the unsubscribe host aligns with the authenticated From domain.  The
// controller/backend may live on a different (internal) domain and be reached via
// a reverse proxy — see UNSUBSCRIBE.md for the DNS/Nginx wiring.
export function unsubscribeBaseUrl() {
  return (process.env.UNSUBSCRIBE_BASE_URL || 'https://unsubscribe.serawin.net').replace(/\/+$/, '');
}
const baseUrl = unsubscribeBaseUrl;

// Server-side secret.  Prefers a dedicated UNSUBSCRIBE_SECRET; falls back to
// JWT_SECRET (already required at boot) so there is always a high-entropy key.
function secret() {
  const s = process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET;
  if (!s) throw new Error('UNSUBSCRIBE_SECRET (or JWT_SECRET) must be set to sign unsubscribe tokens');
  return s;
}

function hmac(payloadB64) {
  return crypto.createHmac('sha256', secret()).update(payloadB64).digest('base64url');
}

// signToken({ c, ... }) → "payload.signature"
export function signToken(payload) {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadB64}.${hmac(payloadB64)}`;
}

// verifyToken(token) → payload object, or null if malformed / bad signature.
// Uses a constant-time comparison to avoid signature-timing leaks.
export function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const payloadB64 = token.slice(0, dot);
  const sig        = token.slice(dot + 1);
  if (!payloadB64 || !sig) return null;

  const expected = hmac(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// buildUnsubscribeUrl(contactId, { identityId?, campaignId? }) → full HTTPS URL,
// or null when there is no contact to reference (e.g. a raw job with no contact_id).
// identityId / campaignId are embedded for future analytics; suppression targets
// the contact only.
export function buildUnsubscribeUrl(contactId, { identityId = null, campaignId = null } = {}) {
  if (contactId == null) return null;
  const payload = { c: contactId, v: 1 };
  if (identityId != null) payload.i  = identityId;
  if (campaignId != null) payload.ca = campaignId;
  return `${baseUrl()}/u/${signToken(payload)}`;
}
