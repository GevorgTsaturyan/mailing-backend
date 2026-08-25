// ─── Tracking token (HMAC-signed, opaque, no PII) ─────────────────────────────
//
// Single source of truth for building and verifying recipient-facing tracking
// URLs for BOTH click redirects and open-tracking pixels. Mirrors the proven
// unsubscribeToken.js design (see services/unsubscribeToken.js).
//
// Design goals (deliverability + privacy):
//   • The URL must NOT expose the recipient's email or any PII. Tokens carry only
//     opaque internal integer ids (campaign / contact / campaign-button PKs).
//   • The destination URL is NEVER in the token — the redirect resolves it from
//     the campaign_buttons snapshot server-side (open-redirect proof).
//   • Tamper-resistant: HMAC-SHA256 (full 256-bit, never truncated) over the
//     payload with a dedicated TRACKING_SECRET. Changing any id breaks the sig.
//   • Self-contained: no DB write at send time; verifies statelessly.
//
// Token format:  base64url(payloadJSON) + "." + base64url(HMAC_SHA256(payloadB64))
//
// Payload shapes (keys kept short to keep the URL short):
//   click:  { t:'c', ca:campaignId, c:contactId, cb:campaignButtonId, v:1 }
//   open:   { t:'o', ca:campaignId, c:contactId, v:1 }

import crypto from 'crypto';

// Recipient-facing tracking host is a dedicated subdomain of the SENDING domain
// (e.g. click.serawin.net) so it aligns with the authenticated From domain and is
// never a third-party tracker. The subdomain label is configurable; the domain is
// supplied per-send from the sending identity. The controller serves both
//   https://<sub>.<domain>/c/<token>       (click redirect)
//   https://<sub>.<domain>/o/<token>.gif   (open pixel)
// via a reverse proxy — see TRACKING.md for the DNS/nginx/TLS wiring.
function trackingSubdomain() {
  return (process.env.TRACKING_SUBDOMAIN || 'click').replace(/^\.+|\.+$/g, '');
}

export function trackingBaseUrl(domain) {
  if (!domain) throw new Error('trackingBaseUrl requires a sending domain');
  return `https://${trackingSubdomain()}.${domain}`;
}

// Dedicated server-side secret for tracking tokens. No fallback: tracking tokens
// are only ever built/verified when this feature is used, so we fail loudly rather
// than silently signing with a weaker/shared key.
function secret() {
  const s = process.env.TRACKING_SECRET;
  if (!s) throw new Error('TRACKING_SECRET must be set to sign/verify tracking tokens');
  return s;
}

function hmac(payloadB64) {
  return crypto.createHmac('sha256', secret()).update(payloadB64).digest('base64url');
}

// signToken(payload) → "payload.signature"
export function signToken(payload) {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadB64}.${hmac(payloadB64)}`;
}

// verifyToken(token) → payload object, or null if malformed / bad signature.
// Constant-time signature comparison (no timing leak).
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

// buildClickUrl(domain, { campaignId, contactId, campaignButtonId }) → full HTTPS URL
export function buildClickUrl(domain, { campaignId, contactId, campaignButtonId }) {
  if (campaignId == null || campaignButtonId == null) {
    throw new Error('buildClickUrl requires campaignId and campaignButtonId');
  }
  const payload = { t: 'c', ca: campaignId, cb: campaignButtonId, v: 1 };
  if (contactId != null) payload.c = contactId;
  return `${trackingBaseUrl(domain)}/c/${signToken(payload)}`;
}

// buildOpenPixelUrl(domain, { campaignId, contactId }) → full HTTPS URL ending .gif
export function buildOpenPixelUrl(domain, { campaignId, contactId }) {
  if (campaignId == null) throw new Error('buildOpenPixelUrl requires campaignId');
  const payload = { t: 'o', ca: campaignId, v: 1 };
  if (contactId != null) payload.c = contactId;
  return `${trackingBaseUrl(domain)}/o/${signToken(payload)}.gif`;
}

// Salted, one-way hash of a client IP for dedup / unique-clicker counting WITHOUT
// storing the raw IP. Uses a dedicated TRACKING_IP_SALT. Returns null if no IP.
export function hashIp(ip) {
  if (!ip) return null;
  const salt = process.env.TRACKING_IP_SALT;
  if (!salt) throw new Error('TRACKING_IP_SALT must be set to hash client IPs');
  return crypto.createHmac('sha256', salt).update(String(ip)).digest('base64url').slice(0, 22);
}
