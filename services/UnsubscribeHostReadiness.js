import db from '../db.js';

// ─── UnsubscribeHostReadiness ─────────────────────────────────────────────────
// Per-domain readiness gate for recipient-facing unsubscribe hosts.
//
// Every campaign email advertises List-Unsubscribe / List-Unsubscribe-Post using
// the sending identity's own domain (https://unsubscribe.<domain>/u/<token>). A
// dead unsubscribe endpoint is a critical deliverability failure: recipients who
// want out are funnelled to "Report spam", and mailbox providers probe the RFC
// 8058 one-click endpoint. Therefore the controller WITHHOLDS contact-bound job
// dispatch for a given domain until that domain's unsubscribe host has verified.
//
// This service mirrors TrackingHostReadiness.js exactly: a per-domain Map cache,
// an activeDomains() DB query, and a background watcher that probes each active
// domain on a configurable interval. Jobs for domain A are never affected by the
// readiness state of domain B.
//
// Probe strategy: public HTTPS probe first (validates DNS → TLS → nginx →
// endpoint); on failure, local hairpin fallback (many VPS hosts cannot reach
// their own public IP from inside — a hairpin false-negative must not halt
// sending for that domain). isReady()/allowDispatch() are synchronous + cache-only
// so they are safe on the hot dispatch path.
//
// Dispatch contract:
//   • contact-bound jobs (campaign sends): withheld per-domain until isReady(domain)
//   • raw jobs (no contact_id): never gated — they carry no List-Unsubscribe URL
//   • if UNSUBSCRIBE_REQUIRE_READY=false: gate is disabled for all domains (dev/test)

const cache = new Map(); // domain → { ready, checkedAt, error, via }

const TTL_MS     = Number(process.env.UNSUBSCRIBE_READINESS_TTL_MS)     || 10 * 60 * 1000;
const REFRESH_MS = Number(process.env.UNSUBSCRIBE_READINESS_REFRESH_MS) ||  5 * 60 * 1000;
const TIMEOUT_MS = Number(process.env.UNSUBSCRIBE_READINESS_TIMEOUT_MS) ||  4 * 1000;
const LOCAL_PORT = Number(process.env.PORT) || 3001;

function requireReady() {
  return process.env.UNSUBSCRIBE_REQUIRE_READY !== 'false';
}

// All active sending domains — same query as TrackingHostReadiness.activeDomains().
export function activeDomains() {
  return db
    .prepare(
      "SELECT DISTINCT domain FROM sender_identities WHERE status='active' AND domain IS NOT NULL AND domain != ''"
    )
    .all()
    .map((r) => r.domain);
}

// Synchronous, cache-only readiness check for a specific sending domain.
export function isReady(domain) {
  if (!domain) return false;
  const entry = cache.get(domain);
  return !!entry && entry.ready === true && Date.now() - entry.checkedAt < TTL_MS;
}

// Per-domain dispatch gate.
// false ⇒ withhold contact-bound jobs for this domain; they stay PENDING and
// are retried automatically once the host verifies.
export function allowDispatch(domain) {
  return !requireReady() || isReady(domain);
}

// Returns the set of domains currently ready for campaign dispatch, or null when
// gating is globally disabled (UNSUBSCRIBE_REQUIRE_READY=false). Used by
// PollingService so the SQL query can filter at the DB level rather than per-job.
export function getReadyDomains() {
  if (!requireReady()) return null; // null = no gating, all domains allowed
  return new Set(activeDomains().filter((d) => isReady(d)));
}

async function probe(url, headers, _fetch) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await _fetch(url, { signal: ctrl.signal, redirect: 'manual', headers });
    return res.status === 200;
  } finally {
    clearTimeout(timer);
  }
}

// Probe one domain's unsubscribe host. Async; updates the cache; returns the entry.
// Public probe validates DNS + TLS + nginx + endpoint in one request. Hairpin-NAT
// fallback: if the public probe fails, re-probe via localhost with the correct Host
// header (proves the controller is serving that host despite NAT).
// _fetch is injectable for tests.
export async function verify(domain, _fetch = fetch) {
  const host      = `unsubscribe.${domain}`;
  const publicUrl = `https://${host}/unsubscribe-health`;
  const localUrl  = `http://127.0.0.1:${LOCAL_PORT}/unsubscribe-health`;

  let entry;
  try {
    if (await probe(publicUrl, undefined, _fetch)) {
      entry = { ready: true, checkedAt: Date.now(), error: null, via: 'public' };
    } else {
      entry = { ready: false, checkedAt: Date.now(), error: 'unexpected status', via: 'public' };
    }
  } catch (errPublic) {
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
  return { domain, host, ...entry };
}

// Probe every active sending domain. Returns per-domain results.
export async function verifyAll() {
  return Promise.all(activeDomains().map((domain) => verify(domain)));
}

// Current cached status for every active domain (does not probe).
export function getStatus() {
  return activeDomains().map((domain) => {
    const e = cache.get(domain);
    return {
      domain,
      host: `unsubscribe.${domain}`,
      ready: !!(e && e.ready) && Date.now() - (e?.checkedAt ?? 0) < TTL_MS,
      enforced: requireReady(),
      lastChecked: e?.checkedAt ? new Date(e.checkedAt).toISOString() : null,
      error: e?.error ?? null,
    };
  });
}

// Test/override hook — force readiness without a network probe.
//
// Two signatures:
//   _setReady(ready: boolean)          — sets all currently active domains (global)
//   _setReady(domain: string, ready)   — sets a specific domain only
export function _setReady(domainOrReady, ready = undefined) {
  if (typeof domainOrReady === 'boolean') {
    const r = domainOrReady;
    for (const d of activeDomains()) {
      cache.set(d, { ready: r, checkedAt: Date.now(), error: r ? null : 'forced-not-ready', via: 'forced' });
    }
  } else {
    cache.set(domainOrReady, {
      ready:     !!ready,
      checkedAt: Date.now(),
      error:     ready ? null : 'forced-not-ready',
      via:       'forced',
    });
  }
}

const warnedDomains = new Set(); // domains that have logged an unready warning
let timer = null;

export function startUnsubscribeReadinessWatcher() {
  const tick = () =>
    verifyAll()
      .then((results) => {
        for (const r of results) {
          if (!r.ready && !warnedDomains.has(r.domain)) {
            warnedDomains.add(r.domain);
            console.error(
              `[unsubscribe] host ${r.host} is NOT ready (${r.error}) — ` +
              `campaign dispatch for ${r.domain} is withheld until it verifies. ` +
              `Provision DNS + TLS + nginx per UNSUBSCRIBE.md or run scripts/provision-identity-hosts.sh ${r.domain}`
            );
          } else if (r.ready && warnedDomains.has(r.domain)) {
            warnedDomains.delete(r.domain);
            console.log(
              `[unsubscribe] host ${r.host} is ready (via ${r.via}) — campaign dispatch for ${r.domain} resumed.`
            );
          }
        }
      })
      .catch(() => {});

  tick(); // prime immediately on boot
  if (timer) clearInterval(timer);
  timer = setInterval(tick, REFRESH_MS);
  if (timer.unref) timer.unref();
}
