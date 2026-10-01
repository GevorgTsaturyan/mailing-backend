// ─── ControllerHostHealth ─────────────────────────────────────────────────────
// STRICT public-HTTPS readiness check for a sender identity's controller-side
// infrastructure (the unsubscribe + click/tracking reverse-proxy hosts).
//
// WHY A SEPARATE, STRICT PROBE (vs. TrackingHostReadiness/UnsubscribeHostReadiness
// `verify()`): those services intentionally fall back to a LOCAL hairpin probe of
// the controller backend when the public probe fails, so that pixel/List-Unsubscribe
// gating is not disabled by NAT-hairpin false-negatives. That fallback would MASK a
// genuinely broken public host — e.g. click.calerion.org serving the wrong/default
// TLS certificate (click.serawin.net) — which is exactly the state provisioning must
// detect and heal. So here we do a STRICT public probe only:
//
//   • DNS      — the hostname resolves publicly
//   • TLS      — a valid certificate whose SAN matches the host (Node fetch rejects
//                a mismatched/default cert → the probe fails, as it must)
//   • nginx    — the reverse proxy forwards to the controller
//   • endpoint — the controller answers 200 at the existing health path
//
// We reuse the EXISTING health endpoints and host derivation:
//   https://click.<domain>/tracking-health        (via trackingBaseUrl)
//   https://unsubscribe.<domain>/unsubscribe-health
//
// fetch is injectable so tests never hit the network.

import { trackingBaseUrl } from './trackingToken.js';

const TIMEOUT_MS = Number(process.env.CONTROLLER_HOST_HEALTH_TIMEOUT_MS) || 5000;

async function strictProbe(url, _fetch) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // No redirect follow, no local fallback: a non-200 or any TLS/DNS error = not healthy.
    const res = await _fetch(url, { signal: ctrl.signal, redirect: 'manual' });
    return { ok: res.status === 200, status: res.status, url };
  } catch (err) {
    return { ok: false, status: 0, url, error: err?.code || err?.message || 'probe failed' };
  } finally {
    clearTimeout(timer);
  }
}

// Strict health of BOTH controller hosts for a domain.
// Returns { ok, hosts: { click, unsubscribe } }. ok=true only when BOTH answer 200
// over valid public HTTPS.
export async function checkControllerHostsHealthy({ domain, deps = {} } = {}) {
  const _fetch   = deps.fetch || fetch;
  const clickUrl = `${trackingBaseUrl(domain)}/tracking-health`;
  const unsubUrl = `https://unsubscribe.${domain}/unsubscribe-health`;

  const [click, unsubscribe] = await Promise.all([
    strictProbe(clickUrl, _fetch),
    strictProbe(unsubUrl, _fetch),
  ]);

  return { ok: click.ok && unsubscribe.ok, hosts: { click, unsubscribe } };
}
