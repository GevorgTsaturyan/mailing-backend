// ─── Public tracking endpoints (click redirect + open pixel) ──────────────────
//
// Recipient-facing, served under click.<sending-domain> (reverse-proxied to this
// controller — see TRACKING.md). Mounted BEFORE the JWT middleware; no auth.
//
// Hard invariants (deliverability + security — do not weaken):
//   • The destination comes ONLY from the campaign_buttons snapshot, never from
//     the request → not an open redirect.
//   • Every classification (human/scanner/bot/unknown) gets the SAME real
//     destination. No cloaking. Classification is analytics-only.
//   • Exactly one 302, Cache-Control: no-store, Referrer-Policy: no-referrer.
//   • No external network calls in the request path. Only local header/DB/CIDR use.
//   • Invalid/tampered click token → generic 404, no event, no redirect.
//   • The open pixel ALWAYS returns a 1x1 gif (even on bad token, to avoid a
//     broken-image icon) but records an event only for a valid token.

import express from 'express';
import db from '../db.js';
import { verifyToken, hashIp } from '../services/trackingToken.js';
import { classifyClick, classifyOpen } from '../services/trackingClassifier.js';
import {
  SCANNER_UA_PATTERNS, SCANNER_CIDRS, DATACENTER_CIDRS,
  matchesUa, ipInAnyCidr,
} from '../services/trackingScanners.js';

const router = express.Router();

// 43-byte transparent 1x1 GIF89a.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function fastThresholdSeconds() {
  const n = Number(process.env.TRACKING_FAST_THRESHOLD_SECONDS);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}
// Rapid-duplicate collapse window (double-clicks / refreshes / tight scripted loops).
// Legitimate repeat clicks spaced beyond this window are still recorded (NOT single-use).
function dedupWindowMs() {
  const n = Number(process.env.TRACKING_DEDUP_WINDOW_SECONDS);
  return (Number.isFinite(n) && n >= 0 ? n : 2) * 1000;
}
// Burst window: a link-scanner detonating multiple buttons of the same email.
function burstWindowMs() {
  const n = Number(process.env.TRACKING_BURST_WINDOW_SECONDS);
  return (Number.isFinite(n) && n >= 0 ? n : 5) * 1000;
}

// Client IP is taken from Express's trusted req.ip, which honours the
// `trust proxy` setting configured in index.js (loopback nginx by default). A
// client-supplied X-Forwarded-For is therefore NOT blindly trusted — only the hop
// our own reverse proxy appended is used. The raw IP is never stored (only a
// salted hash for dedup/classification).
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || null;
}

function isPrefetch(req) {
  const h = req.headers;
  return (
    h['purpose'] === 'prefetch' ||
    h['x-purpose'] === 'preview' ||
    h['x-moz'] === 'prefetch' ||
    (typeof h['sec-purpose'] === 'string' && h['sec-purpose'].includes('prefetch'))
  );
}

// Seconds between this recipient's send and now, via a LOCAL jobs lookup (no
// external call). Uses the job's finished_at (send completion) or created_at.
function secondsSinceSend(campaignId, contactId) {
  if (campaignId == null || contactId == null) return null;
  const row = db.prepare(
    'SELECT finished_at, created_at FROM jobs WHERE campaign_id = ? AND contact_id = ? ORDER BY id DESC LIMIT 1'
  ).get(campaignId, contactId);
  const sentAt = row?.finished_at || row?.created_at;
  if (!sentAt) return null;
  const secs = Math.round((Date.now() - Date.parse(sentAt)) / 1000);
  return Number.isFinite(secs) ? secs : null;
}

// Build the pre-computed signals object (no raw IP retained downstream).
function buildSignals(req, seconds) {
  const ua = req.headers['user-agent'] || '';
  const ip = clientIp(req);
  return {
    http_method:        req.method,
    ua,
    ua_scanner:         matchesUa(ua, SCANNER_UA_PATTERNS),
    ip_scanner:         ip ? ipInAnyCidr(ip, SCANNER_CIDRS) : false,
    ip_datacenter:      ip ? ipInAnyCidr(ip, DATACENTER_CIDRS) : false,
    is_prefetch:        isPrefetch(req),
    seconds_since_send: seconds,
    _ip_hash:           safeHashIp(ip),
  };
}

function safeHashIp(ip) {
  try { return hashIp(ip); } catch { return null; }
}

// Burst signal: has the SAME recipient already fetched a DIFFERENT button of this
// campaign within the burst window? A human clicks one CTA; a link-scanner fetches
// them all near-instantly. Local DB read only.
function isClickBurst(campaignId, contactId, currentButtonId) {
  if (campaignId == null || contactId == null) return false;
  const since = new Date(Date.now() - burstWindowMs()).toISOString();
  const row = db.prepare(`
    SELECT COUNT(DISTINCT campaign_button_id) AS n
    FROM click_events
    WHERE campaign_id = ? AND contact_id = ? AND clicked_at > ? AND campaign_button_id != ?
  `).get(campaignId, contactId, since, currentButtonId);
  return (row?.n || 0) >= 1;
}

// Rapid-duplicate guard (abuse/refresh/double-click). Collapses only near-instant
// repeats of the SAME button from the SAME client; deliberately does NOT suppress
// legitimate repeat clicks spaced beyond the window. Local DB read only.
function isDuplicateClick(campaignButtonId, ipHash, contactId) {
  const since = new Date(Date.now() - dedupWindowMs()).toISOString();
  const row = ipHash
    ? db.prepare("SELECT 1 FROM click_events WHERE campaign_button_id=? AND ip_hash=? AND clicked_at > ? LIMIT 1").get(campaignButtonId, ipHash, since)
    : db.prepare("SELECT 1 FROM click_events WHERE campaign_button_id=? AND contact_id IS ? AND clicked_at > ? LIMIT 1").get(campaignButtonId, contactId ?? null, since);
  return !!row;
}

function isDuplicateOpen(campaignId, contactId, ipHash) {
  const since = new Date(Date.now() - dedupWindowMs()).toISOString();
  const row = ipHash
    ? db.prepare("SELECT 1 FROM open_events WHERE campaign_id=? AND ip_hash=? AND opened_at > ? LIMIT 1").get(campaignId, ipHash, since)
    : db.prepare("SELECT 1 FROM open_events WHERE campaign_id=? AND contact_id IS ? AND opened_at > ? LIMIT 1").get(campaignId, contactId ?? null, since);
  return !!row;
}

// ── GET /tracking-health — readiness probe target ─────────────────────────────
// Hit by the controller's own TrackingHostReadiness watcher via the public
// https://click.<domain>/tracking-health URL to confirm the DNS/TLS/nginx/endpoint
// chain is live before open-tracking pixels are injected for that domain.
router.get('/tracking-health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true });
});

// ── GET /c/:token — click redirect ────────────────────────────────────────────
router.get('/c/:token', (req, res) => {
  const payload = verifyToken(req.params.token);
  if (!payload || payload.t !== 'c' || payload.cb == null) {
    return res.status(404).send('Not found');
  }

  const snapshot = db.prepare('SELECT * FROM campaign_buttons WHERE id = ?').get(payload.cb);
  // The snapshot is the sole source of the destination. Also cross-check the
  // campaign id in the (signed) token matches the snapshot — defense in depth.
  if (!snapshot || (payload.ca != null && snapshot.campaign_id !== payload.ca)) {
    return res.status(404).send('Not found');
  }

  try {
    const contactId = payload.c ?? null;
    const seconds   = secondsSinceSend(snapshot.campaign_id, contactId);
    const signals   = buildSignals(req, seconds);
    signals.burst   = isClickBurst(snapshot.campaign_id, contactId, snapshot.id);
    const { classification, reason } = classifyClick(signals, { fastThresholdSeconds: fastThresholdSeconds() });
    // Collapse rapid duplicates; legitimate spaced repeats are still recorded.
    if (!isDuplicateClick(snapshot.id, signals._ip_hash, contactId)) {
      recordClick(snapshot, contactId, signals, classification, reason);
    }
  } catch (err) {
    // Analytics must never break the redirect. Log and continue.
    console.error('[track] click event recording failed:', err.message);
  }

  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  return res.redirect(302, snapshot.destination_url);
});

// ── GET /o/:file — open pixel (file is "<token>.gif") ──────────────────────────
router.get('/o/:file', (req, res) => {
  const token = String(req.params.file).replace(/\.gif$/i, '');
  const payload = verifyToken(token);

  if (payload && payload.t === 'o' && payload.ca != null) {
    try {
      const contactId = payload.c ?? null;
      const seconds   = secondsSinceSend(payload.ca, contactId);
      const signals   = buildSignals(req, seconds);
      const { classification, reason } = classifyOpen(signals, { fastThresholdSeconds: fastThresholdSeconds() });
      if (!isDuplicateOpen(payload.ca, contactId, signals._ip_hash)) {
        recordOpen(payload.ca, contactId, signals, classification, reason);
      }
    } catch (err) {
      console.error('[track] open event recording failed:', err.message);
    }
  }

  // Always return the pixel — even on an invalid token — to avoid a broken image.
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Length', String(PIXEL.length));
  return res.status(200).end(PIXEL);
});

// ── Persistence (raw event + classification; no raw IP stored) ─────────────────

function storableSignals(signals) {
  const { _ip_hash, ...rest } = signals;
  return JSON.stringify(rest);
}

function recordClick(snapshot, contactId, signals, classification, reason) {
  db.prepare(`
    INSERT INTO click_events
      (campaign_button_id, campaign_id, contact_id, clicked_at, http_method,
       user_agent, ip_hash, is_prefetch, seconds_since_send, signals,
       classification, classified_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshot.id, snapshot.campaign_id, contactId, new Date().toISOString(),
    signals.http_method, truncate(signals.ua), signals._ip_hash,
    signals.is_prefetch ? 1 : 0, signals.seconds_since_send,
    storableSignals(signals), classification, reason,
  );
}

function recordOpen(campaignId, contactId, signals, classification, reason) {
  db.prepare(`
    INSERT INTO open_events
      (campaign_id, contact_id, opened_at, http_method, user_agent, ip_hash,
       is_prefetch, seconds_since_send, signals, classification, classified_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    campaignId, contactId, new Date().toISOString(), signals.http_method,
    truncate(signals.ua), signals._ip_hash, signals.is_prefetch ? 1 : 0,
    signals.seconds_since_send, storableSignals(signals), classification, reason,
  );
}

function truncate(s, n = 300) {
  return s ? String(s).slice(0, n) : null;
}

export default router;
