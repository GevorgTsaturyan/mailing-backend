import db from '../db.js';
import { trackingBaseUrl } from './trackingToken.js';
import { getGlobalOpenTracking } from './TrackingConfigRepository.js';

// ─── TrackingHostReadiness ────────────────────────────────────────────────────
// Readiness gate for open tracking. Open tracking is ON by default, but a pixel
// is injected for a sending domain ONLY when that domain's click.<domain> tracking
// host is provisioned and healthy — otherwise emails would ship BROKEN pixels.
//
// A single probe to https://<sub>.<domain>/tracking-health validates all four
// production prerequisites at once:
//   • DNS      — the hostname resolves
//   • TLS      — a valid certificate (Node fetch rejects bad/self-signed certs)
//   • nginx    — the reverse proxy forwards to the controller
//   • endpoint — the controller answers 200
//
// State is kept in-memory (ephemeral operational state, like heartbeats — no
// schema). isReady() is synchronous + cache-only so it is safe to call on the hot
// send/compile path; the actual network probe happens in a background watcher and
// in explicit admin-triggered verifications. NEVER call verify() from the
// recipient-facing /c or /o request path.

const cache = new Map(); // domain → { ready, checkedAt, error }

const TTL_MS      = Number(process.env.TRACKING_READINESS_TTL_MS)      || 10 * 60 * 1000;
const REFRESH_MS  = Number(process.env.TRACKING_READINESS_REFRESH_MS)  ||  5 * 60 * 1000;
const TIMEOUT_MS  = Number(process.env.TRACKING_READINESS_TIMEOUT_MS)  ||  4 * 1000;
// Local controller port for the hairpin fallback (see verify()).
const LOCAL_PORT  = Number(process.env.PORT) || 3001;

export function activeDomains() {
  return db.prepare("SELECT DISTINCT domain FROM sender_identities WHERE status='active' AND domain IS NOT NULL AND domain != ''")
    .all().map(r => r.domain);
}

// Synchronous, cache-only readiness check for the compile path.
export function isReady(domain) {
  const entry = cache.get(domain);
  return !!entry && entry.ready === true && (Date.now() - entry.checkedAt) < TTL_MS;
}

async function probe(url, headers, _fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await _fetch(url, { signal: ctrl.signal, redirect: 'manual', headers });
    return res.status === 200;
  } finally {
    clearTimeout(timer);
  }
}

// Probe one domain's tracking host. Async; updates the cache; returns the entry.
//
// Robust against reverse-proxy topology: it first probes the PUBLIC
// https://<host>/tracking-health (validates DNS + TLS + nginx + endpoint). If that
// fails — which on many hosts happens purely due to NAT hairpinning (the box can't
// reach its own public IP), not a real outage — it falls back to a LOCAL probe of
// the controller with the correct Host header. A successful local probe means the
// controller is serving the tracking host, so we treat it as ready rather than
// suppress every pixel over a hairpin false-negative. _fetch is injectable for tests.
export async function verify(domain, _fetch = fetch) {
  const host      = `${trackingBaseUrl(domain).replace(/^https?:\/\//, '')}`; // e.g. click.serawin.net
  const publicUrl = `${trackingBaseUrl(domain)}/tracking-health`;
  const localUrl  = `http://127.0.0.1:${LOCAL_PORT}/tracking-health`;

  let entry;
  try {
    if (await probe(publicUrl, undefined, _fetch)) {
      entry = { ready: true, checkedAt: Date.now(), error: null, via: 'public' };
    } else {
      entry = { ready: false, checkedAt: Date.now(), error: 'unexpected status', via: 'public' };
    }
  } catch (errPublic) {
    // Public probe failed (could be hairpin NAT, DNS, TLS, or a real outage).
    try {
      if (await probe(localUrl, { Host: host }, _fetch)) {
        entry = { ready: true, checkedAt: Date.now(), error: null, via: 'local-fallback' };
      } else {
        entry = { ready: false, checkedAt: Date.now(), error: errPublic.message, via: 'local-fallback' };
      }
    } catch (errLocal) {
      entry = { ready: false, checkedAt: Date.now(), error: errLocal.message, via: 'local-fallback' };
    }
  }
  cache.set(domain, entry);
  return { domain, ...entry };
}

// Probe every active sending domain. Returns the per-domain results.
export async function verifyAll() {
  // Wrap in an arrow so Array.map's (element, index, array) callback args are NOT
  // forwarded to verify() — otherwise the numeric index is passed as `_fetch`,
  // which is not callable and makes every probe throw "_fetch is not a function".
  return Promise.all(activeDomains().map(domain => verify(domain)));
}

// Current cached status for every active domain (does not probe).
export function getStatus() {
  return activeDomains().map(domain => {
    const e = cache.get(domain);
    return {
      domain,
      ready: !!(e && e.ready) && (Date.now() - (e?.checkedAt ?? 0)) < TTL_MS,
      lastChecked: e?.checkedAt ? new Date(e.checkedAt).toISOString() : null,
      error: e?.error ?? null,
    };
  });
}

// Test/override hook: force a domain's readiness without a network probe.
export function _setReady(domain, ready) {
  cache.set(domain, { ready: !!ready, checkedAt: Date.now(), error: ready ? null : 'forced-not-ready' });
}

// Open tracking is only relevant when it's globally on OR some campaign overrides
// it on. When neither holds, the periodic watcher skips probing entirely (no
// pixels will be injected anyway). On-demand verifyAll() (admin "Re-check") always
// probes regardless.
function openTrackingRelevant() {
  if (getGlobalOpenTracking()) return true;
  return !!db.prepare('SELECT 1 FROM campaigns WHERE open_tracking_override = 1 LIMIT 1').get();
}

let timer = null;
export function startReadinessWatcher() {
  const tick = () => { if (openTrackingRelevant()) verifyAll().catch(() => {}); };
  tick(); // prime immediately on boot (only if relevant)
  if (timer) clearInterval(timer);
  timer = setInterval(tick, REFRESH_MS);
  if (timer.unref) timer.unref();
}
