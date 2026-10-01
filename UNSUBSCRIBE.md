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

## Required infrastructure per sending domain

The unsubscribe host (`unsubscribe.<domain>`) is generated dynamically per sending identity.
**Adding a new sender identity (e.g. `support@newdomain.org`) automatically generates
`https://unsubscribe.newdomain.org/u/...` — no backend code changes are needed.**
However, DNS and nginx/TLS infrastructure must be provisioned on the controller VPS for
every new sending domain before the identity is used for campaign sends.

### Automated provisioning (recommended)

A single idempotent script provisions both `unsubscribe.<domain>` AND `click.<domain>`
at once (they always go together):

```bash
# On the controller VPS, as root:
sudo CERTBOT_EMAIL=you@example.com bash scripts/provision-identity-hosts.sh newdomain.org
```

The script:
1. Detects the server's public IP and resolves the subdomains — prints required DNS records
   if they are missing.
2. Writes an nginx HTTP server block for each subdomain (skips if already exists).
3. Runs `certbot --nginx -d <subdomain>` to obtain TLS certs and add the HTTPS block
   (skips if the cert directory already exists).
4. Runs `nginx -t` before every reload.
5. Probes `https://unsubscribe.<domain>/unsubscribe-health` and
   `https://click.<domain>/tracking-health` and reports their status.

**Safe to re-run**: all steps are guarded with existence checks. Re-running on an already-
provisioned domain is a no-op (nginx config already exists, cert dir already exists).

### 1. DNS (required before certbot will work — not automated)

DNS is managed externally (Cloudflare or registrar). Add **A records** before running
the provisioning script, or run the script first and re-run it after DNS propagates:

```
# In your DNS provider (Cloudflare, etc.) for each new identity domain:
unsubscribe.<domain>.  IN  A  <PUBLIC_IP_OF_CONTROLLER>
click.<domain>.        IN  A  <PUBLIC_IP_OF_CONTROLLER>

# All domains point to the same controller IP. Examples:
unsubscribe.newdomain.org.  IN  A  <CONTROLLER_IP>
click.newdomain.org.        IN  A  <CONTROLLER_IP>
```

The provisioning script prints the exact records to add if they are missing.

### 2. TLS + Nginx (automated by the script)

`scripts/provision-identity-hosts.sh` handles this using the template at
`scripts/templates/nginx-identity-subdomain.conf`. The pattern matches what is
documented in TRACKING.md §2 — both subdomains use the same proxy convention.

### 3. Backend env (no change required)

The backend env does **not** need to change per identity. `UNSUBSCRIBE_BASE_URL` is only
used as a fallback when the identity domain is unavailable (backward compat). The URL is
constructed dynamically from the identity's `domain` field at dispatch time.

```
UNSUBSCRIBE_SECRET=<openssl rand -hex 64>  # optional; falls back to JWT_SECRET
```

> The token signing secret is **shared** across all domains. A token generated for
> `unsubscribe.calerion.org` verifies identically on `unsubscribe.newdomain.org` — the
> domain is only the URL prefix, not part of the HMAC payload. The single secret in
> `UNSUBSCRIBE_SECRET` covers every identity domain you add.

### Per-domain readiness gate

`UnsubscribeHostReadiness` maintains a **per-domain** cache (one entry per active sending
identity). Each domain's readiness is probed independently — `serawin.net` campaign jobs
are never affected by the readiness of `newdomain.org`, and vice versa. The background
watcher probes every active domain on a 5-minute cycle and logs per-domain warnings.

## Legacy links

Emails sent before this change used `/unsubscribe?email=<addr>`. That route still exists for
backward compatibility but is now **non-mutating on GET** (renders a confirmation page; the
POST performs the change), so scanners can no longer auto-unsubscribe users. New emails never
use it.
