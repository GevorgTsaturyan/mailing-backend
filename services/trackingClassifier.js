// ─── Tracking classification (pure, deterministic, re-runnable) ───────────────
//
// Same design philosophy as mail-node/classify.js: NO I/O, NO network, NO DB —
// pure string/number logic over a pre-computed `signals` object. Because it is
// pure and the raw signals are stored on every event, historical events can be
// reclassified by re-running these functions with an improved ruleset.
//
// CONSERVATIVE by design: mislabelling a real human as a bot is the dangerous
// error, so we only assign 'scanner'/'bot' on strong evidence and fall back to
// 'unknown' (never aggressive) when signals merely hint at automation.
//
// Classification is ANALYTICS-ONLY. It NEVER changes the redirect destination and
// NEVER blocks or slows the request (no external calls happen here).
//
// `signals` shape (all booleans/numbers derived by the route, no raw IP):
//   { http_method, ua_scanner, ip_scanner, ip_datacenter, is_prefetch,
//     seconds_since_send, burst }   // seconds_since_send may be null

export const FAST_THRESHOLD_DEFAULT = 10; // seconds; overridable via config

function fastThreshold(opts) {
  const n = Number(opts?.fastThresholdSeconds);
  return Number.isFinite(n) && n >= 0 ? n : FAST_THRESHOLD_DEFAULT;
}

function isFast(signals, threshold) {
  return typeof signals.seconds_since_send === 'number'
    && signals.seconds_since_send >= 0
    && signals.seconds_since_send < threshold;
}

// classifyClick(signals, opts) → { classification, reason }
//   classification ∈ 'human' | 'scanner' | 'unknown'
//   (There is no separate 'bot' bucket: the only signal that produced it —
//   prefetch headers — is just as much a scanner/automation signal, and the
//   report groups them anyway. The evidence lives in `reason` + stored signals.)
//   'human' is BEST-EFFORT: local signals cannot catch every GET-based scanner
//   (e.g. Safe Links fetching >threshold seconds later), so the UI labels it as
//   best-effort rather than certain.
export function classifyClick(signals = {}, opts = {}) {
  const t = fastThreshold(opts);

  if (signals.http_method === 'HEAD')              return c('scanner', 'head-request');
  if (signals.is_prefetch)                         return c('scanner', 'prefetch-header');
  if (signals.ip_scanner)                          return c('scanner', 'scanner-network');
  // Burst = another of this email's buttons was already fetched by the same
  // recipient within a few seconds → a link-scanner detonating every URL, which
  // a human never does. Strong, low-false-positive local signal.
  if (signals.burst)                               return c('scanner', 'burst-multi-button');
  if (isFast(signals, t))                          return c('scanner', 'faster-than-human');
  if (signals.ip_datacenter && signals.ua_scanner) return c('scanner', 'datacenter+scanner-ua');
  if (signals.ip_datacenter)                       return c('unknown', 'datacenter-network');
  if (signals.ua_scanner)                          return c('unknown', 'scanner-ua-unconfirmed');
  return c('human', 'default-human');
}

// classifyOpen(signals, opts) → { classification, reason }
//   classification ∈ 'open' | 'prefetch'
//   Opens CANNOT be reliably attributed to a human: mailbox image proxies fetch
//   and cache images (Gmail proxies every open — including real ones — from
//   Google IPs), Apple Mail Privacy Protection pre-fetches on delivery, and caches
//   suppress repeat opens. So we make NO "human open" claim. We only mark clearly
//   automated fetches as 'prefetch'; every other recorded fetch is a best-effort
//   'open' (a measured open event, not an asserted human open).
//   Deliberately NOT used here: image-proxy UA and datacenter CIDR — both would
//   misclassify genuine Gmail opens (Google proxy IPs) as automated.
export function classifyOpen(signals = {}, opts = {}) {
  const t = fastThreshold(opts);

  if (signals.http_method === 'HEAD') return c('prefetch', 'head-request');
  if (signals.is_prefetch)            return c('prefetch', 'prefetch-header');
  if (signals.ip_scanner)             return c('prefetch', 'scanner-network');
  if (isFast(signals, t))             return c('prefetch', 'faster-than-human');
  return c('open', 'open');
}

function c(classification, reason) {
  return { classification, reason };
}
