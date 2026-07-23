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
- **Job queue pattern**: the controller writes `send_jobs` rows; nodes poll and consume them
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
| POST | `/api/nodes/delivery-events` | `{apiKey, events[]}`. Reports Postfix log verdicts. Updates delivery_events, send_jobs, send_log. |

### Job Queue API (Milestone 3 — infrastructure live, node-side pending Milestone 4)
Routes are registered and functional. The mail-node does not actively poll these endpoints yet
(`startJobPoller` is disabled in `poller.js` until Milestone 4 wires actual Postfix sending).

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/api/jobs` | JWT | `{identity_id?, recipient, subject, body?, priority?}`. Creates a PENDING job. Returns the created job. |
| GET | `/api/jobs/poll` | apiKey | `?apiKey=`. Read-only peek at the next PENDING job (highest priority, oldest first). Returns the job or **204 No Content** if queue is empty. Does NOT claim the job. |
| POST | `/api/jobs/:id/start` | apiKey | `{apiKey}`. Atomically claims the job: PENDING → PROCESSING. Returns 409 if another node already claimed it. |
| POST | `/api/jobs/:id/complete` | apiKey | `{apiKey}`. Marks PROCESSING → SENT. Only the owning node may call this. |
| POST | `/api/jobs/:id/fail` | apiKey | `{apiKey, error_message?}`. Marks PROCESSING → FAILED. Only the owning node may call this. |

### Public
| Method | Path | Notes |
|--------|------|-------|
| GET | `/unsubscribe?email=x` | Sets contact status=unsubscribed. Returns HTML confirmation page. |

---

## Database

All tables are created in `db.js` on startup via `CREATE TABLE IF NOT EXISTS`. Schema upgrades use `ALTER TABLE ... ADD COLUMN` wrapped in try/catch (idempotent).

```sql
jobs (
  id            INTEGER PK,
  status        TEXT DEFAULT 'PENDING',   -- PENDING | PROCESSING | SENT | FAILED | CANCELLED
  node_id       TEXT,                     -- String(server.id) of the claiming node; NULL until claimed
  identity_id   INTEGER FK→sender_identities (nullable),
  recipient     TEXT NOT NULL,            -- destination email address
  subject       TEXT NOT NULL,
  body          TEXT DEFAULT '',
  priority      INTEGER DEFAULT 0,        -- higher = dispatched first
  attempts      INTEGER DEFAULT 0,        -- incremented each time a node claims the job
  created_at    TEXT NOT NULL,
  started_at    TEXT,                     -- set when first claimed
  finished_at   TEXT,                     -- set on SENT or FAILED
  error_message TEXT                      -- set on FAILED
)
-- Indexes: (status, priority DESC, created_at ASC) for O(1) poll; node_id for node queries

contacts (
  id INTEGER PK, firstName TEXT, lastName TEXT,
  email TEXT UNIQUE, status TEXT DEFAULT 'pending', sentAt TEXT
)
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
  id INTEGER PK, sendJobId INTEGER, queueId TEXT, email TEXT,
  eventType TEXT, dsnCode TEXT, relay TEXT, response TEXT,
  reasonCategory TEXT, reasonDetail TEXT, logTime TEXT, createdAt TEXT
)
-- Indexes: queueId, sendJobId

send_log (
  id INTEGER PK, date TEXT, contactId INTEGER, name TEXT, email TEXT,
  template TEXT, status TEXT, previewUrl TEXT, error TEXT,
  scheduledSendId INTEGER, subject TEXT, body TEXT,
  sendJobId INTEGER, senderIdentityId INTEGER, queueId TEXT,
  deliveryStatus TEXT, dsnCode TEXT, remoteMx TEXT, remoteResponse TEXT,
  reasonCategory TEXT, reasonDetail TEXT, deliveredAt TEXT, lastEventAt TEXT
)
```

---

## Services

### JobRepository.js — DB Layer for Jobs
All SQLite queries for the `jobs` table. Six functions:
- `create(fields)` — inserts a PENDING job; returns the created row
- `findById(id)` — returns a single job by primary key
- `findNextPending()` — `SELECT … WHERE status='PENDING' ORDER BY priority DESC, created_at ASC LIMIT 1`; returns null if queue is empty
- `claimJob(id, nodeId)` — `UPDATE … WHERE id=? AND status='PENDING'`; returns `true` if `changes===1` (won the race), `false` otherwise
- `markSent(id, nodeId)` — `UPDATE … WHERE id=? AND status='PROCESSING' AND node_id=?`; returns `true` on success
- `markFailed(id, nodeId, errorMessage)` — same guard as markSent; sets error_message
- `markCancelled(id)` — cancels PENDING or PROCESSING jobs

### JobService.js — Job Lifecycle Logic
Validates inputs and orchestrates state transitions via JobRepository:
- `createJob(fields)` — validates recipient/subject, delegates to create
- `startJob(id, nodeId)` — checks job exists and is PENDING, then calls claimJob; returns `{ok, job}` or `{error, status}`
- `completeJob(id, nodeId)` — checks ownership and PROCESSING status, calls markSent
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

### scheduler.js — Job Planner
Does NOT send email. Creates `send_jobs` rows for mail-nodes to pick up.

**`planDaySends()`** — called on startup + every midnight UTC:
1. Reads `schedule_config` (must be enabled, batchSize > 0)
2. Generates `batchSize` random ISO timestamps within the `startTime`–`endTime` UTC window for today
3. Inserts one `send_jobs` row per contact (status=queued, scheduledFor=random time)
4. Sets contact status to `queued`

**`planRecurringCampaigns()`** — called on startup + every midnight UTC:
1. For each `active` recurring campaign where `lastRunDate != today`:
2. Computes today's count: `round(initialCount × (1 + increasePercent/100)^currentDay)`
3. Generates that many random times in the campaign's window
4. Creates `send_jobs` rows for the next N pending contacts
5. Updates `lastRunDate` and increments `currentDay`
6. Marks campaign `completed` when no pending contacts remain

**`checkScheduledSends()`** — called every minute by cron:
1. Finds `scheduled_sends` where `status='pending' AND scheduledAt <= now`
2. Marks them `sent`
3. Creates `send_jobs` rows for their contactIds (these have no `scheduledFor`, so nodes can pick them up immediately)

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

```
1. User action (UI send, scheduled send due, daily batch, recurring campaign)
        ↓
2. Backend creates send_jobs rows (status=queued, scheduledFor=ISO timestamp or null)
        ↓
3. Mail-node polls GET /api/nodes/jobs?apiKey=…&limit=10
   → Controller filters: status=queued, scheduledFor <= now, within dailyLimit
   → Controller marks jobs claimed
        ↓
4. Mail-node sends each job via Nodemailer → localhost:25 (Postfix)
   → Postfix routes to correct source IP per sender domain
   → OpenDKIM milter signs the message
   → Postfix returns "250 Ok: queued as <QUEUEID>"
        ↓
5. Mail-node POSTs /api/nodes/results with {jobId, status, queueId, ...}
   → Controller updates send_jobs, send_log, contacts
        ↓
6. Postfix delivers to remote MX; logs verdict to /var/log/mail.log
        ↓
7. Mail-node scans mail.log incrementally, parses delivery lines
   → Mail-node POSTs /api/nodes/delivery-events with {queueId, eventType, dsnCode, ...}
   → Controller updates delivery_events, send_jobs (status=delivered/bounced/deferred), send_log
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

**Milestone 3 complete: Job Queue & Polling (infrastructure only)**
- New `jobs` table with full lifecycle schema (PENDING → PROCESSING → SENT/FAILED/CANCELLED)
- `JobRepository` — atomic `claimJob()` with `WHERE status='PENDING'` guard
- `JobService` — validates inputs, enforces ownership on complete/fail, surfaces meaningful error codes
- `PollingService` — read-only poll abstraction; 204 when queue is empty
- `routes/jobs.js` — `POST /api/jobs` (JWT), `GET /api/jobs/poll`, `POST /api/jobs/:id/start|complete|fail` (apiKey)
- Registered before `requireAuth` so node endpoints bypass JWT; only job creation requires a JWT
- Mail-node: `services/JobPollingService.js` exists but `startJobPoller()` is intentionally NOT called
  from `startPoller()` — the process step is a stub (no Postfix). Will be activated in Milestone 4.

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
