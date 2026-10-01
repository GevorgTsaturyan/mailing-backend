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
// The resolver is injectable (__setResolver) so tests never hit the network.

import { promises as dnsPromises } from 'node:dns';

let _resolve4 = (host) => dnsPromises.resolve4(host);

// Test-only: override / restore the underlying A-record resolver.
export function __setResolver(fn) { _resolve4 = fn; }
export function __resetResolver() { _resolve4 = (host) => dnsPromises.resolve4(host); }

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
