// ─── DnsResolutionService ─────────────────────────────────────────────────────
// Verifies that the controller-side identity subdomains (unsubscribe.<domain>
// and click.<domain>) are actually RESOLVABLE in public DNS before certbot is
// allowed to run.
//
// This is the gate that fixes the provisioning race condition: the Cloudflare
// API returns HTTP 200 the instant a record is written into the zone, but that
// record is NOT yet visible to Let's Encrypt's resolvers. Running certbot before
// propagation yields NXDOMAIN and a failed challenge. We wait for real
// resolution first.
//
// RESOLVER CHOICE (Fix B): we query DEDICATED PUBLIC resolvers (1.1.1.1 / 8.8.8.8)
// via dns.Resolver.setServers(), NOT dns.resolve4() against the host's local stub
// resolver. The local stub (e.g. systemd-resolved) negative-caches NXDOMAIN for up
// to the zone's SOA minimum (Cloudflare = 1800s). If the gate queried a name right
// after the Cloudflare record was created (before propagation), that stale NXDOMAIN
// would keep the gate PENDING for up to ~30 min even though public DNS is already
// correct. Speaking directly to 1.1.1.1/8.8.8.8 avoids the local negative cache.
// (This mirrors the mail-node DnsValidator, which already uses explicit servers.)
//
// The resolver is injectable (__setResolver) so tests never hit the network.

import { Resolver } from 'node:dns/promises';

// Comma-separated upstreams; falls back to well-known public resolvers.
function parseServerList(envVal) {
  const list = (envVal || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.length > 0 ? list : ['1.1.1.1', '8.8.8.8'];
}

function makePublicResolver() {
  const r = new Resolver();
  try { r.setServers(parseServerList(process.env.DNS_SERVERS)); } catch { /* keep defaults */ }
  return (host) => r.resolve4(host);
}

let _resolve4 = makePublicResolver();

// Test-only: override / restore the underlying A-record resolver.
export function __setResolver(fn) { _resolve4 = fn; }
export function __resetResolver() { _resolve4 = makePublicResolver(); }

// Resolve a single host's A records. Never throws — a lookup failure
// (NXDOMAIN / ENODATA / timeout) is reported as { resolves:false }.
async function resolveHost(host, expectedIp) {
  try {
    const addresses = await _resolve4(host);
    const list      = Array.isArray(addresses) ? addresses : [];
    const resolves  = list.length > 0;
    // When we know the controller IP, require an exact match; otherwise any
    // A record counts as resolvable (manual-DNS fallback).
    const matches   = expectedIp ? list.includes(expectedIp) : resolves;
    return { host, resolves, matches, addresses: list };
  } catch (err) {
    return { host, resolves: false, matches: false, addresses: [], error: err.code || err.message };
  }
}

// Check both controller subdomains for a domain.
// Returns { ok, hosts: { unsubscribe, click } } where ok=true only when BOTH
// resolve (to expectedIp if provided).
export async function checkControllerHostsResolve({ domain, expectedIp = null }) {
  const [unsubscribe, click] = await Promise.all([
    resolveHost(`unsubscribe.${domain}`, expectedIp),
    resolveHost(`click.${domain}`, expectedIp),
  ]);
  return { ok: unsubscribe.matches && click.matches, hosts: { unsubscribe, click } };
}
