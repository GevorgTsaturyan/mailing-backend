# Backend — AGENTS.md

## Project Purpose

The backend is the **controller** for a distributed email campaign system. It manages all persistent state (contacts, templates, campaigns, send history, server infrastructure) in a single SQLite database and exposes two separate REST APIs:

1. **UI API** — consumed by the Vue frontend (JWT-authenticated)
2. **Node API** — consumed by mail-nodes running on remote VPS servers (apiKey-authenticated)

Critically, the backend does **not** send email itself. It queues `send_jobs` rows in the database. Remote `mail-node` agents poll those rows, send via their local Postfix, and report outcomes back. This separation lets you scale sending across any number of VPS servers without changing the controller.

---

## Architecture

```
Express 5  +  SQLite (better-sqlite3, WAL mode)  +  node-cron
```

- **Single process**: one Node.js process, one SQLite file, no external services required
- **Two auth planes**: JWT for human users, per-server `apiKey` for mail-node agents
- **Dual queue (Milestone 5 transition)**: `send_jobs` (legacy) and `jobs` (canonical) both active; a feature flag controls which one new campaigns write to. The legacy pipeline drains naturally.
- **All times UTC**: scheduledFor, createdAt, sentAt, deliveredAt are all ISO 8601 UTC strings
- **ESM modules** (`"type": "module"` in package.json)

---

## Folder Structure

```
backend/
  index.js                  # Express entry point: registers all routes, starts scheduler + offline watcher
  db.js                     # SQLite initialization: creates all tables on startup, ALTER TABLE migrations
  mailer.js                 # Legacy: sendCampaignEmail (dead code), testSmtpConnection, resetTransporter
  scheduler.js              # Job queue planner: planDaySends, planRecurringCampaigns, checkScheduledSends
                            #   Milestone 5: USE_CANONICAL_QUEUE flag routes new sends to jobs vs send_jobs
  seed.js                   # Dev-only seed data; skipped when NODE_ENV=production
  migrate.js                # One-time migration from legacy JSON files → SQLite (already done, keep for reference)
  create-admin.js           # CLI: node create-admin.js <username> <password> (creates or resets admin)
  setup-mail-server.sh      # Legacy: Postfix+OpenDKIM setup for the controller itself (no longer used)
  middleware/
    auth.js                 # requireAuth: validates JWT Bearer token, sets req.user
  routes/
    auth.js                 # POST /api/auth/login, GET /api/auth/me
    contacts.js             # CRUD /api/contacts (+ ?groupId filter) + POST /api/contacts/import (CSV, optional group)
    failed-mails.js         # GET /api/failed-mails (failed contacts + total), POST /:id/reset, DELETE /:id
    groups.js               # CRUD /api/groups + members + delete guard (409 / ?detach=true)
    templates.js            # CRUD /api/templates/:name
    send.js                 # POST /api/send (queue jobs), GET /api/send/jobs (queue overview)
    schedule.js             # GET/POST /api/schedule (daily batch config)
    scheduled-sends.js      # CRUD /api/scheduled-sends
    recurring-campaigns.js  # CRUD /api/recurring-campaigns + pause/resume
    log.js                  # GET/DELETE /api/log (send history)
    smtp.js                 # GET/PUT /api/smtp + POST /api/smtp/test
    providers.js            # CRUD /api/providers
    servers.js              # CRUD /api/servers + POST /:id/regenerate-key
    sender-identities.js    # CRUD /api/sender-identities + pause/resume + POST /:id/provision
    admin.js                # POST /api/admin/provision-identity → runs provision-identity-hosts.sh via execFile
    nodes.js                # Node API thin handlers: delegates register/heartbeat to services
                            #   Also: GET /provisioning-task (poll+claim) + POST /provisioning-task/:id/result
    jobs.js                 # Canonical job queue API (/api/jobs poll/start/complete/fail); poll attaches unsubscribeUrl
    inbox.js                # Inbound message API (/api/inbox list/get/read/unread/stats) — JWT required
    unsubscribe.js          # Public token-based unsubscribe: GET /u/:token (confirm page, no mutation) + POST /u/:token (RFC 8058 one-click + form)
  scripts/
    provision-identity-hosts.sh          # Idempotent: provisions nginx + Let's Encrypt for unsubscribe.<domain> AND click.<domain>
                                         #   Usage: sudo CERTBOT_EMAIL=x@y.com bash scripts/provision-identity-hosts.sh <domain>
                                         #   DNS records must be added first (Cloudflare/registrar); script detects & prints them
                                         #   Safe to re-run: skips nginx config write if file exists, skips certbot if cert dir exists
                                         #   Certbot failure (DNS not yet propagated) does NOT exit the script — nginx config is written,
                                         #   CERT_FAILED flag is set, script exits 0 with a summary. Re-run once DNS propagates.
    templates/
      nginx-identity-subdomain.conf      # HTTP nginx template used by provision-identity-hosts.sh; certbot adds the HTTPS block
  services/
    unsubscribeToken.js     # HMAC-signed unsubscribe tokens (no PII): signToken/verifyToken/buildUnsubscribeUrl(contactId,{identityId?,campaignId?,domain?}) — domain-aware: uses https://unsubscribe.<domain> when domain supplied, falls back to UNSUBSCRIBE_BASE_URL
    UnsubscribeHostReadiness.js  # Per-domain fail-closed dispatch gate (mirrors TrackingHostReadiness.js): per-domain Map cache,
                                 #   activeDomains() queries all active sender_identities, isReady(domain)/allowDispatch(domain) are
                                 #   domain-aware. getReadyDomains() returns Set<domain> for PollingService SQL filter. Probe:
                                 #   https://unsubscribe.<domain>/unsubscribe-health with hairpin-NAT fallback.
    SuppressionService.js   # Central "may we send to X?" gate: isContactSuppressed/isEmailSuppressed/suppressedContactIdSet/cancelOutstandingJobsForContact/suppressionExclusionSql
    InboxRepository.js      # DB layer for inbound_messages: insertMessage (HTML sanitized + dedup), listMessages (no body columns), getMessage, markRead/Unread, getUnreadCount
    GroupRepository.js      # DB layer for contact groups: CRUD, membership, contactIdsInGroups (union), usages (deletion guard)
    FailedMailRepository.js # DB layer for failed_mails: record (upsert, fail_count++), clear, list (join contacts), count
    SendLedger.js           # Per-campaign de-dup ledger: record, eligibleContacts (target_mode/groups + suppression), runBackfillOnce; DAILY_BATCH_SOURCE_ID
    ProvisioningService.js  # Applies node provisioning reports to sender_identities.verificationStatus (ownership-checked, safe metadata only)
    NodeRepository.js       # All DB queries for the servers table (node layer)
    NodeRegistrationService.js  # register(): validates apiKey, writes system info, returns identities
    HeartbeatService.js     # recordHeartbeat(): stores health JSON; startOfflineWatcher(): marks OFFLINE after 90 s
    CampaignResultService.js    # Milestone 5: onJobCompleted / onJobFailed — updates send_log, contacts, dailySentCount
    CampaignRepository.js       # Milestone 6: DB layer for campaigns table (create, findOrCreateManual, findById, markCompleted)
    CampaignStatsRepository.js  # Milestone 6: DB layer for campaign_stats (findOrCreate, incrementJobs/Sent/SendFailed, applyDeliveryEvent)
    DeliveryEventService.js     # Milestone 6: processes Postfix delivery events — dedup, FSM, campaign_stats, both pipelines
  data/
    mail.db                 # SQLite database — all live data lives here
    mail.db-shm             # WAL shared memory (auto-generated)
    mail.db-wal             # WAL log (auto-generated)
    contacts.json           # LEGACY — unused, safe to delete
    schedule.json           # LEGACY — unused, safe to delete
    sendLog.json            # LEGACY — unused, safe to delete
  templates/
    welcome.html            # Default HTML email template (seeded into DB on startup)
    welcome.txt             # Default plain-text version
  .env                      # Secrets — gitignored, create manually on each server
  .env.example              # Template for .env
  UNSUBSCRIBE.md            # Unsubscribe architecture + automated provisioning via scripts/provision-identity-hosts.sh
  unsubscribe.test.js       # Tests for the token-based unsubscribe endpoints (node --test)
  suppression.test.js       # Defense-in-depth suppression enforcement tests (node --test)
  ownership.test.js         # Multi-node identity/job ownership isolation tests (node --test)
  groups.test.js            # Contact groups CRUD, membership, group-aware CSV import (node --test)
  send-groups.test.js       # Groups as extra recipient source for manual + one-off sends (both queue modes)
  ledger.test.js            # SendLedger unit tests: claims, eligibility, guarded backfill
  scheduler-targeting.test.js  # End-to-end automated targeting via the ledger (both queue modes)
  groups-targeting.test.js  # target_mode config + group deletion safety (409 / detach) (both queue modes)
  admin-provision.test.js   # POST /api/admin/provision-identity: auth, validation, injection prevention, execFile args
  provisioning-task.test.js # Automated provisioning task flow: poll+claim, result DONE/FAILED, JWT provision trigger, idempotency
  inbox.test.js             # 30 tests (INBOX-A..Z5): node POST inbound-messages + JWT inbox CRUD, dedup, filters, pagination, read/unread, HTML sanitization
```

> Run the suite in **both** queue modes: `npm test` (legacy) and `USE_CANONICAL_QUEUE=true npm test` (canonical).

## Node / identity / job ownership (multi-node boundary)

Ownership chain: a mail node authenticates with its secret `apiKey` → `servers.id`;
`sender_identities.serverId` binds each identity to one node; `jobs.identity_id` binds each
job to one identity. **A node may only poll/claim jobs whose identity it owns (and that
identity is active).** Enforced in the canonical pipeline at three layers:
- **Poll:** `JobRepository.findNextPending(serverId)` INNER-JOINs `sender_identities` on
  `serverId + status='active'` — foreign/disabled/NULL-owner jobs are never returned.
- **Atomic claim:** `claimJob(id, nodeId, serverId)` includes the ownership subquery in the
  same `UPDATE … WHERE status='PENDING'`, so ownership can't race the claim.
- **Service:** `JobService.startJob(id, serverId)` returns 403 for a non-owned job (security
  boundary against arbitrary job ids), and `createJob` refuses a job with no active identity.

The controller is the authority for sender config: the poll response carries
`fromAddr/fromName/domain/dkimSelector/ip` from the identity JOIN; the node never chooses its
own identity. Legacy `/api/nodes/jobs` is already `serverId`-scoped (verified). Index
`idx_sender_identities_server(serverId, status, verificationStatus)` supports the ownership +
readiness filter.

## Provisioning verification (identity is only sendable when its node proves it)

Ownership + correct DNS is not enough: the owning node must prove it is locally provisioned
(DKIM key + OpenDKIM key/signing tables + Postfix sender transport with the right
`smtp_bind_address` and `smtp_helo_name`) and that DKIM-DNS + FCrDNS pass. The node POSTs
`/api/nodes/provisioning-report` (auth = apiKey → server; it never sends a serverId). Reports
apply only to identities OWNED by the authenticated node; others are rejected. Stored on
`sender_identities` as **safe metadata only**: `verificationStatus`
(`unverified|READY|NOT_READY|DNS_UNAVAILABLE`), `lastVerifiedAt`, `verificationReasons`,
`verifiedIpv4/Hostname/DkimSelector`. Never keys/secrets/paths.

**Sendable = `status='active' AND verificationStatus='READY'`** (`JobRepository.identitySendable`).
Enforced at: job creation (`JobService.createJob`, `scheduler.queueCanonicalJobForContact` +
legacy `queueJobForContact`, `routes/send.js`) **and** dispatch (`findNextPending`, `claimJob`,
`identityOwnedByServer`, legacy `/api/nodes/jobs`). Transitions: a transient `DNS_UNAVAILABLE`
report never downgrades a proven READY; a `NOT_READY` does. Changing an identity's
`domain/ip/dkimSelector` via the API resets it to `unverified` (verificationStatus is node-proven,
not settable through the identity API). Tests: `provisioning.test.js`.
**Migration:** after deploy, every identity is `unverified` until its node (running the new
agent) reports READY on registration — sending resumes within seconds per identity.

## OpenDKIM runtime failure guard (defense-in-depth signing)

Two independent layers ensure no production mail leaves unsigned:
1. **Node-local (final guarantee):** Postfix `milter_default_action = tempfail` defers (4xx) if
   the OpenDKIM milter is down — never sends unsigned. (mail-node template.)
2. **Controller early-prevention:** heartbeat carries `opendkim_running` + `opendkim_socket_ok`;
   `HeartbeatService.deriveSignerHealth` → `servers.openDkimHealthy` (1/0/NULL). Dispatch is
   withheld when explicitly `0` (`NodeRepository.isSignerHealthy`, enforced in `PollingService.poll`,
   `JobService.startJob` 409, and legacy `/api/nodes/jobs`). Unknown (NULL) stays permissive —
   the Postfix layer is the real boundary, so we don't stall on missing telemetry (§13 no-race).

**Retry, not fail:** temporary submission failures requeue instead of failing. Canonical:
`POST /api/jobs/:id/retry` → `JobService.retryJob` (PROCESSING→PENDING, linear backoff, attempts
cap `MAX_SEND_ATTEMPTS`=10; on cap → job FAILED but **contact untouched**). Legacy `/api/nodes/results`
requeues send_jobs for retryable categories without marking the contact. An OpenDKIM outage never
suppresses/fails contacts or destroys campaigns (§16). Tests: `dkim-guard.test.js`.

## Suppression enforcement (defense-in-depth)

`SuppressionService` is the single source of truth for recipient eligibility. Suppressed =
`contacts.status='unsubscribed'` (complaints map to it). `failed` is deliberately NOT treated as
permanent suppression (it conflates hard bounce with transient failure — that separation is the
future `suppression_list` task). Enforced at every send path:
- **Creation:** `queueCanonicalJobForContact` / `queueJobForContact` (return false + skip),
  `routes/send.js` (explicit per-contact skip), `JobService.createJob` (throws).
- **Claim:** `JobService.startJob` (cancels the job → 409) and `GET /api/nodes/jobs` (cancels +
  withholds). The controller DB is the authoritative gate right before the node sends.
- **Proactive:** unsubscribe (`/u/:token`, legacy `/unsubscribe`) and complaints
  (`DeliveryEventService`) call `cancelOutstandingJobsForContact` to cancel already-queued jobs.

Suppressed jobs become `CANCELLED` (canonical) / `cancelled` (legacy) — never counted as
sent/bounced; `checkAndCompleteCampaign` treats `CANCELLED` as terminal. Residual race: between
a node claiming a job and its SMTP submission there is an inherent DB↔SMTP window (not exactly-once).

Run tests: `npm test` (uses `node --test`; unsubscribe suite runs on an in-memory DB via DB_PATH).

---

## API

All routes except `/api/auth/*`, `/api/nodes/*`, `/u/:token`, and `/unsubscribe` require a valid JWT.

**Unsubscribe (public, token-based — see UNSUBSCRIBE.md):**
`GET /u/:token` renders a confirmation page (never mutates); `POST /u/:token` performs the
unsubscribe (confirmation form **and** RFC 8058 one-click `List-Unsubscribe=One-Click`), idempotent.
Token = HMAC-SHA256-signed contact id (no email/PII in URL). Tokens are domain-independent —
the same token verifies on any unsubscribe host sharing the signing secret.
Recipient-facing host is **identity-domain-aware**: `buildUnsubscribeUrl` accepts an optional
`domain` param; when provided it uses `https://unsubscribe.<domain>` (e.g.
`unsubscribe.calerion.org` for calerion.org sends, `unsubscribe.serawin.net` for serawin.net).
Both dispatch paths pass the identity's `domain` field from the `sender_identities` JOIN:
canonical pipeline (`GET /api/jobs/poll` → `routes/jobs.js`), legacy pipeline (`GET /api/nodes/jobs`
→ `routes/nodes.js`). Falls back to `UNSUBSCRIBE_BASE_URL` env var when no domain is supplied.
Secret is `UNSUBSCRIBE_SECRET` (falls back to `JWT_SECRET`). The controller attaches
`unsubscribeUrl` to every dispatched job; the mail-node emits it as both the `List-Unsubscribe`
header and the visible body link. Legacy
`/unsubscribe?email=` is kept but GET is now non-mutating.
`GET /unsubscribe-health` (public) is the probe target for the **unsubscribe-host readiness
gate** (`UnsubscribeHostReadiness.js`, fail-closed, **per-domain**): contact-bound jobs are
withheld per sending-identity domain at all three dispatch points (`PollingService.poll` via
`getReadyDomains()` SQL filter, `JobService.startJob` → 409 per domain, legacy
`GET /api/nodes/jobs` per-identity loop) until that domain's `unsubscribe.<domain>` host
verifies — mail never ships a dead `List-Unsubscribe` endpoint. Domain A's readiness never
affects Domain B. Withheld jobs stay PENDING/queued and dispatch resumes automatically.
Raw jobs (no contact, no unsubscribe URL) are never gated. Dev/test escape hatch:
`UNSUBSCRIBE_REQUIRE_READY=false`. Tests: `unsubscribe-readiness.test.js`.

### Inbox (JWT required — `/api/inbox/*`)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/inbox` | List messages. Query: `page`, `limit` (max 100), `domain`, `mailbox`, `is_read` (0/1), `search`. Returns `{messages[], total, page, limit}` (no body columns in list) |
| GET | `/api/inbox/stats` | `{unread}` count. Optional `domain`/`mailbox` filter |
| GET | `/api/inbox/:id` | Full message including `text_body`, `html_body` (sanitized), headers |
| PATCH | `/api/inbox/:id/read` | Mark read; returns `{ok}` |
| PATCH | `/api/inbox/:id/unread` | Mark unread; returns `{ok}` |

### Node — Inbound Messages (apiKey auth)
| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/nodes/inbound-messages` | Body: `{ apiKey, messages[] }`. Authenticates by apiKey. Inserts each message via `insertMessage` (dedup by message_id). Returns `{ok, inserted, duplicates, errors}` |

### Auth
| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/api/auth/login` | `{username, password}` | `{token, username}` |
| GET | `/api/auth/me` | — | `{username}` |

### Contacts
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/contacts` | All contacts ordered by id. Each row carries `groupIds: number[]` (ids of groups it belongs to, `[]` if none) — the frontend uses this to render the expandable groups + ungrouped tree |
| POST | `/api/contacts` | `{firstName, lastName, email, status?}` |
| PUT | `/api/contacts/:id` | Partial update (any field). Response does **not** include `groupIds`. Moving `status` off `'failed'` also clears the contact from `failed_mails` |
| DELETE | `/api/contacts/:id` | — |
| GET | `/api/contacts?groupId=N` | Only contacts in group N (JOIN contact_group_members); rows also carry `groupIds[]` |
| POST | `/api/contacts/import` | Multipart `file` field, CSV (firstName/lastName/email). Accepts alternate column names: first_name, firstname, Email, EMAIL. Skips duplicates. Optional multipart `groupId` **or** `newGroupName` adds **every** row (new *and* pre-existing) to that group. Returns `{imported, skipped, group?:{id,name,addedToGroup}}` |
| GET | `/api/failed-mails` | Contacts whose latest delivery failed, joined to the live contact, newest first. Returns `{total, items[]}` where each item is `{id, firstName, lastName, email, status, sentAt, reason, source('send'|'bounce'), failCount, firstFailedAt, failedAt}`. `total` = failed-contact count |
| POST | `/api/failed-mails/:id/reset` | Sets the contact (`:id`) back to `pending` (clears `sentAt`) and removes it from `failed_mails` so it can be re-queued |
| DELETE | `/api/failed-mails/:id` | Dismisses the contact from the failed list only; contact row/status untouched |

### Contact Groups
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/groups` | Groups with `memberCount` |
| POST | `/api/groups` | `{name, description?}`. 409 on duplicate name |
| PUT | `/api/groups/:id` | `{name?, description?}` |
| DELETE | `/api/groups/:id` | **409** with `{usages:{recurring[],dailyBatch}}` if targeted by an active/paused recurring campaign or the group-mode daily batch |
| DELETE | `/api/groups/:id?detach=true` | Detaches the group from those targets, **pauses** recurring campaigns / **disables** the daily batch left with zero groups, then deletes. Returns `{ok, detached:true, paused[], dailyBatchDisabled}` |
| POST | `/api/groups/:id/members` | `{contactIds[]}` → `{added, group}` (idempotent) |
| DELETE | `/api/groups/:id/members` | `{contactIds[]}` → `{removed, group}` |

Completed recurring campaigns and one-off/manual sends never block group deletion.

### Templates
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/templates` | Returns array of name strings only |
| GET | `/api/templates/:name` | Full template object `{name, subject, html, txt, content_type}` |
| POST | `/api/templates` | `{name, subject, html?, txt?, content_type?}`. `content_type`: `'html'` (default) or `'text'` |
| PUT | `/api/templates/:name` | `{subject?, html?, txt?, content_type?}` (partial) |
| DELETE | `/api/templates/:name` | — |

### Send
| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/send` | `{contactIds[], groupIds?[], templateName?, subject?, html?, txt?, senderIdentityId?, contentType?}`. Recipients = DISTINCT union of `contactIds` + members of `groupIds` (dedup **within this operation only**; the in-flight guard still applies; no ledger). `contentType`: `'html'` (default) or `'text'`. Returns `{results[], noIdentity}` |
| GET | `/api/send/jobs` | Queue overview with `?status=&limit=` filters. Joins identities, servers, providers. |

### Schedule (daily batch)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/schedule` | Returns `schedule_config` row + `groupIds[]` |
| POST | `/api/schedule` | `{startTime?, endTime?, batchSize?, template?, enabled?, target_mode?, groupIds?[]}`. `target_mode`: `'all'` (default) or `'groups'`. **400** if enabling `groups` mode with zero groups. Immediately calls planDaySends() |

### Scheduled Sends (one-off sends at a future datetime)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/scheduled-sends` | All, ordered by scheduledAt ASC. Includes `lastSendLogId` |
| GET | `/api/scheduled-sends/:id` | Single with `logs[]` and `contacts[]` |
| POST | `/api/scheduled-sends` | `{contactIds[], groupIds?[], scheduledAt, templateName? or subject+html+txt, label?, content_type?}`. `groupIds` are resolved to member ids **at creation** and merged into a DISTINCT `contactIds` snapshot (frozen — later membership changes don't affect it). `content_type`: `'html'` (default) or `'text'` |
| PUT | `/api/scheduled-sends/:id` | Only pending rows. `{label?, scheduledAt?, templateName?, subject?, html?, txt?, content_type?}` (recipient snapshot is not edited) |
| DELETE | `/api/scheduled-sends/:id` | — |

### Recurring Campaigns (day-over-day warmup sends)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/recurring-campaigns` | All, ordered by createdAt DESC. Each row includes `target_mode` and `groupIds[]` |
| POST | `/api/recurring-campaigns` | `{name, templateName? or subject+html+txt, startTime, endTime, initialCount, increasePercent, content_type?, target_mode?, groupIds?[]}`. `target_mode`: `'all'` (default) or `'groups'`; **400** if `groups` with zero groups |
| PUT | `/api/recurring-campaigns/:id` | Update config fields incl. `content_type?`, `target_mode?`, `groupIds?`. Switching to `all` clears targeted groups; `groups` with zero groups → 400 |
| POST | `/api/recurring-campaigns/:id/pause` | Sets status=paused |
| POST | `/api/recurring-campaigns/:id/resume` | Sets status=active |
| DELETE | `/api/recurring-campaigns/:id` | Also clears its ledger rows (`campaign_send_ledger` source `recurring`) |

### Log
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/log` | Last 500 send_log rows, newest first |
| DELETE | `/api/log` | Clears all rows |

### SMTP Config (legacy — only used for testSmtpConnection)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/smtp` | Returns config (password masked as ••••••••) |
| PUT | `/api/smtp` | `{host, port, secure, user, pass, fromName, fromAddr}`. Blank pass keeps existing. Resets transporter. |
| POST | `/api/smtp/test` | Tests connection with given credentials |

### Infrastructure
| Method | Path | Notes |
|--------|------|-------|
| GET/POST/PUT/DELETE | `/api/providers` | CRUD for provider records |
| GET/POST/PUT/DELETE | `/api/servers` | CRUD for server records + `GET /:id` with identities |
| POST | `/api/servers/:id/regenerate-key` | Generates new apiKey, returns it |
| GET/POST/PUT/DELETE | `/api/sender-identities` | CRUD. GET accepts `?serverId=` filter. **POST is idempotent**: if `(serverId, fromAddr)` already exists the existing row is returned (no duplicate INSERT). |
| POST | `/api/sender-identities/:id/pause` | Sets status=paused |
| POST | `/api/sender-identities/:id/resume` | Sets status=active |
| POST | `/api/sender-identities/:id/provision` | JWT required. Creates a `PENDING` provisioning task for this identity (the owning mail-node will claim it and run DKIM+Postfix+OpenDKIM). Idempotent: if a PENDING or IN_PROGRESS task already exists, returns it. Returns `{taskId, status, alreadyQueued?}` |

### Node API (apiKey authenticated, no JWT)
| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/nodes/register` | `{apiKey, node_id, hostname, version, ip, public_ip, os, uptime, capabilities[]}`. Stores full system info, sets status=online. Returns `{ok, serverId, identities[]}`. |
| POST | `/api/nodes/heartbeat` | `{apiKey, uptime, cpu, ram, disk, queue_size, postfix_running, opendkim_running}`. Stores health JSON in `servers.health`, sets status=online. If no heartbeat for 90 s, offline watcher sets status=offline. |
| GET | `/api/nodes/jobs` | `?apiKey=&limit=10`. Returns due queued jobs for this server's identities. Marks them claimed. Resets daily counts at day rollover. |
| POST | `/api/nodes/results` | `{apiKey, results[]}`. Reports send outcomes. Updates send_jobs, send_log, contacts. |
| POST | `/api/nodes/delivery-events` | `{apiKey, events[]}`. Delegates to `DeliveryEventService.processEvents`. Updates `delivery_events` (INSERT OR IGNORE), applies FSM transitions on `jobs.delivery_status`, updates `send_jobs`+`send_log` (both pipelines), updates `campaign_stats` counters, and marks contacts failed/unsubscribed. BOUNCED records the contact in `failed_mails` (source='bounce'); DELIVERED clears it. Returns `{ok, processed, skipped}`. |
| GET | `/api/nodes/provisioning-task` | `?apiKey=`. Returns the oldest `PENDING` provisioning task for this server's identities and atomically transitions it to `IN_PROGRESS`. Returns **204 No Content** when no task is pending. Response: `{id, identityId, domain, ip, selector}`. Node executes DKIM+Postfix+OpenDKIM locally, then POSTs the result. |
| POST | `/api/nodes/provisioning-task/:id/result` | `{apiKey, status:'DONE'\|'FAILED', phases:[{phase,status,message}], error?}`. Node reports task completion. Updates `provisioning_tasks.status`, sets `sender_identities.provisioningStatus`. On `DONE`: non-blocking fire of `provision-identity-hosts.sh` for nginx/TLS (uses same sudo mechanism as admin endpoint). |

### Job Queue API (Milestone 4 — fully active; Milestone 5: side-effects added)
| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/api/jobs` | JWT | `{identity_id?, recipient, subject, body?, priority?, content_type?}`. `content_type`: `'html'` (default) or `'text'` — controls MIME structure the node uses when sending. Creates a PENDING job. Returns the created job. `identity_id` must reference a `sender_identities` row with a populated `fromAddr` or the node will FAIL the job at send time. |
| GET | `/api/jobs/poll` | apiKey | `?apiKey=`. Read-only peek at the next PENDING job (highest priority, oldest first). Filters by `scheduled_for <= now` (withholds future-scheduled campaign jobs). Response includes `fromAddr`, `fromName`, `domain` from `sender_identities`. Returns the job or **204 No Content** if queue is empty. Does NOT claim the job. |
| POST | `/api/jobs/:id/start` | apiKey | `{apiKey}`. Atomically claims the job: PENDING → PROCESSING. Returns 409 if another node already claimed it. |
| POST | `/api/jobs/:id/complete` | apiKey | `{apiKey, queue_id?}`. Marks PROCESSING → SENT. **Milestone 5**: also calls `CampaignResultService.onJobCompleted` — updates `send_log` status, marks contact `sent`, increments `dailySentCount`, and clears the contact from `failed_mails`. Only the owning node may call this. |
| POST | `/api/jobs/:id/fail` | apiKey | `{apiKey, error_message?}`. Marks PROCESSING → FAILED. **Milestone 5**: also calls `CampaignResultService.onJobFailed` — marks `send_log` failed, marks contact `failed`, and records the contact in `failed_mails` (source='send'). Only the owning node may call this. |

### Admin (JWT required)
| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/api/admin/provision-identity` | `{domain}` | `{ok:true, domain, output}` or `{error, output}` |

`POST /api/admin/provision-identity` triggers `scripts/provision-identity-hosts.sh <domain>` on
the controller VPS (via `execFile('sudo', [scriptPath, domain])` — never a shell string). Requires
a one-time sudoers entry on the controller: `www-data ALL=(root) NOPASSWD: /path/to/scripts/provision-identity-hosts.sh`.
Domain is validated against `^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9](\.[...]+)+$` before use.
Returns 400 for missing/invalid domain, 500 if the script exits non-zero, 200 with `ok:true` and
script stdout+stderr on success. Tests: `admin-provision.test.js`.

### Public
| Method | Path | Notes |
|--------|------|-------|
| GET | `/unsubscribe?email=x` | Sets contact status=unsubscribed. Returns HTML confirmation page. |

---

## Database

All tables are created in `db.js` on startup via `CREATE TABLE IF NOT EXISTS`. Schema upgrades use `ALTER TABLE ... ADD COLUMN` wrapped in try/catch (idempotent).

```sql
jobs (
  id              INTEGER PK,
  status          TEXT DEFAULT 'PENDING',        -- PENDING | PROCESSING | SENT | FAILED | CANCELLED
  node_id         TEXT,                          -- String(server.id) of the claiming node; NULL until claimed
  identity_id     INTEGER FK→sender_identities (nullable),
  recipient       TEXT NOT NULL,                 -- destination email address
  subject         TEXT NOT NULL,
  body            TEXT DEFAULT '',               -- email body: HTML when content_type='html', plain text when content_type='text'
  content_type    TEXT DEFAULT 'html',           -- 'html' | 'text'; controls MIME structure on the node
  priority        INTEGER DEFAULT 0,             -- higher = dispatched first
  attempts        INTEGER DEFAULT 0,             -- incremented each time a node claims the job
  created_at      TEXT NOT NULL,
  started_at      TEXT,                          -- set when first claimed
  finished_at     TEXT,                          -- set on SENT or FAILED
  error_message   TEXT,                          -- set on FAILED
  queue_id        TEXT,                          -- Postfix queue ID reported by node on complete; links to mail.log
  -- Milestone 5: campaign fields (NULL for manually-created jobs via POST /api/jobs)
  scheduled_for   TEXT,                          -- dispatch withheld until this UTC timestamp; NULL = immediate
  contact_id      INTEGER,                       -- FK→contacts; allows completion handler to update contact status
  send_log_id     INTEGER,                       -- FK→send_log; allows completion handler to update send_log status
  -- Milestone 6: delivery tracking
  campaign_id     INTEGER FK→campaigns,          -- links job to its dispatch campaign; NULL for pre-M6 jobs
  delivery_status TEXT DEFAULT 'SMTP_PENDING'    -- Postfix delivery FSM; see DeliveryEventService
                                                 -- SMTP_PENDING|SMTP_ACCEPTED|DEFERRED|DELIVERED|BOUNCED|SEND_FAILED|COMPLAINED
)
-- Indexes: (status, priority DESC, created_at ASC) for O(1) poll; node_id, queue_id, campaign_id, delivery_status
-- Poll filter also applies scheduled_for: jobs with a future scheduled_for are withheld

contacts (
  id INTEGER PK, firstName TEXT, lastName TEXT,
  email TEXT UNIQUE, status TEXT DEFAULT 'pending', sentAt TEXT
)
-- Index: status (for scheduler queries that filter by pending/queued)
-- status: 'pending' | 'queued' | 'sent' | 'failed' | 'unsubscribed'

templates (
  name TEXT PK, subject TEXT, html TEXT, txt TEXT,
  content_type TEXT DEFAULT 'html'   -- 'html' | 'text'; propagated to jobs at dispatch time
)

users (
  id INTEGER PK, username TEXT UNIQUE, passwordHash TEXT
)

smtp_config (
  id INTEGER PK CHECK(id=1), host TEXT, port INTEGER DEFAULT 587,
  secure INTEGER DEFAULT 0, user TEXT, pass TEXT, fromName TEXT, fromAddr TEXT
)

schedule_config (
  id INTEGER PK CHECK(id=1), enabled INTEGER DEFAULT 0,
  time TEXT DEFAULT '09:00', batchSize INTEGER DEFAULT 10, template TEXT DEFAULT 'welcome',
  startTime TEXT DEFAULT '09:00', endTime TEXT DEFAULT '17:00'
)

scheduled_sends (
  id INTEGER PK, label TEXT, contactIds TEXT (JSON array),
  templateName TEXT, subject TEXT, html TEXT, txt TEXT,
  content_type TEXT DEFAULT 'html',   -- 'html' | 'text'
  scheduledAt TEXT, status TEXT DEFAULT 'pending', createdAt TEXT, sentAt TEXT
)
-- Index: (status, scheduledAt) for O(1) per-minute check in checkScheduledSends()

recurring_campaigns (
  id INTEGER PK, name TEXT, templateName TEXT,
  subject TEXT, html TEXT, txt TEXT,
  content_type TEXT DEFAULT 'html',   -- 'html' | 'text'
  startTime TEXT DEFAULT '09:00', endTime TEXT DEFAULT '17:00',
  initialCount INTEGER DEFAULT 10, increasePercent REAL DEFAULT 0,
  status TEXT DEFAULT 'active', currentDay INTEGER DEFAULT 0,
  lastRunDate TEXT, createdAt TEXT
)

providers (id INTEGER PK, name TEXT UNIQUE, createdAt TEXT)

servers (
  id INTEGER PK, providerId INTEGER FK→providers,
  label TEXT, mainIp TEXT, apiKey TEXT UNIQUE,
  status TEXT DEFAULT 'offline', lastSeenAt TEXT, createdAt TEXT,
  -- Added Milestone 1: Node Registration & Communication
  node_id TEXT,        -- stable hash derived from apiKey (16 hex chars)
  hostname TEXT,       -- os.hostname() from the node
  version TEXT,        -- package.json version from the node
  public_ip TEXT,      -- node's public-facing IP
  os_info TEXT,        -- platform + release string
  capabilities TEXT,   -- JSON array, e.g. '["send_email","health","postfix"]'
  health TEXT          -- JSON blob of last heartbeat metrics + recordedAt
)

sender_identities (
  id INTEGER PK, serverId INTEGER FK→servers,
  domain TEXT, ip TEXT, fromName TEXT, fromAddr TEXT,
  dkimSelector TEXT DEFAULT 'mail', dailyLimit INTEGER DEFAULT 50,
  warmupStage INTEGER DEFAULT 1, dailySentCount INTEGER DEFAULT 0,
  lastResetDate TEXT, status TEXT DEFAULT 'active', createdAt TEXT,
  -- Provisioning verification (node-proven, not directly settable via UI API)
  verificationStatus   TEXT DEFAULT 'unverified',  -- unverified|READY|NOT_READY|DNS_UNAVAILABLE
  lastVerifiedAt       TEXT,
  verificationReasons  TEXT,
  verifiedIpv4         TEXT,
  verifiedHostname     TEXT,
  verifiedDkimSelector TEXT,
  -- Automated provisioning workflow (UI-triggered → node executes → controller confirms)
  provisioningStatus   TEXT DEFAULT 'unprovisioned' -- unprovisioned|PENDING|IN_PROGRESS|DONE|FAILED
)

provisioning_tasks (
  id          INTEGER PK,
  identityId  INTEGER NOT NULL FK→sender_identities,
  serverId    INTEGER NOT NULL,
  status      TEXT DEFAULT 'PENDING',  -- PENDING|IN_PROGRESS|DONE|FAILED
  requestedAt TEXT NOT NULL,
  claimedAt   TEXT,
  completedAt TEXT,
  phases      TEXT,   -- JSON [{phase, status, message}] per execution step
  error       TEXT    -- top-level error message on FAILED
)
-- Index: (serverId, status, requestedAt) for O(1) poll per server

send_jobs (
  id INTEGER PK, senderIdentityId INTEGER FK→sender_identities,
  contactId INTEGER, email TEXT, firstName TEXT, lastName TEXT,
  templateName TEXT, subject TEXT, html TEXT, txt TEXT,
  content_type TEXT DEFAULT 'html',   -- 'html' | 'text'
  status TEXT DEFAULT 'queued',   -- queued|claimed|sent|failed|delivered|bounced|deferred
  scheduledFor TEXT, queueId TEXT, dsnCode TEXT, relay TEXT,
  remoteResponse TEXT, reasonCategory TEXT, reasonDetail TEXT,
  claimedAt TEXT, sentAt TEXT, deliveredAt TEXT,
  sendLogId INTEGER, scheduledSendId INTEGER, createdAt TEXT
)
-- Indexes: status, senderIdentityId, scheduledFor, queueId

delivery_events (
  id             INTEGER PK,
  sendJobId      INTEGER,    -- FK→send_jobs (legacy pipeline); NULL for canonical pipeline events
  queueId        TEXT,       -- Postfix queue ID (correlation key)
  email          TEXT,
  eventType      TEXT,       -- 'sent' | 'bounced' | 'deferred'
  dsnCode        TEXT,       -- e.g. '2.0.0', '5.1.1', '4.2.2'
  relay          TEXT,       -- remote MX host
  response       TEXT,       -- full SMTP response (truncated to 500 chars)
  reasonCategory TEXT,       -- from classify.js
  reasonDetail   TEXT,
  logTime        TEXT,       -- timestamp from mail.log line
  createdAt      TEXT NOT NULL,
  -- Milestone 6: delivery tracking
  job_id         INTEGER,    -- FK→jobs (canonical pipeline); NULL for legacy send_jobs events
  dedup_key      TEXT UNIQUE -- queue_id + '_' + event_type + '_' + log_time; INSERT OR IGNORE prevents duplicates
)
-- Indexes: queueId, sendJobId, job_id; UNIQUE on dedup_key

send_log (
  id INTEGER PK, date TEXT, contactId INTEGER, name TEXT, email TEXT,
  template TEXT, status TEXT, previewUrl TEXT, error TEXT,
  scheduledSendId INTEGER, subject TEXT, body TEXT,
  sendJobId INTEGER, senderIdentityId INTEGER, queueId TEXT,
  deliveryStatus TEXT, dsnCode TEXT, remoteMx TEXT, remoteResponse TEXT,
  reasonCategory TEXT, reasonDetail TEXT, deliveredAt TEXT, lastEventAt TEXT
)
-- Index: scheduledSendId (for log lookups by scheduled send)

-- Milestone 6: campaign and stats tables

campaigns (
  id                    INTEGER PK,
  type                  TEXT NOT NULL,     -- 'manual' | 'scheduled_send' | 'recurring' | 'daily_batch'
  scheduled_send_id     INTEGER FK→scheduled_sends (nullable),   -- set when type='scheduled_send'
  recurring_campaign_id INTEGER FK→recurring_campaigns (nullable), -- set when type='recurring'
  identity_id           INTEGER FK→sender_identities (nullable),
  label                 TEXT,             -- human-readable dispatch label
  status                TEXT DEFAULT 'running',  -- 'running' | 'completed' | 'cancelled'
  date                  TEXT NOT NULL,    -- YYYY-MM-DD UTC dispatch date
  created_at            TEXT NOT NULL,
  completed_at          TEXT
)
-- Exclusive arcs: at most one of scheduled_send_id / recurring_campaign_id is non-NULL.
-- Manual and daily_batch campaigns have both NULL.
-- Manual sends on the same calendar day share one campaigns row (grouped by day + identity).
-- Indexes: (type, date), scheduled_send_id, recurring_campaign_id

campaign_stats (
  id                       INTEGER PK,
  campaign_id              INTEGER NOT NULL UNIQUE FK→campaigns,
  total_jobs               INTEGER DEFAULT 0,   -- jobs created for this campaign
  total_sent               INTEGER DEFAULT 0,   -- SMTP_ACCEPTED (Postfix took the message)
  total_send_failed        INTEGER DEFAULT 0,   -- SEND_FAILED (Postfix rejected submission)
  total_delivered          INTEGER DEFAULT 0,   -- DELIVERED (2.x.x DSN from remote MX)
  total_bounced            INTEGER DEFAULT 0,   -- BOUNCED (5.x.x DSN, hard bounce)
  total_currently_deferred INTEGER DEFAULT 0,   -- currently awaiting retry; decremented on delivery
  total_complained         INTEGER DEFAULT 0,   -- COMPLAINED (ISP spam report)
  last_updated             TEXT,
  created_at               TEXT NOT NULL
)
-- Permanent record: survives the 90-day delivery_events retention window.
-- Updated transactionally on every delivery event (same db.transaction as delivery_events INSERT).
-- Nightly reconciliation compares counters to delivery_events for recently-active campaigns.

-- ── Contact groups + campaign targeting ──────────────────────────────────────
contact_groups (
  id INTEGER PK, name TEXT UNIQUE NOT NULL, description TEXT, createdAt TEXT NOT NULL
)
contact_group_members (
  group_id INTEGER FK→contact_groups ON DELETE CASCADE,
  contact_id INTEGER FK→contacts ON DELETE CASCADE,
  addedAt TEXT NOT NULL, PRIMARY KEY (group_id, contact_id)
)   -- index on contact_id

-- Targeting junctions. group_id FK is ON DELETE RESTRICT so the app-level deletion
-- guard (409 / ?detach) decides, rather than a group silently vanishing from a live target.
recurring_campaign_groups (
  recurring_campaign_id INTEGER FK→recurring_campaigns ON DELETE CASCADE,
  group_id INTEGER FK→contact_groups ON DELETE RESTRICT,
  PRIMARY KEY (recurring_campaign_id, group_id)
)   -- index on group_id
daily_batch_groups ( group_id INTEGER FK→contact_groups ON DELETE RESTRICT PRIMARY KEY )

-- Per-campaign de-dup ledger (Phase 3): "this contact has been committed to this source".
-- Decoupled from contacts.status and from jobs/send_jobs (survives their archival).
campaign_send_ledger (
  source_type TEXT NOT NULL,   -- 'recurring' | 'daily_batch'
  source_id   INTEGER NOT NULL,-- recurring_campaigns.id, or DAILY_BATCH_SOURCE_ID (=1) for the batch
  contact_id  INTEGER FK→contacts ON DELETE CASCADE,
  queued_at   TEXT NOT NULL, PRIMARY KEY (source_type, source_id, contact_id)
)   -- index on contact_id

-- target_mode column added to both (ALTER, DEFAULT 'all' → existing rows keep whole-pool behaviour):
recurring_campaigns.target_mode TEXT NOT NULL DEFAULT 'all'  -- 'all' | 'groups'
schedule_config.target_mode     TEXT NOT NULL DEFAULT 'all'  -- 'all' | 'groups'

-- One-time migration marker (SendLedger.runBackfillOnce):
schema_migrations ( name TEXT PK, ran_at TEXT NOT NULL )

-- Inbound messages received by mail-nodes (Dovecot LMTP delivery):
inbound_messages (
  id              INTEGER PK,
  message_id      TEXT,          -- RFC 2822 Message-ID (nullable; not all mail has one)
  from_address    TEXT NOT NULL DEFAULT '',
  from_name       TEXT,
  to_address      TEXT NOT NULL DEFAULT '',
  reply_to        TEXT,
  subject         TEXT NOT NULL DEFAULT '',
  text_body       TEXT,          -- plain-text part (or text extracted from HTML-only emails)
  html_body       TEXT,          -- sanitized HTML (xss filterXSS; scripts/iframes stripped)
  received_at     TEXT NOT NULL, -- from parsed email headers
  is_read         INTEGER NOT NULL DEFAULT 0,
  read_at         TEXT,
  mailbox         TEXT NOT NULL DEFAULT '',  -- e.g. support@calerion.org
  domain          TEXT NOT NULL DEFAULT '',  -- calerion.org (derived from mailbox)
  in_reply_to     TEXT,
  msg_references  TEXT,          -- NOTE: 'references' is a SQLite reserved word → renamed
  server_id       INTEGER NOT NULL DEFAULT 0,  -- FK→servers (which mail-node delivered this)
  snippet         TEXT,          -- first 200 chars of plain text; used in list view
  has_attachments INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
)
-- Indexes:
--   UNIQUE partial: idx_inbound_messages_message_id ON (message_id) WHERE message_id IS NOT NULL
--   idx_inbound_messages_mailbox, _domain, _is_read, _received_at DESC, _from_address

-- Contacts whose latest delivery failed (one row per contact; the Failed Mails UI):
failed_mails (
  contact_id      INTEGER PK REFERENCES contacts(id) ON DELETE CASCADE,
  email           TEXT NOT NULL DEFAULT '',  -- snapshot of the recipient at fail time
  reason          TEXT,                       -- error message / bounce detail
  source          TEXT NOT NULL DEFAULT 'send', -- 'send' (SMTP submit fail) | 'bounce' (hard bounce)
  fail_count      INTEGER NOT NULL DEFAULT 1,  -- climbs on each repeat failure (upsert)
  first_failed_at TEXT NOT NULL,
  failed_at       TEXT NOT NULL                -- most recent failure
)
-- Index: idx_failed_mails_failed_at ON (failed_at DESC)
-- Written by FailedMailRepository.record() from CampaignResultService.onJobFailed
-- (source='send') and DeliveryEventService BOUNCED (source='bounce'). Cleared by
-- .clear() on a later success (onJobCompleted / delivery DELIVERED), on reset, or
-- when a contact's status is edited off 'failed'.
```

---

## Contact Groups & Campaign Targeting (groups + ledger)

Imported contacts can be organised into named **groups** (many-to-many). Recurring
campaigns and the daily batch **target** either all contacts or a set of groups;
manual send and one-off scheduled sends can add groups as an extra recipient source.

### target_mode semantics
- `recurring_campaigns.target_mode` / `schedule_config.target_mode` ∈ `'all' | 'groups'`.
- `'all'` = the whole contact pool. `'groups'` = DISTINCT union of the targeted groups' members.
- **An empty group set is NEVER "all"** — it yields zero recipients. The API rejects
  saving/enabling a `groups`-mode source with no groups (400). Existing rows default to `'all'`.

### De-duplication (three layers)
1. **Within one operation** — recipient sets are `DISTINCT` (manual send, one-off snapshot, group union).
2. **Per-campaign ledger** — `campaign_send_ledger` records each (source, contact) at queue
   time, so recurring campaigns / daily batch send a given contact **once per source, ever**
   (across days and overlapping groups). Different sources are independent — the same contact
   can be reached once by each campaign.
3. **In-flight guard** — manual send still skips a contact with a PENDING/PROCESSING job.

Only `unsubscribed` contacts are excluded from automated selection before `LIMIT`
(`SuppressionService.suppressionExclusionSql`); `sent`/`queued`/`failed` are **not** selection
filters — "already handled for this campaign" is the ledger's job (so a `failed` contact stays
eligible for a *different* campaign).

### Ledger write — atomic, ledger-first
`queueJobForContact` (legacy) and `queueCanonicalJobForContact` (canonical) take an optional
`ledger = {sourceType, sourceId}`. Inside the **same transaction** as the job insert, the
ledger claim (`INSERT OR IGNORE`) runs **first**; if it's a no-op (already committed) no job is
created. Net: never a ledger row without a queued job, never a queued job without its ledger row.
`DAILY_BATCH_SOURCE_ID = 1` is the fixed sentinel used for the singleton daily batch everywhere
(selection, write, backfill). Manual / one-off sends pass no ledger → unchanged.

### Migration backfill (`SendLedger.runBackfillOnce`, called in index.js before initScheduler)
Because automated selection moved off `status='pending'`, existing sources are seeded so they
don't resend already-handled contacts: every contact with `status <> 'pending'` is inserted into
the ledger of each `active`/`paused` recurring campaign and the daily-batch sentinel — faithfully
reproducing the old shared-pool behaviour. It is **guarded + atomic**: seeding and the
`schema_migrations` marker commit in one transaction, so it runs **exactly once** (a crash rolls
back and re-runs; it never re-seeds contacts that became non-pending *after* migration). New
campaigns created post-migration start with an empty ledger (can reach anyone — intended).

### Group deletion safety
`DELETE /api/groups/:id` returns **409** (with `usages`) when the group is targeted by an
`active`/`paused` recurring campaign or the group-mode daily batch. `?detach=true` removes the
group from those targets, **pauses** recurring campaigns / **disables** the daily batch left with
zero groups, and deletes. Completed recurring campaigns and one-off/manual sends never block.

---

## Services

### InboxRepository.js — DB Layer for Inbound Messages

All SQLite queries for `inbound_messages`. Handles HTML sanitization, deduplication, and
server-side filtering/pagination.

**HTML sanitization (`sanitizeHtml`):** runs on every `html_body` at insert time (before storage).
Uses `xss` `filterXSS` with an email-safe tag/attribute allowlist (html, head, body, table layout
tags, a, img, font, etc.). Strips `script`, `noscript`, `iframe`, `object`, `embed`, `form` and
their bodies. Validates `href` (allows only `http:`, `https:`, `mailto:`, `cid:`, `#`; strips
others). Validates `img src` (allows `http:`, `https:`, `cid:`, `data:image/`). Post-processes to
add `target="_blank" rel="noopener noreferrer"` to every `<a>` tag. Returns `null` for null input.

**Functions:**
- `insertMessage(serverId, msg)` — checks for existing `message_id` (dedup), sanitizes `html_body`,
  derives `domain` from `mailbox`, computes `snippet` from text body, inserts. Returns `{ id, duplicate }`.
- `listMessages({ page, limit, domain, mailbox, is_read, search })` — dynamic WHERE, ORDER BY
  `received_at DESC`. SELECT excludes `text_body` / `html_body` (large columns omitted from list view).
  Returns `{ messages, total, page, limit }`.
- `getMessage(id)` — `SELECT *` including full body columns; returns `null` if not found.
- `markRead(id)` — sets `is_read=1`, `read_at=now`.
- `markUnread(id)` — sets `is_read=0`, `read_at=NULL`.
- `getUnreadCount({ domain?, mailbox? })` — COUNT with optional domain/mailbox filter.

### JobRepository.js — DB Layer for Jobs
All SQLite queries for the `jobs` table. Six functions:
- `create(fields)` — inserts a PENDING job; returns the created row
- `findById(id)` — returns a single job by primary key
- `findNextPending()` — selects the highest-priority PENDING job whose `scheduled_for IS NULL OR scheduled_for <= now`; LEFT JOINs sender_identities for fromAddr/fromName/domain. Returns null if queue is empty.
- `claimJob(id, nodeId)` — `UPDATE … WHERE id=? AND status='PENDING'`; returns `true` if `changes===1` (won the race), `false` otherwise
- `markSent(id, nodeId, queueId)` — `UPDATE … WHERE id=? AND status='PROCESSING' AND node_id=?`; stores Postfix `queue_id`; returns `true` on success
- `markFailed(id, nodeId, errorMessage)` — same guard as markSent; sets error_message
- `markCancelled(id)` — cancels PENDING or PROCESSING jobs (internal utility, no API endpoint)

### CampaignResultService.js — Completion Side-Effects for Campaign Jobs (Milestone 5+6)
Called by `routes/jobs.js` after a canonical job transitions to SENT or FAILED. Mirrors the
side-effects that `POST /api/nodes/results` produces for the legacy send_jobs pipeline.
- `onJobCompleted(jobId, queueId)` — fetches the job; marks send_log `sent` + stores queueId; marks contact `sent`; increments `dailySentCount`; **M6**: atomically sets `jobs.delivery_status = 'SMTP_ACCEPTED'` and calls `incrementSent(campaign_id)` if the job has a campaign
- `onJobFailed(jobId, errorMessage)` — fetches the job; marks send_log `failed`; marks contact `failed`; **M6**: atomically sets `jobs.delivery_status = 'SEND_FAILED'` and calls `incrementSendFailed(campaign_id)` if the job has a campaign
Both functions are no-ops for jobs with no campaign_id (safe to call for any jobs-table row).

### CampaignRepository.js — DB Layer for Campaigns (Milestone 6)
All SQLite queries for the `campaigns` table. Four functions:
- `create({ type, date, identity_id?, label?, scheduled_send_id?, recurring_campaign_id? })` — inserts a `running` campaign row; returns the inserted row
- `findOrCreateManual(date, identityId?)` — idempotent: returns the existing `type='manual'` campaign for that day+identity pair, or creates one. All manual sends within a calendar day share one campaigns row. Uses `identity_id IS ?` for NULL-safe SQLite comparison.
- `findById(id)` — returns a single campaign by PK or `null`
- `markCompleted(id)` — sets `status='completed'` and `completed_at=now`

**Exclusive-arcs invariant**: at most one of `scheduled_send_id` / `recurring_campaign_id` is non-NULL per row. `manual` and `daily_batch` campaigns have both NULL.

### CampaignStatsRepository.js — DB Layer for Campaign Stats (Milestone 6)
All SQLite queries for the `campaign_stats` table. Five functions:
- `findOrCreate(campaignId)` — returns existing stats row or inserts a zeroed row. **Must be called inside the caller's `db.transaction()`** — it does not wrap itself.
- `incrementJobs(campaignId, count?)` — called after creating jobs for a campaign (from scheduler, Phase 3+)
- `incrementSent(campaignId)` — called from `CampaignResultService.onJobCompleted` (Phase 3+)
- `incrementSendFailed(campaignId)` — called from `CampaignResultService.onJobFailed` (Phase 3+)
- `applyDeliveryEvent(campaignId, priorStatus, newStatus)` — updates counters based on the FSM transition. **Must be called inside the caller's `db.transaction()`**. Key counter rules:
  - `DEFERRED`: increments `total_currently_deferred` only when `priorStatus !== 'DEFERRED'` (first entry only)
  - `DELIVERED` from `DEFERRED`: decrements `total_currently_deferred` AND increments `total_delivered`
  - `BOUNCED` from `DEFERRED`: decrements `total_currently_deferred` AND increments `total_bounced`
  - `COMPLAINED`: increments `total_complained` (always)

### DeliveryEventService.js — Delivery Event Processor (Milestone 6)
`processEvents(events[])` — processes a batch of Postfix mail.log delivery events. Returns `{processed, skipped}`.

Each event is processed in its own `db.transaction()`. A bad event never blocks the rest of the batch.

**Event fields**: `queueId`, `eventType` (`'sent'`|`'bounced'`|`'deferred'`|`'complained'`), and optionally `dsnCode`, `relay`, `response`, `reasonCategory`, `reasonDetail`, `logTime`, `email`.

**Processing order per event:**
1. Map `eventType` → internal `delivery_status` via `EVENT_TO_STATUS`. Unknown types are skipped.
2. Compute `dedup_key = queueId + '_' + eventType + '_' + (logTime ?? now)`
3. Look up both pipelines: `lookupCanonicalJob` (by `jobs.queue_id`) and `lookupLegacySendJob` (by `send_jobs.queueId`)
4. `INSERT OR IGNORE INTO delivery_events` — if `changes === 0`, the event is a duplicate; return `{skipped: true}`
5. Compute `priorStatus = canonicalJob?.delivery_status ?? 'SMTP_PENDING'` and FSM priority check
6. Always update `send_jobs` (legacy pipeline guard: `WHERE status NOT IN ('delivered','bounced')`)
7. If FSM allows: update `send_log` (both pipelines via `queueId`), update `jobs.delivery_status`, update `campaign_stats` (canonical jobs with `campaign_id` only), mark contact `failed` (BOUNCED) or `unsubscribed` (COMPLAINED)

**FSM priority map** (higher wins; equal is allowed):
```
SMTP_PENDING(0) < SMTP_ACCEPTED(1) < DEFERRED(2) < DELIVERED/BOUNCED/SEND_FAILED(3) < COMPLAINED(4)
```
Late `DEFERRED` events arriving after `DELIVERED` are recorded in `delivery_events` but do not regress `jobs.delivery_status` or counters.

After the transaction, if `didTransition` is true and the new status is terminal, `checkAndCompleteCampaign(campaignId)` is called. This runs outside the delivery-event transaction so the completion check doesn't extend the write lock.

All prepared statements are module-level (compiled once, reused across all calls).

### JobService.js — Job Lifecycle Logic
Validates inputs and orchestrates state transitions via JobRepository:
- `createJob(fields)` — validates recipient/subject, delegates to create
- `startJob(id, nodeId)` — checks job exists and is PENDING, then calls claimJob; returns `{ok, job}` or `{error, status}`
- `completeJob(id, nodeId, queueId)` — checks ownership and PROCESSING status, calls markSent with queueId
- `failJob(id, nodeId, errorMessage)` — checks ownership and PROCESSING status, calls markFailed

### PollingService.js — Poll Abstraction
Single exported function `poll()` — wraps `findNextPending()` for use by the route handler. Keeps the controller thin and makes the polling strategy swappable without touching the route.

Note: `JobRepository.markCancelled(id)` is implemented but has no API endpoint. It is an internal utility reserved for future admin tooling or job cleanup scripts.

### NodeRepository.js — DB Layer for Nodes
All SQLite queries for the `servers` table's node-communication fields. Four functions:
- `findByApiKey(apiKey)` — authenticates a node request
- `updateRegistration(serverId, fields)` — writes node_id, hostname, version, ip, public_ip, os_info, capabilities; sets status=online
- `updateHeartbeat(serverId, health)` — stores health JSON, sets status=online, updates lastSeenAt
- `markStaleOffline(thresholdMs)` — sets status=offline for any server whose lastSeenAt is older than thresholdMs

### NodeRegistrationService.js — Registration Logic
`register(body)` — validates apiKey, calls NodeRepository.updateRegistration, returns `{ok, serverId, identities}` or `{error, status}`.

### HeartbeatService.js — Heartbeat + Offline Detection
- `recordHeartbeat(apiKey, metrics)` — validates apiKey, builds health object, calls NodeRepository.updateHeartbeat
- `startOfflineWatcher()` — called once on startup; sets a 30 s interval that calls `markStaleOffline(90_000)`. Any node silent for 90 s gets status=offline.

### CloudflareService.js — DNS Provisioning (CF API)
`provisionDns({ domain, ip, selector, dkimPublicKey, controllerIp })` — creates/verifies all
DNS records for a sender identity via the Cloudflare API. All operations are idempotent.
Returns `{ ok, phases, skipped? }`. When `CF_API_TOKEN` is unset, returns `ok:false, skipped:true`.

**Call order and phase keys:**
1. `a_mail` — `A mail.<domain> → <ip>` (absent→create, correct→skip, wrong→update)
2. `mx` — `MX <domain> 10 mail.<domain>` (absent→create, correct→skip, wrong host/priority→update)
3. `spf` — `TXT <domain>` v=spf1 (absent→create, ip missing→merge, 2+ records→FAIL)
4. `dkim` — `TXT <sel>._domainkey.<domain>` (absent→create, same→skip, different→FAIL — never overwrite)
5. `dmarc` — `TXT _dmarc.<domain>` (absent→create p=none, existing→preserve — never overwrite)
6. `a_unsubscribe` — `A unsubscribe.<domain> → <controllerIp>` (only if controllerIp provided)
7. `a_click` — `A click.<domain> → <controllerIp>` (only if controllerIp provided)

`ok=false` when any phase is FAILED or PENDING (DKIM key not yet available).
`cloudflare.phases.mx` failing blocks the READY badge in `controllerComplete()` (Servers.vue) —
the identity stays NEEDS_ATTENTION until MX is confirmed, preventing sending with a broken inbound path.
Tests: `cloudflare.test.js` (30 tests, mocked fetch, no real CF calls).

### ProvisioningRetryService.js — Controller-Side Provisioning Health Loop
Runs every 5 minutes (`startProvisioningRetryService()`). Candidates: all identities with
`provisioningStatus = 'DONE'` **plus** identities with `provisioningStatus = 'unprovisioned' AND
verificationStatus = 'READY'` (manually configured identities that predate the controller
pipeline — e.g. serawin.net). Two cases per identity:

- **Case A** (`verificationStatus != 'READY'`): re-runs `runControllerProvisioning()` when
  Cloudflare/DNS/nginx phases still need work (`controllerNeedsRetry(phases)`). Schedules a
  mail-node `reverify` task (cooldown-guarded via `nextReverifyAt`) to re-evaluate DNS/DKIM/FCrDNS.
- **Case B** (`verificationStatus = 'READY'`): strictly probes
  `https://click.<domain>/tracking-health` and `https://unsubscribe.<domain>/unsubscribe-health`
  via `checkControllerHostsHealthy()`. Writes result to `provisioningPhases.controllerHealth`.
  If either host fails, re-runs the controller pipeline (idempotent heal). If both are healthy,
  no provisioning changes are made — **no nginx/DNS/Postfix changes**. Never schedules a reverify
  for an already-READY identity.

**UI implication:** `controllerComplete()` in `Servers.vue` short-circuits to `true` when
`provisioningPhases.controllerHealth.status === 'OK'`, clearing the amber NEEDS_ATTENTION badge.
Manually provisioned identities (provisioningStatus = 'unprovisioned') previously caused a
permanent false NEEDS_ATTENTION because they were excluded from the loop and controllerHealth was
never written. The expanded candidates query fixes this.

Exports: `runRetries` (injectable for tests), `controllerNeedsRetry`, `startProvisioningRetryService`.
Tests: `provisioning-retry.test.js` (19 tests, in-memory DB, no network/CF/certbot).

### scheduler.js — Job Planner (Milestone 5: dual-queue; Milestone 6: campaign integration)
Does NOT send email. Creates job queue rows for mail-nodes to pick up.

**Feature flag**: reads `USE_CANONICAL_QUEUE` from env at call time. When `true`, all three planner functions write to the `jobs` table (canonical pipeline). When `false` or unset, they write to `send_jobs` (legacy pipeline). The legacy pipeline drains existing rows normally regardless of the flag.

**Daily limit enforcement (canonical path only)**: `getIdentityRemainingCapacity(identityId)` resets `dailySentCount` if the calendar day changed, then returns `max(0, dailyLimit - dailySentCount)`. Planners cap their batch at this capacity before fetching contacts — the queue only holds dispatchable jobs.

**`queueCanonicalJobForContact(contact, templateName, templateContent, scheduledFor?, scheduledSendId?, senderIdentityId?, campaignId?, ledger?)`** — **exported**. Creates a `send_log` row + `jobs` row atomically (own `db.transaction()`). Sets `campaign_id` on the job. Optional `ledger = {sourceType, sourceId}` inserts a `campaign_send_ledger` claim **first** in the same transaction (ledger-first): if the contact is already committed the job is skipped. `queueJobForContact` (legacy) takes the same optional `ledger`. Manual send / `checkScheduledSends` pass no ledger.

**`planDaySends()`** — called on startup + every midnight UTC:
- Selects recipients via `SendLedger.eligibleContacts` for source `daily_batch`/`DAILY_BATCH_SOURCE_ID` (honours `target_mode`/groups, excludes ledgered + unsubscribed) — **not** `status='pending'`
- **Canonical**: picks active identity, caps count by remaining capacity, generates random timestamps in window; creates a `type='daily_batch'` campaign row, then calls `queueCanonicalJobForContact` (with the daily-batch ledger source) for each contact; calls `incrementJobs` after the loop
- **Legacy**: generates random timestamps, creates `send_jobs` rows (also with the ledger source)

**`planRecurringCampaigns()`** — called on startup + every midnight UTC:
- For each `active` recurring campaign where `lastRunDate != today`:
- Computes today's count: `round(initialCount × (1 + increasePercent/100)^currentDay)`
- Selects recipients via `SendLedger.eligibleContacts` (honours `target_mode`/groups, excludes ledgered + unsubscribed) — **not** `status='pending'`
- **Canonical**: caps count by remaining capacity; creates a `type='recurring'` campaign row with `recurring_campaign_id` FK set; calls `queueCanonicalJobForContact` (with the recurring ledger source) for each contact; calls `incrementJobs`
- **Legacy**: creates `send_jobs` rows (also with the ledger source)
- Updates `lastRunDate` and increments `currentDay`; marks `completed` when no **eligible** contacts remain (pool exhausted for this campaign)

**`checkScheduledSends()`** — called every minute by cron:
1. Finds `scheduled_sends` where `status='pending' AND scheduledAt <= now`; marks them `sent`
2. **Canonical**: creates a `type='scheduled_send'` campaign row with `scheduled_send_id` FK set (inside the outer `db.transaction()`); calls `queueCanonicalJobForContact` for each contact up to `remainingCapacity`; calls `incrementJobs`
3. **Legacy**: unchanged — creates `send_jobs` rows for all contacts

### mailer.js — Legacy SMTP Client
`sendCampaignEmail()` is **dead code** — not called anywhere in the current codebase. The architecture moved to mail-nodes. Only two functions are still active:
- `testSmtpConnection(cfg)` — used by `POST /api/smtp/test`
- `resetTransporter()` — called after SMTP config update

---

## Scheduler

node-cron runs two jobs:
- `0 0 * * *` UTC midnight: calls `planDaySends()` + `planRecurringCampaigns()`
- `* * * * *` every minute: calls `checkScheduledSends()`

Both are also called once on startup (`initScheduler()`).

---

## Mail Flow

### Legacy pipeline (send_jobs — USE_CANONICAL_QUEUE=false or unset)
```
1. User action (UI send, scheduler: daily batch / recurring / scheduled send)
        ↓
2. Backend creates send_jobs rows (status=queued, scheduledFor=ISO timestamp or null)
        ↓
3. Mail-node polls GET /api/nodes/jobs?apiKey=…&limit=10
   → Controller filters: status=queued, scheduledFor <= now, within dailyLimit
   → Controller marks jobs claimed, resets dailySentCount at day rollover
        ↓
4. Mail-node sends each job via Nodemailer → localhost:25 (Postfix)
        ↓
5. Mail-node POSTs /api/nodes/results → Controller updates send_jobs, send_log, contacts, dailySentCount
        ↓
6. Postfix delivers; mail-node scans mail.log → POSTs /api/nodes/delivery-events
   → Controller updates delivery_events, send_jobs (delivered/bounced/deferred), send_log
```

### Canonical pipeline (jobs — USE_CANONICAL_QUEUE=true, Milestone 5)
```
1. Scheduler (daily batch / recurring / scheduled send)
   → checks identity daily capacity (resets dailySentCount if new day)
   → caps batch at remaining capacity
        ↓
2. Backend creates jobs rows (status=PENDING, scheduled_for=ISO timestamp or null,
   contact_id=…, send_log_id=…)
        ↓
3. Mail-node polls GET /api/jobs/poll?apiKey=…
   → Controller filters: status=PENDING, scheduled_for <= now (or null)
   → Returns job with fromAddr/fromName/domain (no state change)
        ↓
4. Mail-node POSTs /api/jobs/:id/start → status=PROCESSING (atomic)
        ↓
5. Mail-node sends via Nodemailer → Postfix → returns queueId
        ↓
6. Mail-node POSTs /api/jobs/:id/complete {queue_id}
   → jobs.status = SENT
   → CampaignResultService: send_log→sent, contact→sent, dailySentCount++
   (or /fail → jobs.status=FAILED, send_log→failed, contact→failed)
```

---

## Node Communication

Nodes authenticate every request with their `apiKey` (hex string, stored in `servers.apiKey`). No JWT involved. The controller verifies the key against the `servers` table and touches `lastSeenAt` + `status=online`.

**Job dispatch flow:**
- Nodes claim up to `limit=10` jobs per poll (capped at 50)
- Daily limit per identity is enforced: controller resets `dailySentCount=0` when `lastResetDate != today`
- Jobs with `scheduledFor > now` are withheld until their time comes

---

## Authentication

```
JWT (HS256, 7-day expiry)
  └── stored in localStorage by frontend
  └── sent as Authorization: Bearer <token>
  └── validated by requireAuth middleware in middleware/auth.js
  └── applied to all /api/* EXCEPT /api/auth/* and /api/nodes/*

apiKey (hex, 64 chars)
  └── generated with crypto.randomBytes(32).toString('hex')
  └── stored in servers.apiKey
  └── sent by nodes in request body or query string
  └── validated per-request in routes/nodes.js

Public (no auth)
  └── /api/auth/login
  └── /api/nodes/* (apiKey auth, not JWT)
  └── GET /unsubscribe
```

Passwords are hashed with bcrypt (rounds=12). `create-admin.js` is the only way to create users.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Yes | Long random string for signing JWT tokens. Generate: `openssl rand -hex 64` |
| `APP_URL` | Yes | Full public URL of the backend, e.g. `https://serawin.net`. Used in unsubscribe links. |
| `NODE_ENV` | Yes | Set to `production` to skip seed data. Any other value enables seeding. |
| `USE_CANONICAL_QUEUE` | No | `true` to route new campaign sends to the `jobs` table (canonical pipeline). Omit or set `false` to use the legacy `send_jobs` pipeline. Flip to `true` only after validating the canonical pipeline in production. |
| `UNSUBSCRIBE_REQUIRE_READY` | No | Default `true` (fail-closed): contact-bound job dispatch is withheld until the unsubscribe host passes its `/unsubscribe-health` probe. Set `false` ONLY for local dev/tests — never in production. |
| `UNSUBSCRIBE_READINESS_TTL_MS` / `_REFRESH_MS` / `_TIMEOUT_MS` | No | Unsubscribe-host probe tuning (defaults 600000 / 300000 / 4000), mirroring the `TRACKING_READINESS_*` knobs. |

File: `backend/.env` (gitignored). Copy from `.env.example`.

---

## Deployment

| Item | Value |
|------|-------|
| Provider | Vultr VPS |
| IP | 45.32.235.159 |
| OS | Ubuntu 22.04 |
| Domain | serawin.net (GoDaddy registrar, Cloudflare DNS) |
| App URL | https://serawin.net |
| Process manager | PM2 |
| Reverse proxy | Nginx (terminates SSL, proxies to port 3001) |
| SSL | Let's Encrypt |
| Backend port | 3001 |

**Cloudflare DNS records (all DNS-only, no proxy):**
| Type | Name | Value |
|------|------|-------|
| A | serawin.net | 45.32.235.159 |
| A | mail.serawin.net | 45.32.235.159 |
| MX | @ | mail.serawin.net (priority 10) |
| TXT | @ | v=spf1 ip4:45.32.235.159 ~all |
| TXT | mail._domainkey | v=DKIM1; h=sha256; k=rsa; p=... |
| TXT | _dmarc | v=DMARC1; p=none; rua=mailto:admin@serawin.net |

**Start:**
```bash
cd backend && npm install
node create-admin.js admin yourpassword   # first-time only
node index.js                             # or: pm2 start index.js --name backend
```

---

## Security Notes

- JWT secret must be a long random string (`JWT_SECRET`). Rotation invalidates all existing sessions.
- **Fail-fast on missing JWT_SECRET**: the backend calls `process.exit(1)` at startup if `JWT_SECRET` is not set, preventing the server from running unsigned. Generate with: `openssl rand -hex 64`.
- SMTP password is never returned in API responses (masked as ••••••••).
- Unsubscribe endpoint is public and does not require auth by design (linked from emails).
- Node apiKeys are 64-char hex strings. Regenerate via `POST /api/servers/:id/regenerate-key` if compromised.
- SQLite file (`data/mail.db`) contains all contacts and campaign data. Back it up. It is not in git.
- `NODE_ENV=production` must be set on the server to prevent dev seed data from running.
- The `require('os').hostname()` call in `mail-node/poller.js` uses `require()` in an ESM module — this will fail on Node without the `--experimental-require-module` flag. It only affects the `SERVER_LABEL` fallback; `SERVER_LABEL` should be set in `.env`.

---

## Coding Standards

- ESM modules everywhere (`import`/`export`, `"type": "module"`)
- `better-sqlite3` synchronous API only — no callbacks, no async DB calls
- Route handlers call `db.prepare().run/get/all()` directly for simple CRUD
- Business logic with multiple DB operations goes in `scheduler.js` or dedicated service files
- Return `{ok: true}` for successful mutations with no meaningful return value
- Return `{error: 'message'}` with appropriate HTTP status for errors
- Partial updates use `?? existingValue` to keep unchanged fields
- Transactions (`db.transaction()`) for batch inserts (contacts import)

---

## Architecture Rules

- The backend never sends email. It queues `send_jobs`. Mail-nodes send.
- Never call `sendCampaignEmail` from `mailer.js` in new code. The mail-node architecture replaces it.
- All send orchestration (picking contacts, generating timestamps, creating jobs) belongs in `scheduler.js`.
- Routes should not contain business logic beyond validation and DB calls.
- Foreign key constraints are enforced (`PRAGMA foreign_keys = ON`). Respect them — don't delete a server with identities, don't delete an identity with pending jobs.
- Contact status transitions: `pending` → `queued` (when job created) → `sent`/`failed` (after node reports result).
- The `schedule_config` and `smtp_config` tables always have exactly one row (id=1). Use upsert-style updates, never INSERT.
- `send_log` is append-only. The DELETE /api/log endpoint is for manual cleanup only.

---

## Job Lifecycle (Milestone 3)

```
POST /api/jobs  ──────────────────────────────────────┐
(JWT, admin)                                          │
                                                      ↓
                                               status = PENDING
                                               node_id = NULL

GET /api/jobs/poll?apiKey=…  ─────────────────────────┐
(read-only SELECT — no state change)                  │
                                                      ↓
                                         returns the job OR 204 No Content

POST /api/jobs/:id/start  {apiKey}  ──────────────────┐
(atomic UPDATE WHERE status='PENDING')                │
                                                      ↓
              changes=1 ──────→  status = PROCESSING  │  node_id = String(server.id)
              changes=0 ──────→  409 Conflict         │  started_at = now
                                 (re-poll next tick)  │  attempts   += 1

                                               [node does work — Postfix in M4]

POST /api/jobs/:id/complete  {apiKey}  ───────────────┐
                                                      ↓
                                               status = SENT
                                               finished_at = now

POST /api/jobs/:id/fail  {apiKey, error_message}  ────┐
                                                      ↓
                                               status = FAILED
                                               finished_at = now
                                               error_message = …
```

### Locking

Locking is implemented with **optimistic concurrency via a conditional UPDATE**:

```sql
UPDATE jobs
SET    status='PROCESSING', node_id=:nodeId, started_at=:now, attempts=attempts+1
WHERE  id=:id AND status='PENDING'
```

- `changes === 1` → this node won; proceed
- `changes === 0` → another node claimed the job first; return 409 to the caller so it re-polls

SQLite serialises concurrent writes, so only one node's UPDATE will observe `changes=1` even if multiple nodes call `/start` simultaneously.  No application-level mutexes or external queue systems are needed.

### Polling behaviour

- `GET /api/jobs/poll` is **read-only** — it never changes job state.  
- The next PENDING job is selected by `priority DESC, created_at ASC` so higher-priority jobs and older same-priority jobs are dispatched first.  
- Returns **204 No Content** (empty body) when the queue is empty — mail-nodes check for the absence of an `id` field and skip to the next tick.  
- The two-step design (poll → start) means a node crash between the two calls leaves the job PENDING, not stuck in a transitional state.

## Current Milestone

**Milestone 6 in progress: Delivery Tracking**

### Phase 1 complete: Database Schema Foundation

All schema additions are idempotent (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE` wrapped in try/catch).

**New tables:**
- `campaigns` — one row per campaign dispatch; typed nullable FKs (`scheduled_send_id → scheduled_sends`, `recurring_campaign_id → recurring_campaigns`) replace the earlier polymorphic ref_id design
- `campaign_stats` — one row per campaign; denormalized counters updated transactionally on each delivery event; permanent record surviving the 90-day event retention window

**New columns on `jobs`:**
- `campaign_id INTEGER` — FK→campaigns; links each job to its dispatch campaign
- `delivery_status TEXT DEFAULT 'SMTP_PENDING'` — Postfix/MX delivery FSM, independent of the SMTP submission `status` field

**New columns on `delivery_events`:**
- `job_id INTEGER` — FK→jobs (canonical pipeline); NULL for legacy send_jobs events
- `dedup_key TEXT UNIQUE` — `queue_id + '_' + event_type + '_' + log_time`; INSERT OR IGNORE prevents duplicate events from a restarted parser

**New indexes:**
- `idx_jobs_queue_id`, `idx_jobs_campaign_id`, `idx_jobs_delivery_status`
- `idx_delivery_events_job_id`, `idx_delivery_events_dedup` (UNIQUE)
- `idx_campaigns_type_date`, `idx_campaigns_scheduled_send_id`, `idx_campaigns_recurring_id`

No application logic was changed. All existing queries and endpoints are unaffected.

### Phase 2 complete: Event Processing Services

**New services:**
- `services/CampaignRepository.js` — DB layer for the `campaigns` table; `findOrCreateManual` groups manual sends by calendar-day + identity
- `services/CampaignStatsRepository.js` — DB layer for the `campaign_stats` table; `applyDeliveryEvent` handles all FSM counter corrections, including the `DEFERRED → DELIVERED` decrement
- `services/DeliveryEventService.js` — processes Postfix delivery event batches; supports both canonical (`jobs`) and legacy (`send_jobs`) pipelines; fully idempotent via `dedup_key`; each event runs in its own `db.transaction()`

**Modified route:**
- `routes/nodes.js` — `POST /api/nodes/delivery-events` handler replaced: the previous 40-line inline loop is now a single `processEvents(events)` call; response now includes `{ok, processed, skipped}`

**What is NOT yet wired (deferred to Phase 5+):**
- No campaign API endpoints (`GET /api/campaigns`, `GET /api/campaigns/:id`, etc.)
- No frontend

**Phase 2 verification:** 7 functional test scenarios all passed:
1. DELIVERED event → correct FSM transition, send_log, campaign_stats
2. Duplicate event (same dedup_key) → silently skipped, no counter double-count
3. Late DEFERRED after DELIVERED → recorded in delivery_events, state unchanged (FSM blocked)
4. DEFERRED → DEFERRED → DELIVERED → `total_currently_deferred` decrement correct
5. BOUNCED → `total_bounced` incremented, contact marked failed
6. Legacy send_jobs event (no canonical job) → `delivery_events.job_id=NULL`, `sendJobId` set correctly
7. `findOrCreateManual` → same day returns same row; different day returns different row

### Phase 3 complete: Pipeline Integration

**Modified files:**
- `scheduler.js` — `queueCanonicalJobForContact` now accepts `campaignId` (last param, default `null`) and persists it to `jobs.campaign_id`; now exported. All three canonical planners create a `campaigns` row and call `findOrCreateStats` before queueing jobs, then call `incrementJobs` with the actual queued count:
  - `planDaySends` (canonical): creates `type='daily_batch'` campaign before the loop
  - `planRecurringCampaigns` (canonical): creates `type='recurring'` campaign with `recurring_campaign_id` FK
  - `checkScheduledSends` (canonical): creates `type='scheduled_send'` campaign with `scheduled_send_id` FK — inside the outer `db.transaction()` so campaign + jobs creation is atomic
- `services/CampaignResultService.js` — both handlers now update `delivery_status` and campaign_stats atomically:
  - `onJobCompleted`: sets `jobs.delivery_status = 'SMTP_ACCEPTED'`; if `campaign_id` present, calls `incrementSent`
  - `onJobFailed`: sets `jobs.delivery_status = 'SEND_FAILED'`; if `campaign_id` present, calls `incrementSendFailed`
  - Both wrapped in `db.transaction()` so `delivery_status` and counter update are atomic
- `routes/send.js` — `POST /api/send` branches on `USE_CANONICAL_QUEUE`:
  - **Canonical path** (new): calls `findOrCreateManual(today, identityId)` to get/create the daily campaign, then `queueCanonicalJobForContact` for each contact with `campaign_id` set; calls `incrementJobs` after the loop. Duplicate guard checks `jobs WHERE contact_id=? AND status IN ('PENDING','PROCESSING')`.
  - **Legacy path** (unchanged): existing `send_jobs` code, byte-for-byte identical

**Counter flow (full lifecycle):**
```
job created          → campaign_stats.total_jobs++          (incrementJobs, in planner/send route)
job SMTP_ACCEPTED    → campaign_stats.total_sent++          (onJobCompleted)
job SEND_FAILED      → campaign_stats.total_send_failed++   (onJobFailed)
delivery DELIVERED   → campaign_stats.total_delivered++     (DeliveryEventService — Phase 2)
delivery BOUNCED     → campaign_stats.total_bounced++       (DeliveryEventService — Phase 2)
delivery DEFERRED    → campaign_stats.total_currently_deferred++ (first entry only — Phase 2)
delivery COMPLAINED  → campaign_stats.total_complained++    (DeliveryEventService — Phase 2)
```

**Phase 3 verification:** 9 functional test scenarios all passed — campaign_id persisted to jobs, all counter transitions correct, exclusive-arc FKs correct (scheduled_send_id and recurring_campaign_id), orphan jobs (no campaign_id) are safely handled.

### Phase 4 complete: Delivery Event Lifecycle + Campaign Completion

**Modified files:**

`services/CampaignRepository.js`:
- `markCompleted` now uses `WHERE id=? AND status='running'` guard — idempotent, second call is a safe no-op
- New `checkAndCompleteCampaign(campaignId)` (exported): checks campaign is `running`, then counts `total` vs `terminal_count` from actual `jobs` rows (not derived counters). If `total > 0 && total === terminal_count`, calls `markCompleted`. Terminal states: `DELIVERED`, `BOUNCED`, `SEND_FAILED`, `COMPLAINED`. Non-terminal: `SMTP_PENDING`, `SMTP_ACCEPTED`, `DEFERRED`.

`services/DeliveryEventService.js`:
- Added `complained → COMPLAINED` to `EVENT_TO_STATUS` (ISP feedback-loop complaints; FSM priority 4 — highest)
- Added `COMPLAINED → 'complained'` to `STATUS_TO_LOG` (prevents NULL being written to `send_log.deliveryStatus`)
- Added `TERMINAL_STATUSES` Set at module level
- `processSingleEvent` restructured: closure variables `campaignId` and `didTransition` are set inside the `db.transaction()`; after the transaction commits, if `didTransition && campaignId && TERMINAL_STATUSES.has(newDeliveryStatus)`, calls `checkAndCompleteCampaign`. The completion check runs outside the delivery-event transaction so it doesn't hold the write lock.

`services/CampaignResultService.js`:
- `onJobCompleted`: all 5 writes (send_log, contact, dailySentCount, delivery_status, campaign_stats) are now in a **single** `db.transaction()` — previously delivery_status + stats were in a separate inner transaction
- `onJobFailed`: same consolidation for all 4 writes; after the transaction commits, calls `checkAndCompleteCampaign(job.campaign_id)` — `SEND_FAILED` is terminal, so this is the trigger for campaigns that fail at SMTP submission without ever reaching Postfix delivery

**Supported event types (full set):**
| `eventType` | `delivery_status` | Priority | Terminal |
|-------------|-------------------|----------|---------|
| — (initial) | `SMTP_PENDING` | 0 | No |
| job complete | `SMTP_ACCEPTED` | 1 | No |
| `deferred` | `DEFERRED` | 2 | No |
| `sent` | `DELIVERED` | 3 | Yes |
| `bounced` | `BOUNCED` | 3 | Yes |
| job fail | `SEND_FAILED` | 3 | Yes |
| `complained` | `COMPLAINED` | 4 | Yes |

**Phase 4 verification:** 36 functional test scenarios all passed — full FSM lifecycle, deferred→delivered counter correction, bounced contact marking, complained contact unsubscribing, SEND_FAILED campaign completion, partial-campaign premature-completion prevention, FSM regression blocking, markCompleted idempotency, dedup skipping.

---

**Production Hardening complete (pre-M6)**

Five production-hardening changes applied to the existing codebase. No new features, no schema rebuilding required.

**1. SQLite transactions for all multi-write operations**
All functions that write to more than one table are now wrapped in `db.transaction(() => { ... })()`:
- `queueJobForContact()` — wraps INSERT send_log + INSERT send_jobs + UPDATE send_log + UPDATE contacts
- `queueCanonicalJobForContact()` — wraps INSERT send_log + INSERT jobs + UPDATE contacts
- `checkScheduledSends()` — each due task wraps UPDATE scheduled_sends + all contact job inserts atomically
- `POST /api/send` — the entire contact loop is a single transaction; partial writes no longer possible
Nested calls (e.g. `queueJobForContact` called inside `checkScheduledSends`'s transaction) use SQLite SAVEPOINTs automatically via better-sqlite3.

**2. Missing database indexes added (idempotent)**
Three `CREATE INDEX IF NOT EXISTS` statements added at the end of `db.js`:
- `idx_contacts_status` on `contacts(status)` — status filtering (suppression exclusion, UI counts; automated selection now dedups via `campaign_send_ledger`, not `status='pending'`)
- `idx_scheduled_sends_status_sched` on `scheduled_sends(status, scheduledAt)` — covers the per-minute `checkScheduledSends` query
- `idx_send_log_scheduledSendId` on `send_log(scheduledSendId)` — covers log lookups by scheduled send

**3. Sender identity delete guard covers canonical queue**
`DELETE /api/sender-identities/:id` previously only checked `send_jobs` for pending legacy jobs.
Now also checks `jobs` for `PENDING` or `PROCESSING` rows (`identity_id` FK). Both checks must pass before deletion proceeds.

**4. JWT_SECRET fail-fast**
`index.js` checks `process.env.JWT_SECRET` immediately after `dotenv/config` is loaded. If missing, logs `FATAL: JWT_SECRET is not set` and calls `process.exit(1)`. The server never starts without a signing secret.

**5. Startup logs**
`app.listen` callback now emits three structured startup lines before and after init:
```
[startup] Database initialized
[startup] Queue mode: Legacy | Canonical
[startup] Backend listening on http://localhost:3001
[startup] Scheduler initialized
```

**Rollback:** all changes are backward-compatible. Removing the transaction wrappers reverts to the previous behaviour. Indexes can be dropped with `DROP INDEX`. The fail-fast check can be removed. No schema changes were made to any table.

---

**Milestone 5 complete: Canonical Queue Migration**

The scheduler now routes new campaign sends to the `jobs` table when `USE_CANONICAL_QUEUE=true`. The legacy `send_jobs` pipeline remains fully operational and continues draining any existing rows. No endpoints were removed or renamed; no database rebuilding is required.

**Schema additions (idempotent ALTER TABLE on `jobs`):**
- `scheduled_for TEXT` — withholds dispatch until this UTC timestamp; NULL = immediately dispatchable. Enforced in `JobRepository.findNextPending()`.
- `contact_id INTEGER` — links to the contact whose status must be updated on completion/failure.
- `send_log_id INTEGER` — links to the send_log row whose status must be updated on completion/failure.

**New service: `CampaignResultService.js`** — side-effects for canonical job completion:
- `onJobCompleted`: marks `send_log` sent + stores queueId; marks contact sent; increments `dailySentCount`
- `onJobFailed`: marks `send_log` failed; marks contact failed

**Scheduler dual-queue support** (`scheduler.js`):
- `useCanonicalQueue()` reads `USE_CANONICAL_QUEUE` env var
- `getIdentityRemainingCapacity(identityId)` resets daily count if day rolled over, returns remaining capacity
- All three planners (`planDaySends`, `planRecurringCampaigns`, `checkScheduledSends`) branch on the flag; the legacy path is byte-for-byte identical to Milestone 4
- Daily limit enforcement moved to creation-time for the canonical path: planners cap batch size by remaining identity capacity before inserting jobs

**Migration state:** `USE_CANONICAL_QUEUE=false` (default) — legacy pipeline active. Set to `true` when ready to validate canonical pipeline in production. Legacy send_jobs rows are drained by the existing `GET /api/nodes/jobs` poller on mail-nodes.

**Rollback:** set `USE_CANONICAL_QUEUE=false`. Legacy pipeline resumes immediately. Any PENDING canonical jobs already in the `jobs` table will still be claimed and sent by `JobPollingService`; their completion will update contacts and send_log via `CampaignResultService`. No data loss either way.

**Milestone 4 complete: Real SMTP Sending via Job Queue**
- `GET /api/jobs/poll` now LEFT JOINs `sender_identities` — response includes `fromAddr`, `fromName`, `domain`
- `POST /api/jobs/:id/complete` now accepts optional `queue_id` body field; stored in `jobs.queue_id`
- `jobs.queue_id TEXT` column added (idempotent ALTER TABLE for existing DBs)
- `JobRepository.markSent(id, nodeId, queueId)` — stores Postfix queue ID on completion
- `JobService.completeJob(id, nodeId, queueId)` — threads queueId to repository layer
- Mail-node `startJobPoller()` fully active: poll → claim → `sendJob()` → complete/fail

**Milestone 3 complete: Job Queue & Polling (infrastructure)**
- New `jobs` table with full lifecycle schema (PENDING → PROCESSING → SENT/FAILED/CANCELLED)
- `JobRepository` — atomic `claimJob()` with `WHERE status='PENDING'` guard
- `JobService` — validates inputs, enforces ownership on complete/fail, surfaces meaningful error codes
- `PollingService` — read-only poll abstraction; 204 when queue is empty
- `routes/jobs.js` — `POST /api/jobs` (JWT), `GET /api/jobs/poll`, `POST /api/jobs/:id/start|complete|fail` (apiKey)
- Registered before `requireAuth` so node endpoints bypass JWT; only job creation requires a JWT

**Milestone 1 complete: Node Registration & Communication**
- Nodes register on startup with full system metadata (node_id, hostname, version, IP, OS, capabilities)
- Heartbeat every 30 s with live health metrics (cpu, ram, disk, queue_size, postfix_running, opendkim_running)
- Offline watcher marks nodes OFFLINE after 90 s of silence
- Clean service layer: NodeRepository → NodeRegistrationService + HeartbeatService → thin route handlers

**Send pipeline also complete:**
- Controller queues jobs → mail-nodes poll and send via Postfix → delivery verdicts reported back
- Daily batch, recurring campaigns, and scheduled one-off sends all route through job queue
- Server/provider/identity management UI is live
- Full delivery tracking (queued → claimed → sent → delivered/bounced/deferred)

---

## Campaign Engagement (Buttons + Click/Open Tracking)

Reusable CTA buttons, click redirects, bot/scanner classification, and open
tracking. **Central controller owns everything; mail-nodes stay stateless and
button/token/pixel-unaware.** Full spec + infra wiring: **`TRACKING.md`**.

**Tables** (`db.js`): `buttons` (reusable CTA library), `campaign_buttons` (frozen
per-campaign snapshot — the redirect resolves its destination from HERE, so editing
a button never changes an already-queued campaign), `click_events` + `open_events`
(immutable raw logs; one row per request; `classification` is analytics-only; no raw
IP stored — only a salted `ip_hash` + a `signals` JSON for reclassification),
`tracking_config` (global open-tracking toggle, default **ON**). Added columns:
`campaigns.open_tracking_override` (NULL=inherit / 0 / 1), `jobs.body_text` (compiled
plain-text alternative for button emails, surfaced to the node as `txt`).

**Open-tracking readiness gate** (`TrackingHostReadiness.js`): open tracking is ON by
default, but a pixel is injected for a domain only when `effective_intent AND
isReady(domain)`. Readiness = a background probe of `https://click.<domain>/tracking-health`
(validates DNS+TLS+nginx+endpoint) with a **local hairpin fallback** (probe
`127.0.0.1:<port>/tracking-health` with the correct `Host` header when the public
probe fails — NAT hairpin must not silently suppress pixels). `isReady()` is
sync/cache-only (safe on the send path); never probes in the `/c` or `/o` request
path. The periodic watcher **skips probing while open tracking is globally off and
no campaign overrides it on**; admin re-check always probes. Not-ready ⇒ email
sends clean with no pixel (logged once per campaign/domain; shown in the Campaigns
UI via `GET/POST /api/engagement/tracking-readiness`). Watcher started in `index.js`.

**Services**: `trackingToken.js` (HMAC-signed opaque click/open tokens, dedicated
`TRACKING_SECRET`, no PII/destination in token, `hashIp` via `TRACKING_IP_SALT`),
`trackingClassifier.js` (pure — clicks → `human|scanner|unknown`; opens →
`open|prefetch`, deliberately NO "human open" claim: Gmail proxies+caches images
and Apple MPP pre-fetches, so proxy-UA/datacenter-IP signals are NOT used for
opens), `trackingScanners.js` (static CIDR/UA lists — no network calls),
`BodyCompiler.js` (pure: expand `{{button:ID}}` → email-safe table button /
`TEXT: url`; inject 1×1 pixel), `ButtonRepository.js`, `CampaignButtonRepository.js`
(snapshot + hard-fail on missing/inactive), `CampaignBodyCompiler.js` (queue-time
glue), `EngagementRepository.js` (report aggregation), `TrackingConfigRepository.js`,
`EventRetention.js` (daily purge of raw click/open events after
`TRACKING_EVENT_RETENTION_DAYS`, default 90 — mirrors delivery_events convention).

**Abuse/trust hardening**: `index.js` sets Express `trust proxy` (default
`loopback`, override `TRUST_PROXY`) so `req.ip` is the nginx-appended hop — a
client-supplied X-Forwarded-For cannot spoof `ip_hash`/classification. `/c`+`/o`
collapse near-instant same-client duplicates (`TRACKING_DEDUP_WINDOW_SECONDS`,
default 2s — legitimate spaced repeat clicks still record; NOT single-use) and a
burst signal (`TRACKING_BURST_WINDOW_SECONDS`, default 5s: same recipient fetching
a different button of the same email ⇒ scanner).

**Routes**: public `routes/track.js` — `GET /c/:token` (single 302 to the frozen
destination for ALL classifications — no cloaking; `no-store` + `no-referrer`;
invalid token → 404) and `GET /o/:file` (1×1 gif always; records only on valid
token). Mounted **before** `app.use('/api', requireAuth)`. Authed: `routes/buttons.js`
(`/api/buttons` CRUD + `/:id/preview`), `routes/engagement.js` (`/api/engagement/config`,
`/campaigns`, `/campaigns/:id/report`, `/campaigns/:id/open-tracking`). `GET
/api/engagement/campaigns` (`EngagementRepository.listCampaigns`) returns each
campaign with `unique_opens` / `unique_clicks` (COUNT DISTINCT contact_id over
open_events / click_events) so the Campaigns UI shows unique open/click counts per
campaign and rolls them up per name-group. The report view still exposes the full
raw/human/prefetch breakdown via `campaignSummary()`.

**Transformation point**: queue time only, inside `scheduler.js:queueCanonicalJobForContact`
(via `CampaignBodyCompiler`). No-button + open-off templates are byte-identical to before.
**Canonical queue is required**; a tracked-button template on the legacy pipeline
**fails clearly** (never a silent untracked link). **No external calls in the
redirect/pixel path.** Env: `TRACKING_SUBDOMAIN`, `TRACKING_SECRET`, `TRACKING_IP_SALT`,
`TRACKING_FAST_THRESHOLD_SECONDS`, `TRACKING_DEDUP_WINDOW_SECONDS`,
`TRACKING_BURST_WINDOW_SECONDS`, `TRACKING_EVENT_RETENTION_DAYS`, `TRUST_PROXY`.
Tests: `tracking.test.js`, `tracking-integration.test.js`, `tracking-hardening.test.js`
(XFF trust, dedup, burst, HEAD, secondsSinceSend, readiness fallback, retention,
legacy hard-fail); node-side MIME verification lives in mail-node `tracking-mime.test.js`.

**mail-node impact: none** — tracking terminates at the controller under
`click.<sending-domain>` (reverse-proxied), exactly like `unsubscribe.<domain>`.

## Roadmap

- Job retry logic for deferred/failed jobs
- Per-identity warmup automation (auto-increment dailyLimit per week)
- Delivery analytics dashboard (open rates, bounce rates, category breakdowns)
- Multiple user accounts with role permissions
- API key rotation UI

---

## Known Limitations

- `mailer.js::sendCampaignEmail` is dead code (architecture moved to mail-nodes). It remains in the file for potential dev/test fallback but is never called.
- `GET /api/auth/me` now applies `requireAuth` directly on the route handler (`router.get('/me', requireAuth, ...)`). This was fixed because the route is registered under `/api/auth` which is mounted before the global `app.use('/api', requireAuth)`, meaning the middleware was never reached for auth routes.
- Legacy JSON files in `data/` (`contacts.json`, `schedule.json`, `sendLog.json`) are unused. Safe to delete.
- The root-level `README.md` in `mail-campaign-manager/` is outdated (references JSON-based architecture). Ignore it.
- `setup-mail-server.sh` in the backend folder was for configuring Postfix on the controller itself. This pattern was replaced by the mail-node architecture. The file is kept for reference.

---

## AI Agent Rules

- **Read this file first** before starting any work on the backend.
- **Never duplicate existing logic.** Check db.js for existing tables and routes/ for existing endpoints before adding new ones.
- **Never rewrite working code without a stated reason.** Refactoring for its own sake is not a task.
- **Business logic belongs in scheduler.js or dedicated service files**, not in route handlers.
- **The backend does not send email.** Sending always goes through send_jobs → mail-node. Do not add direct Nodemailer calls to routes.
- **Maintain backward compatibility** for `/api/nodes/*` endpoints. Changing the node API breaks deployed mail-nodes.
- **Keep code production-ready.** No console.log in routes, no hardcoded secrets, no test-only code without `NODE_ENV` guards.
- **Synchronous SQLite only.** Never add async DB calls or switch to a different DB driver.
- **Update this AGENTS.md** whenever you add routes, tables, services, or change architecture. Documentation is part of the implementation.
- **Never finish a task while AGENTS.md is outdated.**
- If a new table is added: document it in the Database section.
- If a new route is added: document it in the API section.
- If a new environment variable is added: document it in the Environment Variables section.
- If deployment changes: update the Deployment section.
