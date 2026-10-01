# Unsubscribe architecture (RFC 8058 one-click + visible body link)

One source of truth: **`contacts.status = 'unsubscribed'`**. No second suppression store.

## Flow

```
Email recipient
      │  clicks visible link  |  Gmail/Yahoo one-click button
      ▼
https://unsubscribe.serawin.net/u/<signed-token>      (aligned with sending domain)
      ▼  (reverse proxy)
Campaign Manager backend  (routes/unsubscribe.js)
      ▼
verify HMAC token → resolve contact by id → UPDATE contacts.status='unsubscribed'
      ▼
recipient excluded from all future campaigns
```

- **GET /u/:token** → confirmation page only. **Never mutates** (safe against link
  scanners / prefetchers).
- **POST /u/:token** → performs the unsubscribe. Handles both the confirmation-form
  submit and the RFC 8058 one-click POST (`Content-Type: application/x-www-form-urlencoded`,
  body `List-Unsubscribe=One-Click`). Idempotent; already-unsubscribed still returns 200.
- **GET /unsubscribe-health** → `{ok:true}` probe target for the readiness gate below.

## Readiness gate (fail-closed — campaign dispatch requires a working unsubscribe host)

Every campaign email advertises this host in `List-Unsubscribe`/`List-Unsubscribe-Post`
and the visible footer link. A dead unsubscribe endpoint is a critical deliverability
failure (recipients' only working exit becomes "Report spam"; Gmail/Yahoo probe the
one-click endpoint). Therefore the controller **withholds contact-bound job dispatch
until it has verified the host end-to-end** (`services/UnsubscribeHostReadiness.js`):

- Background watcher probes `https://<host>/unsubscribe-health` (validates DNS → TLS →
  nginx → endpoint in one request), with a local hairpin fallback (`127.0.0.1:<port>`
  with the correct `Host` header) so a NAT-hairpin false-negative never halts sending.
- Enforced at all three dispatch points, mirroring the DKIM signer-health gate:
  `PollingService.poll` (canonical), `JobService.startJob` (409, claim-time), and
  legacy `GET /api/nodes/jobs` (empty batch).
- Withheld jobs stay `PENDING`/`queued` — nothing is failed or lost; dispatch resumes
  automatically within one refresh interval (default 5 min) of the host going live.
- **Raw jobs** (no contact) carry no unsubscribe URL by design and are NOT gated —
  useful for test sends while wiring up the host.
- Escape hatch for local dev/tests only: `UNSUBSCRIBE_REQUIRE_READY=false`.
  **Never set this in production.**

## Token

`base64url(JSON payload) . base64url(HMAC-SHA256(payload, secret))`

- Payload carries the **contact's integer id** (`c`), not the email → **no PII in the URL**.
- Tamper-resistant: changing `c` invalidates the signature (constant-time compare).
- Stateless: no DB write at send time. Secret = `UNSUBSCRIBE_SECRET` (falls back to `JWT_SECRET`).
- The **controller is the sole token authority**. It embeds `unsubscribeUrl` in each job it
  hands to a mail-node (`GET /api/nodes/jobs`, `GET /api/jobs/poll`). Mail-nodes never hold
  the signing secret. The same URL is used for the `List-Unsubscribe` header **and** the
  visible body link.

## Email headers emitted by the mail-node

Headers use the sending identity's domain automatically — no per-domain code required:

```
# serawin.net identity:
List-Unsubscribe: <https://unsubscribe.serawin.net/u/<token>>
List-Unsubscribe-Post: List-Unsubscribe=One-Click

# calerion.org identity:
List-Unsubscribe: <https://unsubscribe.calerion.org/u/<token>>
List-Unsubscribe-Post: List-Unsubscribe=One-Click

# any future identity (e.g. example.com) — automatic, no code changes:
List-Unsubscribe: <https://unsubscribe.example.com/u/<token>>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

No `mailto:` form (the mail-node is send-only, so it would be unroutable). No `X-Mailer`.

## Required manual infrastructure (NOT auto-provisioned)

The unsubscribe host (`unsubscribe.<domain>`) is generated dynamically per sending identity.
**Adding a new sender identity (e.g. `support@example.com`) automatically generates
`https://unsubscribe.example.com/u/...` — no backend code changes are needed.**
However, DNS and TLS infrastructure must be provisioned for every new sending domain
before the identity is activated. Repeat the steps below for each new `<domain>`:

`unsubscribe.<domain>` must be set up on the host that serves the recipient-facing URL
(the controller / sending-domain infra):

### 1. DNS (per sending domain)

Add an **A record** for `unsubscribe.<domain>` pointing at the public IP of the server
that terminates the unsubscribe HTTPS traffic (the controller or its reverse proxy):

```
# Example for serawin.net:
unsubscribe.serawin.net.   A   <PUBLIC_IP_OF_CONTROLLER_OR_PROXY>

# Example for calerion.org:
unsubscribe.calerion.org.  A   <PUBLIC_IP_OF_CONTROLLER_OR_PROXY>

# Example for a future identity (example.com):
unsubscribe.example.com.   A   <PUBLIC_IP_OF_CONTROLLER_OR_PROXY>
```

(All domains point to the same controller IP — the backend handles all tokens regardless
of which `unsubscribe.<domain>` host the request arrives on.)

### 2. TLS + Nginx reverse proxy (per sending domain)

Obtain a certificate and add a server block for each domain. The nginx config is identical
across domains — only `server_name` and the cert paths change:

```nginx
# Repeat this block for every unsubscribe.<domain>
server {
    listen 443 ssl;
    server_name unsubscribe.<domain>;   # e.g. unsubscribe.serawin.net

    ssl_certificate     /etc/letsencrypt/live/unsubscribe.<domain>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/unsubscribe.<domain>/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3001;   # controller backend (shared)
        proxy_set_header   Host              $host;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

Obtain certs: `certbot --nginx -d unsubscribe.<domain>` (once per domain).

### 3. Backend env

The backend env does **not** need to change per identity. `UNSUBSCRIBE_BASE_URL` is only
used as a fallback when the identity domain is unavailable (backward compat). The URL is
constructed dynamically from the identity's `domain` field at dispatch time.

```
UNSUBSCRIBE_BASE_URL=https://unsubscribe.serawin.net  # fallback/primary host only
UNSUBSCRIBE_SECRET=<openssl rand -hex 64>             # optional; falls back to JWT_SECRET
```

> The token signing secret is **shared** across all domains. A token generated for
> `unsubscribe.calerion.org` verifies identically on `unsubscribe.example.com` — the domain
> is only the URL prefix, not part of the HMAC payload. The single secret in `UNSUBSCRIBE_SECRET`
> covers every identity domain you add.

> `mailovian.net` remains internal (controller/backend). It must **not** appear in any
> recipient-facing unsubscribe URL.

## Legacy links

Emails sent before this change used `/unsubscribe?email=<addr>`. That route still exists for
backward compatibility but is now **non-mutating on GET** (renders a confirmation page; the
POST performs the change), so scanners can no longer auto-unsubscribe users. New emails never
use it.
