# Campaign Engagement: click tracking + open tracking

Buttons, click redirects, bot/scanner classification, and open tracking. The
**central controller is the sole source of truth**; mail-nodes stay stateless and
know nothing about buttons, tokens, or pixels.

Deliverability is the #1 constraint. This feature adds functionality while
minimizing spam/deliverability risk — it makes **no** claim of improving it.

## Flow

```
Template ({{button:ID}} placeholder)
  → campaign queued (CANONICAL queue only)
  → QUEUE TIME (controller): snapshot button → campaign_buttons (text+URL+style frozen);
    expand placeholder → email-safe table <a> with a per-recipient tracking URL;
    (plain text) → "TEXT: url";  inject 1x1 open pixel (HTML only, if open tracking enabled)
  → node sends the compiled body verbatim (no button/token/pixel knowledge)
  → recipient / scanner:
       GET  https://click.<domain>/c/<token>      → 302 → frozen destination (same for all)
       GET  https://click.<domain>/o/<token>.gif  → 1x1 gif
  → click_events / open_events recorded + classified (analytics only)
```

## Hard invariants (do not weaken)

- **No open redirect.** The destination comes only from the `campaign_buttons`
  snapshot the (signed) token points at — never from the request. `?url=` is ignored.
- **No cloaking.** Human / scanner / bot / unknown all receive the SAME 302 and
  destination. Classification is analytics-only and never changes the redirect.
- **One 302**, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. No 301,
  no chains, no JS/meta redirects.
- **No external calls in the redirect/pixel path** (no DNS/WHOIS/geo/ASN/API).
  Classification uses only request headers, a salted IP hash, static in-repo
  CIDR/UA lists, and one local DB timestamp lookup.
- **Invalid/tampered click token → generic 404**, no event, no redirect. The open
  pixel always returns a 1x1 gif (even on a bad token, to avoid a broken image)
  but records an event only for a valid token.
- **Open tracking is ON by default** (global `tracking_config`, default 1) with an
  optional per-campaign override (`campaigns.open_tracking_override`: NULL=inherit /
  0 / 1). When effectively off, NO pixel is injected and NO open request is
  generated — the compiled body is byte-identical to the no-tracking body.
- **Readiness gate (prevents broken pixels).** A pixel is injected for a sending
  domain ONLY when `effective_intent AND tracking-host-ready(domain)`. Intent ON but
  host not ready ⇒ the email still sends **clean, with no pixel** (never a broken
  one). This is deliverability-first: a down measurement host never blocks a send.
  It is not silent — it is logged once per campaign/domain and the readiness of every
  active domain is shown in the Campaigns UI (`GET/POST /api/engagement/tracking-readiness`).
- **Buttons require the canonical queue.** A tracked-button template that reaches
  the legacy pipeline fails clearly (never a silent untracked link).
- **Missing/inactive button hard-fails** the send with an actionable error
  (never emit a broken CTA).
- **Trusted client IP.** `req.ip` honours Express `trust proxy` (default
  `loopback` — the controller sits behind local nginx; override via `TRUST_PROXY`).
  A client-supplied `X-Forwarded-For` can NOT spoof the IP used for `ip_hash`,
  classification, or dedup. The raw IP is never stored.
- **Rapid-duplicate collapse + burst signal (abuse protection).** Near-instant
  repeats of the same button/pixel from the same client within
  `TRACKING_DEDUP_WINDOW_SECONDS` (default 2s) are collapsed — legitimate repeat
  clicks spaced beyond the window are still recorded (NOT single-use tokens).
  Fetching a *different* button of the same email within
  `TRACKING_BURST_WINDOW_SECONDS` (default 5s) marks the event `scanner`
  (burst-multi-button) — a link-scanner detonates every URL; a human doesn't.
- **Retention.** Raw `click_events`/`open_events` rows (ip_hash + UA) are purged
  after `TRACKING_EVENT_RETENTION_DAYS` (default 90) by a daily scheduler sweep,
  mirroring the delivery_events convention. Aggregate campaign_stats are permanent.

## Token

`base64url(JSON payload) . base64url(HMAC-SHA256(payload, TRACKING_SECRET))`

- Click payload `{ t:'c', ca:campaignId, cb:campaignButtonId, c:contactId, v:1 }`.
- Open payload  `{ t:'o', ca:campaignId, c:contactId, v:1 }`.
- Opaque, **no PII**, **no destination** in the token. Full 256-bit HMAC (never
  truncated). Constant-time verify. Multiple clicks are intentional → multiple
  events (no single-use tokens, no anti-replay).

## Bot / scanner classification (analytics only, conservative)

Pure, deterministic, re-runnable (`services/trackingClassifier.js`). Raw signals
are stored on every event so historical rows can be reclassified.

**Clicks** → `human | scanner | unknown` (the former `bot` bucket collapsed into
`scanner`; the distinction earned nothing and the report grouped them anyway —
evidence is preserved in `classified_reason` + `signals`). Signals in reliability
order: HTTP method (HEAD), prefetch headers, known scanner CIDRs, **burst**
(another button of the same email fetched by the same recipient within seconds),
time-since-send (`< TRACKING_FAST_THRESHOLD_SECONDS`, default 10), datacenter
CIDR + scanner UA. Conservative: a human is never labelled a bot on a weak
signal — ambiguous → `unknown`. **"Human Clicks" is best-effort** (local signals
cannot catch every GET-based scanner, e.g. Safe Links fetching later); the UI
says so explicitly.

**Opens** → `open | prefetch` — deliberately NO "human open" claim. Gmail proxies
**and caches** every image (real human opens arrive from Google IPs; repeat opens
may be undercounted), and Apple MPP pre-fetches on delivery with Safari-like UAs.
Image-proxy UA and datacenter-IP signals are therefore deliberately NOT used for
opens — they would misclassify genuine Gmail opens as automated. Only clearly
automated fetches (HEAD, prefetch headers, scanner CIDR, faster-than-human) are
`prefetch`; everything else is a measured `open`. The report shows Raw Opens /
Unique Openers / Opens (excl. prefetch) with an explicit accuracy caveat.

## Required infrastructure per sending domain (controller host)

Tracking terminates at the **controller**, exactly like `unsubscribe.<domain>`.
Mail-node containers and their installer need **no changes**. For each sending
domain add — this is the reusable controller-host provisioning step.

> **REQUIRED before open tracking emits pixels.** Because open tracking is ON by
> default, every sending domain MUST have its `click.<domain>` host provisioned
> (steps 1–3 below). Until it is, the readiness gate suppresses that domain's pixel
> (emails still send, just untracked). The controller continuously verifies
> readiness by probing `https://click.<domain>/tracking-health` (validates DNS →
> TLS → nginx → endpoint in one request); check status on the Campaigns page or via
> `GET /api/engagement/tracking-readiness`. **Do not skip this step for a new
> domain/node — otherwise opens are silently unmeasured for that domain.**
>
> **Hairpin-NAT robustness:** if the public probe fails (many hosts cannot reach
> their own public IP from inside), the watcher falls back to probing the local
> controller (`http://127.0.0.1:<port>/tracking-health`) with the correct `Host`
> header, so a hairpin false-negative never silently suppresses pixels. The
> readiness probe never runs in the recipient-facing `/c`/`/o` paths, and the
> periodic watcher skips probing entirely while open tracking is globally off and
> no campaign overrides it on (admin "Re-check" always probes).

### 1. DNS

```
click.<domain>.   A   <PUBLIC_IP_OF_CONTROLLER_OR_PROXY>
```
(Use a CNAME to an existing proxy/CDN host if applicable.)

### 2. TLS + Nginx reverse proxy

`certbot --nginx -d click.<domain>`, then proxy all paths to the backend
(port **3001**), preserving `X-Forwarded-For` (used for the salted IP hash and
CIDR classification):

```nginx
server {
    listen 443 ssl;
    server_name click.<domain>;

    ssl_certificate     /etc/letsencrypt/live/click.<domain>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/click.<domain>/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3001;   # controller backend
        proxy_set_header   Host              $host;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

Serves both `/c/<token>` (redirect) and `/o/<token>.gif` (pixel) on the same host.

### 3. Backend env

```
TRACKING_SUBDOMAIN=click
TRACKING_SECRET=<openssl rand -hex 64>     # dedicated; no fallback
TRACKING_IP_SALT=<openssl rand -hex 32>    # dedicated; raw IPs are never stored
TRACKING_FAST_THRESHOLD_SECONDS=10         # bot/prefetch timing threshold
```

Optional tuning (defaults are sensible): `TRACKING_DEDUP_WINDOW_SECONDS` (2),
`TRACKING_BURST_WINDOW_SECONDS` (5), `TRACKING_EVENT_RETENTION_DAYS` (90),
`TRACKING_READINESS_TTL_MS` (600000), `TRACKING_READINESS_REFRESH_MS` (300000),
`TRACKING_READINESS_TIMEOUT_MS` (4000), `TRUST_PROXY` (loopback).

> The internal controller host (e.g. `mailovian.net`) must never appear in a
> recipient-facing tracking URL — those use `click.<sending-domain>` only.

## Multi-node

Adding node N with sending domain N = DNS + nginx + TLS for `click.<domainN>` →
controller. No application code change. One central secret, one central
`click_events` / `open_events` store, one unified report across all nodes.
