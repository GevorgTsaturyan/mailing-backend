// ─── Known scanner / datacenter signals (LOCAL data only) ─────────────────────
//
// This module is a small, MANUALLY MAINTAINED starter list used purely to derive
// boolean signals for click/open classification. It performs NO network calls —
// everything here is static matching against the incoming request.
//
// It is intentionally conservative and incomplete. Classification treats these as
// supporting evidence; a real human is never labelled a bot on a UA match alone
// (see trackingClassifier.js). Extend these lists over time; because the raw
// `signals` are stored on every event, historical events can be reclassified.

// User-Agent substrings that identify automated mailbox/link security scanners.
// Matching is case-insensitive substring.
export const SCANNER_UA_PATTERNS = [
  'proofpoint',
  'barracuda',
  'mimecast',
  'microsoft-crawler',
  'bingpreview',
  'symantec',
  'forcepoint',
  'cisco',
  'gmailimageproxy',   // also caught as a proxy below; harmless overlap
  'safelinks',
  'urldefense',
];

// NOTE (open tracking): we deliberately do NOT keep an "image proxy" UA list for
// open classification. Gmail proxies AND CACHES every image — including on a real
// human open — from Google IPs, so a `GoogleImageProxy`/datacenter signal would
// misclassify genuine Gmail opens as automated. Apple Mail Privacy Protection also
// presents Safari-like UAs, so a `apple mail` match would mislabel real macOS Mail
// opens. Open classification therefore relies only on method/prefetch-headers/
// scanner-CIDR/timing (see trackingClassifier.classifyOpen).

// IPv4 CIDR ranges known to belong to email security scanners. Starter set only.
export const SCANNER_CIDRS = [
  // Proofpoint URL Defense (example public ranges — extend as needed)
  '148.163.128.0/17',
  '67.231.144.0/20',
];

// IPv4 CIDR ranges belonging to major cloud/datacenter networks. A hit here is a
// weak signal (could be a VPN human) → contributes to 'unknown', never 'bot' alone.
export const DATACENTER_CIDRS = [
  // Intentionally small starter set; extend from published cloud ranges.
  '13.64.0.0/11',   // Microsoft Azure (partial)
  '40.64.0.0/10',   // Microsoft Azure (partial)
];

// ── Pure matchers (no I/O) ────────────────────────────────────────────────────

export function matchesUa(ua, patterns) {
  if (!ua) return false;
  const low = String(ua).toLowerCase();
  return patterns.some(p => low.includes(p));
}

// Parse an IPv4 dotted string to a uint32, or null if not a plain IPv4 address.
// (X-Forwarded-For may carry IPv6 or lists; the caller passes a single address.)
function ipv4ToInt(ip) {
  if (typeof ip !== 'string') return null;
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = (n * 256) + octet;
  }
  return n >>> 0;
}

export function ipInCidr(ip, cidr) {
  const ipInt = ipv4ToInt(ip);
  if (ipInt == null) return false;
  const [base, bitsStr] = cidr.split('/');
  const baseInt = ipv4ToInt(base);
  if (baseInt == null) return false;
  const bits = Number(bitsStr);
  if (!(bits >= 0 && bits <= 32)) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((ipInt & mask) >>> 0) === ((baseInt & mask) >>> 0);
}

export function ipInAnyCidr(ip, cidrs) {
  return cidrs.some(c => ipInCidr(ip, c));
}
