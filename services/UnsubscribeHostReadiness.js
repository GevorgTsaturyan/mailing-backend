import { unsubscribeBaseUrl } from './unsubscribeToken.js';

// ─── UnsubscribeHostReadiness ─────────────────────────────────────────────────
// Readiness gate for the recipient-facing unsubscribe host (UNSUBSCRIBE_BASE_URL,
// e.g. https://unsubscribe.serawin.net). Every campaign email advertises this host
// in the List-Unsubscribe / List-Unsubscribe-Post headers AND the visible body
// link. Advertising a dead unsubscribe endpoint is a critical deliverability
// failure: recipients who want out are funnelled to "Report spam" (Gmail's spam
// rate metric), and mailbox providers probe the RFC 8058 one-click endpoint.
//
// So the asymmetry with TrackingHostReadiness is DELIBERATE and inverted:
//   • a down MEASUREMENT host (open tracking) must never block a send
//   • a down UNSUBSCRIBE host MUST block campaign dispatch — the jobs stay
//     PENDING and dispatch resumes automatically once the host verifies.
// This mirrors the existing signer-health gate (withhold dispatch on an unhealthy
// prerequisite; nothing is lost, nothing is failed).
//
// Scope: only CONTACT-BOUND jobs are gated (they carry the unsubscribe URL).
// Raw jobs with no contact never advertise List-Unsubscribe (mailer.js sends them
// clean), so they remain dispatchable — this also lets an operator send raw test
// emails while wiring up the host.
//
// A single probe of <base>/unsubscribe-health validates DNS → TLS → nginx →
// endpoint in one request, with the same local hairpin fallback as
// TrackingHostReadiness (many hosts cannot reach their own public IP from inside;
// a hairpin false-negative must not halt sending). isReady()/allowDispatch() are
// synchronous + cache-only — safe on the dispatch path; the network probe runs in
// the background watcher only.

const TTL_MS     = Number(process.env.UNSUBSCRIBE_READINESS_TTL_MS)     || 10 * 60 * 1000;
const REFRESH_MS = Number(process.env.UNSUBSCRIBE_READINESS_REFRESH_MS) ||  5 * 60 * 1000;
const TIMEOUT_MS = Number(process.env.UNSUBSCRIBE_READINESS_TIMEOUT_MS) ||  4 * 1000;
// Local controller port for the hairpin fallback (see verify()).
const LOCAL_PORT = Number(process.env.PORT) || 3001;

let entry = null; // { ready, checkedAt, error, via } — single global unsubscribe host

// Enforcement is ON unless explicitly disabled (UNSUBSCRIBE_REQUIRE_READY=false).
// Fail-closed by design: until the first successful probe, campaign dispatch is
// withheld. Read at call time so tests/dev can toggle it.
function requireReady() {
  return process.env.UNSUBSCRIBE_REQUIRE_READY !== 'false';
}

// Synchronous, cache-only readiness of the unsubscribe host.
export function isReady() {
  return !!entry && entry.ready === true && (Date.now() - entry.checkedAt) < TTL_MS;
}

// The dispatch-path predicate: may a contact-bound (campaign) job be handed to a
// node right now? False ⇒ withhold; the job stays PENDING and is retried on the
// next poll — never failed, never sent without a working unsubscribe endpoint.
export function allowDispatch() {
  return !requireReady() || isReady();
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

// Probe the unsubscribe host. Async; updates the cache; returns the entry.
// Public probe first (validates DNS + TLS + nginx + endpoint); on failure, falls
// back to a local probe with the correct Host header (hairpin robustness — a
// successful local probe proves the controller serves the host). _fetch is
// injectable for tests.
export async function verify(_fetch = fetch) {
  const base      = unsubscribeBaseUrl();
  const host      = base.replace(/^https?:\/\//, '');
  const publicUrl = `${base}/unsubscribe-health`;
  const localUrl  = `http://127.0.0.1:${LOCAL_PORT}/unsubscribe-health`;

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
  return { host, ...entry };
}

// Current cached status (does not probe).
export function getStatus() {
  return {
    host: unsubscribeBaseUrl().replace(/^https?:\/\//, ''),
    ready: isReady(),
    enforced: requireReady(),
    lastChecked: entry?.checkedAt ? new Date(entry.checkedAt).toISOString() : null,
    error: entry?.error ?? null,
    via: entry?.via ?? null,
  };
}

// Test/override hook: force readiness without a network probe.
export function _setReady(ready) {
  entry = { ready: !!ready, checkedAt: Date.now(), error: ready ? null : 'forced-not-ready', via: 'forced' };
}

let warned = false;
let timer = null;
export function startUnsubscribeReadinessWatcher() {
  const tick = () => verify()
    .then((r) => {
      if (!r.ready && !warned) {
        warned = true;
        console.error(`[unsubscribe] host ${r.host} is NOT ready (${r.error}) — campaign dispatch is withheld until it verifies. Provision DNS + TLS + nginx per UNSUBSCRIBE.md.`);
      } else if (r.ready && warned) {
        warned = false;
        console.log(`[unsubscribe] host ${r.host} is ready (via ${r.via}) — campaign dispatch resumed.`);
      }
    })
    .catch(() => {});
  tick(); // prime immediately on boot
  if (timer) clearInterval(timer);
  timer = setInterval(tick, REFRESH_MS);
  if (timer.unref) timer.unref();
}
