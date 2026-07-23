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
    contacts.js             # CRUD /api/contacts + POST /api/contacts/import (CSV)
    templates.js            # CRUD /api/templates/:name
    send.js                 # POST /api/send (queue jobs), GET /api/send/jobs (queue overview)
    schedule.js             # GET/POST /api/schedule (daily batch config)
    scheduled-sends.js      # CRUD /api/scheduled-sends
    recurring-campaigns.js  # CRUD /api/recurring-campaigns + pause/resume
    log.js                  # GET/DELETE /api/log (send history)
    smtp.js                 # GET/PUT /api/smtp + POST /api/smtp/test
    providers.js            # CRUD /api/providers
    servers.js              # CRUD /api/servers + POST /:id/regenerate-key
    sender-identities.js    # CRUD /api/sender-identities + pause/resume
    nodes.js                # Node API thin handlers: delegates register/heartbeat to services
  services/
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
```

---

## API

All routes except `/api/auth/*`, `/api/nodes/*`, and `/unsubscribe` require a valid JWT.

### Auth
| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/api/auth/login` | `{username, password}` | `{token, username}` |
| GET | `/api/auth/me` | — | `{username}` |

### Contacts
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/contacts` | All contacts ordered by id |
| POST | `/api/contacts` | `{firstName, lastName, email, status?}` |
| PUT | `/api/contacts/:id` | Partial update (any field) |
| DELETE | `/api/contacts/:id` | — |
| POST | `/api/contacts/import` | Multipart `file` field, CSV (firstName/lastName/email). Accepts alternate column names: first_name, firstname, Email, EMAIL. Skips duplicates. Returns `{imported, skipped}` |

### Templates
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/templates` | Returns array of name strings only |
| GET | `/api/templates/:name` | Full template object `{name, subject, html, txt}` |
| POST | `/api/templates` | `{name, subject, html?, txt?}` |
| PUT | `/api/templates/:name` | `{subject?, html?, txt?}` (partial) |
| DELETE | `/api/templates/:name` | — |

### Send
| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/send` | `{contactIds[], templateName?, subject?, html?, txt?, senderIdentityId?}`. Creates `send_jobs` rows (status=queued). Returns `{results[], noIdentity}` |
| GET | `/api/send/jobs` | Queue overview with `?status=&limit=` filters. Joins identities, servers, providers. |

### Schedule (daily batch)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/schedule` | Returns `schedule_config` row |
| POST | `/api/schedule` | `{startTime?, endTime?, batchSize?, template?, enabled?}`. Immediately calls planDaySends() |

### Scheduled Sends (one-off sends at a future datetime)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/scheduled-sends` | All, ordered by scheduledAt ASC. Includes `lastSendLogId` |
| GET | `/api/scheduled-sends/:id` | Single with `logs[]` and `contacts[]` |
| POST | `/api/scheduled-sends` | `{contactIds[], scheduledAt, templateName? or subject+html+txt, label?}` |
| PUT | `/api/scheduled-sends/:id` | Only pending rows. `{label?, scheduledAt?, templateName?, subject?, html?, txt?}` |
| DELETE | `/api/scheduled-sends/:id` | — |

### Recurring Campaigns (day-over-day warmup sends)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/recurring-campaigns` | All, ordered by createdAt DESC |
| POST | `/api/recurring-campaigns` | `{name, templateName? or subject+html+txt, startTime, endTime, initialCount, increasePercent}` |
| PUT | `/api/recurring-campaigns/:id` | Update config fields |
| POST | `/api/recurring-campaigns/:id/pause` | Sets status=paused |
| POST | `/api/recurring-campaigns/:id/resume` | Sets status=active |
| DELETE | `/api/recurring-campaigns/:id` | — |

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
| GET/POST/PUT/DELETE | `/api/sender-identities` | CRUD. GET accepts `?serverId=` filter |
| POST | `/api/sender-identities/:id/pause` | Sets status=paused |
| POST | `/api/sender-identities/:id/resume` | Sets status=active |

### Node API (apiKey authenticated, no JWT)
| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/nodes/register` | `{apiKey, node_id, hostname, version, ip, public_ip, os, uptime, capabilities[]}`. Stores full system info, sets status=online. Returns `{ok, serverId, identities[]}`. |
| POST | `/api/nodes/heartbeat` | `{apiKey, uptime, cpu, ram, disk, queue_size, postfix_running, opendkim_running}`. Stores health JSON in `servers.health`, sets status=online. If no heartbeat for 90 s, offline watcher sets status=offline. |
| GET | `/api/nodes/jobs` | `?apiKey=&limit=10`. Returns due queued jobs for this server's identities. Marks them claimed. Resets daily counts at day rollover. |
| POST | `/api/nodes/results` | `{apiKey, results[]}`. Reports send outcomes. Updates send_jobs, send_log, contacts. |
| POST | `/api/nodes/delivery-events` | `{apiKey, events[]}`. Delegates to `DeliveryEventService.processEvents`. Updates `delivery_events` (INSERT OR IGNORE), applies FSM transitions on `jobs.delivery_status`, updates `send_jobs`+`send_log` (both pipelines), updates `campaign_stats` counters, and marks contacts failed/unsubscribed. Returns `{ok, processed, skipped}`. |

### Job Queue API (Milestone 4 — fully active; Milestone 5: side-effects added)
| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/api/jobs` | JWT | `{identity_id?, recipient, subject, body?, priority?}`. Creates a PENDING job. Returns the created job. `identity_id` must reference a `sender_identities` row with a populated `fromAddr` or the node will FAIL the job at send time. |
| GET | `/api/jobs/poll` | apiKey | `?apiKey=`. Read-only peek at the next PENDING job (highest priority, oldest first). Filters by `scheduled_for <= now` (withholds future-scheduled campaign jobs). Response includes `fromAddr`, `fromName`, `domain` from `sender_identities`. Returns the job or **204 No Content** if queue is empty. Does NOT claim the job. |
| POST | `/api/jobs/:id/start` | apiKey | `{apiKey}`. Atomically claims the job: PENDING → PROCESSING. Returns 409 if another node already claimed it. |
| POST | `/api/jobs/:id/complete` | apiKey | `{apiKey, queue_id?}`. Marks PROCESSING → SENT. **Milestone 5**: also calls `CampaignResultService.onJobCompleted` — updates `send_log` status, marks contact `sent`, increments `dailySentCount`. Only the owning node may call this. |
| POST | `/api/jobs/:id/fail` | apiKey | `{apiKey, error_message?}`. Marks PROCESSING → FAILED. **Milestone 5**: also calls `CampaignResultService.onJobFailed` — marks `send_log` failed, marks contact `failed`. Only the owning node may call this. |

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
  body            TEXT DEFAULT '',               -- HTML email body; TXT falls back to body on the node
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
  name TEXT PK, subject TEXT, html TEXT, txt TEXT
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
  scheduledAt TEXT, status TEXT DEFAULT 'pending', createdAt TEXT, sentAt TEXT
)
-- Index: (status, scheduledAt) for O(1) per-minute check in checkScheduledSends()

recurring_campaigns (
  id INTEGER PK, name TEXT, templateName TEXT,
  subject TEXT, html TEXT, txt TEXT,
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
  lastResetDate TEXT, status TEXT DEFAULT 'active', createdAt TEXT
)

send_jobs (
  id INTEGER PK, senderIdentityId INTEGER FK→sender_identities,
  contactId INTEGER, email TEXT, firstName TEXT, lastName TEXT,
  templateName TEXT, subject TEXT, html TEXT, txt TEXT,
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
```

---

## Services

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

**Event fields**: `queueId`, `eventType` (`'sent'`|`'bounced'`|`'deferred'`), and optionally `dsnCode`, `relay`, `response`, `reasonCategory`, `reasonDetail`, `logTime`, `email`.

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

### scheduler.js — Job Planner (Milestone 5: dual-queue; Milestone 6: campaign integration)
Does NOT send email. Creates job queue rows for mail-nodes to pick up.

**Feature flag**: reads `USE_CANONICAL_QUEUE` from env at call time. When `true`, all three planner functions write to the `jobs` table (canonical pipeline). When `false` or unset, they write to `send_jobs` (legacy pipeline). The legacy pipeline drains existing rows normally regardless of the flag.

**Daily limit enforcement (canonical path only)**: `getIdentityRemainingCapacity(identityId)` resets `dailySentCount` if the calendar day changed, then returns `max(0, dailyLimit - dailySentCount)`. Planners cap their batch at this capacity before fetching contacts — the queue only holds dispatchable jobs.

**`queueCanonicalJobForContact(contact, templateName, templateContent, scheduledFor?, scheduledSendId?, senderIdentityId?, campaignId?)`** — **exported**. Creates a `send_log` row + `jobs` row atomically (own `db.transaction()`). Sets `campaign_id` on the job. Callers pass `campaignId` from the campaign row created before the loop.

**`planDaySends()`** — called on startup + every midnight UTC:
- **Canonical**: picks active identity, caps count by remaining capacity, generates random timestamps in window; creates a `type='daily_batch'` campaign row, then calls `queueCanonicalJobForContact` for each contact with `campaign_id` set; calls `incrementJobs` after the loop
- **Legacy**: unchanged — generates random timestamps, creates `send_jobs` rows

**`planRecurringCampaigns()`** — called on startup + every midnight UTC:
- For each `active` recurring campaign where `lastRunDate != today`:
- Computes today's count: `round(initialCount × (1 + increasePercent/100)^currentDay)`
- **Canonical**: caps count by remaining capacity; creates a `type='recurring'` campaign row with `recurring_campaign_id` FK set; calls `queueCanonicalJobForContact` for each contact; calls `incrementJobs`
- **Legacy**: unchanged — creates `send_jobs` rows
- Updates `lastRunDate` and increments `currentDay`; marks `completed` when no pending contacts remain

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

**What is NOT yet wired (deferred to Phase 4+):**
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
- `idx_contacts_status` on `contacts(status)` — used by all scheduler queries that filter pending contacts
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
