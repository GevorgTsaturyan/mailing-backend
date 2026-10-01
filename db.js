import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DB_PATH lets tests point at an isolated/in-memory database (':memory:').
// Production leaves it unset and uses the on-disk data/mail.db as before.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'mail.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    firstName TEXT NOT NULL,
    lastName  TEXT NOT NULL,
    email     TEXT NOT NULL UNIQUE,
    status    TEXT NOT NULL DEFAULT 'pending',
    sentAt    TEXT
  );

  CREATE TABLE IF NOT EXISTS templates (
    name      TEXT PRIMARY KEY,
    subject   TEXT NOT NULL DEFAULT '',
    html      TEXT NOT NULL DEFAULT '',
    txt       TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS send_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL,
    contactId   INTEGER,
    name        TEXT,
    email       TEXT,
    template    TEXT,
    status      TEXT,
    previewUrl  TEXT,
    error       TEXT
  );

  CREATE TABLE IF NOT EXISTS schedule_config (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    enabled   INTEGER NOT NULL DEFAULT 0,
    time      TEXT NOT NULL DEFAULT '09:00',
    batchSize INTEGER NOT NULL DEFAULT 10,
    template  TEXT NOT NULL DEFAULT 'welcome'
  );

  CREATE TABLE IF NOT EXISTS smtp_config (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    host     TEXT NOT NULL DEFAULT '',
    port     INTEGER NOT NULL DEFAULT 587,
    secure   INTEGER NOT NULL DEFAULT 0,
    user     TEXT NOT NULL DEFAULT '',
    pass     TEXT NOT NULL DEFAULT '',
    fromName TEXT NOT NULL DEFAULT 'Mail Campaign',
    fromAddr TEXT NOT NULL DEFAULT 'noreply@example.com'
  );

  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL
  );

  INSERT OR IGNORE INTO schedule_config (id, enabled, time, batchSize, template)
    VALUES (1, 0, '09:00', 10, 'welcome');

  INSERT OR IGNORE INTO smtp_config (id)
    VALUES (1);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS recurring_campaigns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    templateName    TEXT,
    subject         TEXT,
    html            TEXT,
    txt             TEXT,
    startTime       TEXT NOT NULL DEFAULT '09:00',
    endTime         TEXT NOT NULL DEFAULT '17:00',
    initialCount    INTEGER NOT NULL DEFAULT 10,
    increasePercent REAL NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'active',
    currentDay      INTEGER NOT NULL DEFAULT 0,
    lastRunDate     TEXT,
    createdAt       TEXT NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS scheduled_sends (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    label        TEXT,
    contactIds   TEXT NOT NULL,
    templateName TEXT,
    subject      TEXT,
    html         TEXT,
    txt          TEXT,
    scheduledAt  TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    createdAt    TEXT NOT NULL,
    sentAt       TEXT
  );
`);

// Add startTime / endTime columns if upgrading from older schema
try { db.exec("ALTER TABLE schedule_config ADD COLUMN startTime TEXT NOT NULL DEFAULT '09:00'") } catch {}
try { db.exec("ALTER TABLE schedule_config ADD COLUMN endTime   TEXT NOT NULL DEFAULT '17:00'") } catch {}

// Track which scheduled send produced each log entry
try { db.exec("ALTER TABLE send_log ADD COLUMN scheduledSendId INTEGER") } catch {}

// Store the rendered email content for the View button in the log
try { db.exec("ALTER TABLE send_log ADD COLUMN subject TEXT") } catch {}
try { db.exec("ALTER TABLE send_log ADD COLUMN body    TEXT") } catch {}

// ─── Infrastructure: providers → servers → sender identities ─────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS providers (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL UNIQUE,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS servers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    providerId INTEGER,
    label      TEXT NOT NULL,
    mainIp     TEXT NOT NULL DEFAULT '',
    apiKey     TEXT NOT NULL UNIQUE,
    status     TEXT NOT NULL DEFAULT 'offline',
    lastSeenAt TEXT,
    createdAt  TEXT NOT NULL,
    FOREIGN KEY (providerId) REFERENCES providers(id)
  );

  CREATE TABLE IF NOT EXISTS sender_identities (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    serverId       INTEGER NOT NULL,
    domain         TEXT NOT NULL,
    ip             TEXT NOT NULL,
    fromName       TEXT NOT NULL DEFAULT '',
    fromAddr       TEXT NOT NULL DEFAULT '',
    dkimSelector   TEXT NOT NULL DEFAULT 'mail',
    dailyLimit     INTEGER NOT NULL DEFAULT 50,
    warmupStage    INTEGER NOT NULL DEFAULT 1,
    dailySentCount INTEGER NOT NULL DEFAULT 0,
    lastResetDate  TEXT,
    status         TEXT NOT NULL DEFAULT 'active',
    createdAt      TEXT NOT NULL,
    FOREIGN KEY (serverId) REFERENCES servers(id)
  );
`);

// ─── Send jobs: the work queue nodes pull from ────────────────────────────────
// Each send request from the controller becomes rows in this table.
// Nodes poll GET /api/nodes/jobs, claim rows, send via their local Postfix,
// then POST /api/nodes/results to report back.

db.exec(`
  CREATE TABLE IF NOT EXISTS send_jobs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    senderIdentityId INTEGER,
    contactId        INTEGER,
    email            TEXT NOT NULL,
    firstName        TEXT NOT NULL DEFAULT '',
    lastName         TEXT NOT NULL DEFAULT '',
    templateName     TEXT,
    subject          TEXT,
    html             TEXT,
    txt              TEXT,
    status           TEXT NOT NULL DEFAULT 'queued',
    scheduledFor     TEXT,
    queueId          TEXT,
    dsnCode          TEXT,
    relay            TEXT,
    remoteResponse   TEXT,
    reasonCategory   TEXT,
    reasonDetail     TEXT,
    claimedAt        TEXT,
    sentAt           TEXT,
    deliveredAt      TEXT,
    sendLogId        INTEGER,
    scheduledSendId  INTEGER,
    createdAt        TEXT NOT NULL,
    FOREIGN KEY (senderIdentityId) REFERENCES sender_identities(id)
  );
  CREATE INDEX IF NOT EXISTS idx_send_jobs_status        ON send_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_send_jobs_identityId    ON send_jobs(senderIdentityId);
  CREATE INDEX IF NOT EXISTS idx_send_jobs_scheduledFor  ON send_jobs(scheduledFor);
  CREATE INDEX IF NOT EXISTS idx_send_jobs_queueId       ON send_jobs(queueId);
`);

// ─── Delivery events: full timeline per message ───────────────────────────────
// Postfix can defer a message several times before final delivery or bounce.
// Each event the node parses from mail.log gets stored here.

db.exec(`
  CREATE TABLE IF NOT EXISTS delivery_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    sendJobId      INTEGER,
    queueId        TEXT,
    email          TEXT,
    eventType      TEXT,
    dsnCode        TEXT,
    relay          TEXT,
    response       TEXT,
    reasonCategory TEXT,
    reasonDetail   TEXT,
    logTime        TEXT,
    createdAt      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_delivery_events_queueId   ON delivery_events(queueId);
  CREATE INDEX IF NOT EXISTS idx_delivery_events_sendJobId ON delivery_events(sendJobId);
`);

// Link send_log rows to their job
try { db.exec("ALTER TABLE send_log ADD COLUMN sendJobId        INTEGER") } catch {}
try { db.exec("ALTER TABLE send_log ADD COLUMN senderIdentityId INTEGER") } catch {}
try { db.exec("ALTER TABLE send_log ADD COLUMN queueId          TEXT")    } catch {}
try { db.exec("ALTER TABLE send_log ADD COLUMN deliveryStatus   TEXT")    } catch {}
try { db.exec("ALTER TABLE send_log ADD COLUMN dsnCode          TEXT")    } catch {}
try { db.exec("ALTER TABLE send_log ADD COLUMN remoteMx         TEXT")    } catch {}
try { db.exec("ALTER TABLE send_log ADD COLUMN remoteResponse   TEXT")    } catch {}
try { db.exec("ALTER TABLE send_log ADD COLUMN reasonCategory   TEXT")    } catch {}
try { db.exec("ALTER TABLE send_log ADD COLUMN reasonDetail     TEXT")    } catch {}
try { db.exec("ALTER TABLE send_log ADD COLUMN deliveredAt      TEXT")    } catch {}
try { db.exec("ALTER TABLE send_log ADD COLUMN lastEventAt      TEXT")    } catch {}

// ─── Automated provisioning ───────────────────────────────────────────────────
// provisioningStatus: tracks the UI-triggered provisioning workflow independently
// from verificationStatus (which is node-proven).
// Values: 'unprovisioned' | 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'FAILED'
try { db.exec("ALTER TABLE sender_identities ADD COLUMN provisioningStatus TEXT NOT NULL DEFAULT 'unprovisioned'") } catch {}

// provisioningPhases: JSON blob with granular per-step status for the UI pipeline.
// Structure: { mailNode, cloudflare, nginx, ptr, verification, updatedAt }
// Each sub-object has { status, phases:{...}, message? }.
try { db.exec("ALTER TABLE sender_identities ADD COLUMN provisioningPhases TEXT") } catch {}

// nextReverifyAt: ISO timestamp — the retry service skips identities until after
// this time to avoid hammering DNS before propagation has a chance to complete.
try { db.exec("ALTER TABLE sender_identities ADD COLUMN nextReverifyAt TEXT") } catch {}

// dkimPublicKey: the RSA public key returned by the mail-node after keygen.
// Stored so the retry service can create the CF DKIM TXT record on re-run even
// if the initial attempt happened before CF_API_TOKEN was configured.
// Only the PUBLIC key is stored here — the private key never leaves the mail-node.
try { db.exec("ALTER TABLE sender_identities ADD COLUMN dkimPublicKey TEXT") } catch {}

// provisioning_tasks: one row per UI-triggered provision request.
// The mail-node polls GET /api/nodes/provisioning-task, claims a PENDING task,
// runs DKIM keygen + Postfix + OpenDKIM config, then posts the result.
// taskType: 'provision' (full local config + verify) | 'reverify' (verify only,
//   skip local config — used by ProvisioningRetryService after DNS propagates)
db.exec(`
  CREATE TABLE IF NOT EXISTS provisioning_tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    identityId  INTEGER NOT NULL REFERENCES sender_identities(id),
    serverId    INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'PENDING',
    taskType    TEXT NOT NULL DEFAULT 'provision',
    requestedAt TEXT NOT NULL,
    claimedAt   TEXT,
    completedAt TEXT,
    phases      TEXT,
    error       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_provisioning_tasks_server_status
    ON provisioning_tasks(serverId, status, requestedAt);
`);

// ─── OpenDKIM runtime health (from heartbeat) ─────────────────────────────────
// 1 = signer healthy (service active + milter socket reachable), 0 = down,
// NULL = unknown (older node / no heartbeat yet). Dispatch is withheld only when
// explicitly 0 — the Postfix `milter_default_action=tempfail` is the final local
// guarantee, so unknown stays permissive to avoid needless stalls.
try { db.exec("ALTER TABLE servers ADD COLUMN openDkimHealthy INTEGER") } catch {}

// ─── Node registration metadata (Milestone 1) ─────────────────────────────────
try { db.exec("ALTER TABLE servers ADD COLUMN node_id      TEXT") } catch {}
try { db.exec("ALTER TABLE servers ADD COLUMN hostname     TEXT") } catch {}
try { db.exec("ALTER TABLE servers ADD COLUMN version      TEXT") } catch {}
try { db.exec("ALTER TABLE servers ADD COLUMN public_ip    TEXT") } catch {}
try { db.exec("ALTER TABLE servers ADD COLUMN os_info      TEXT") } catch {}
try { db.exec("ALTER TABLE servers ADD COLUMN capabilities TEXT") } catch {}
try { db.exec("ALTER TABLE servers ADD COLUMN health       TEXT") } catch {}

// ─── Job queue (Milestone 3) ─────────────────────────────────────────────────
// Clean job entity with explicit lifecycle statuses.
// Nodes poll GET /api/jobs/poll, claim via POST /api/jobs/:id/start (atomic),
// then report via /complete or /fail.

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    status        TEXT    NOT NULL DEFAULT 'PENDING',
    node_id       TEXT,
    identity_id   INTEGER REFERENCES sender_identities(id),
    recipient     TEXT    NOT NULL,
    subject       TEXT    NOT NULL,
    body          TEXT    NOT NULL DEFAULT '',
    priority      INTEGER NOT NULL DEFAULT 0,
    attempts      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL,
    started_at    TEXT,
    finished_at   TEXT,
    error_message TEXT,
    queue_id      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_poll    ON jobs(status, priority DESC, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_jobs_node_id ON jobs(node_id);
`);

// ─── Milestone 4: queue_id added to jobs (idempotent upgrade for existing DBs) ─
try { db.exec("ALTER TABLE jobs ADD COLUMN queue_id TEXT") } catch {}

// ─── Milestone 5: campaign fields on jobs (canonical queue migration) ─────────
// scheduled_for — withholds dispatch until this UTC timestamp (mirrors send_jobs.scheduledFor)
// contact_id    — links to contacts row so completion handler can update status
// send_log_id   — links to send_log row so completion handler can update delivery status
try { db.exec("ALTER TABLE jobs ADD COLUMN scheduled_for TEXT")    } catch {}
try { db.exec("ALTER TABLE jobs ADD COLUMN contact_id    INTEGER") } catch {}
try { db.exec("ALTER TABLE jobs ADD COLUMN send_log_id   INTEGER") } catch {}

// ─── Production hardening: missing indexes (idempotent) ───────────────────────
db.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_status              ON contacts(status)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_scheduled_sends_status_sched ON scheduled_sends(status, scheduledAt)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_send_log_scheduledSendId     ON send_log(scheduledSendId)`);

// ─── Plain-text email support (content_type field) ───────────────────────────
// content_type = 'html' (default) | 'text'
// For text mode: the mail-node sends text/plain only, no HTML MIME part.
// Existing rows without the column get DEFAULT 'html', preserving behaviour.
try { db.exec("ALTER TABLE jobs              ADD COLUMN content_type TEXT NOT NULL DEFAULT 'html'") } catch {}
try { db.exec("ALTER TABLE send_jobs         ADD COLUMN content_type TEXT NOT NULL DEFAULT 'html'") } catch {}
try { db.exec("ALTER TABLE templates         ADD COLUMN content_type TEXT NOT NULL DEFAULT 'html'") } catch {}
try { db.exec("ALTER TABLE recurring_campaigns ADD COLUMN content_type TEXT NOT NULL DEFAULT 'html'") } catch {}
try { db.exec("ALTER TABLE scheduled_sends   ADD COLUMN content_type TEXT NOT NULL DEFAULT 'html'") } catch {}

// ─── Milestone 6: Delivery Tracking ──────────────────────────────────────────
//
// campaigns — one row per campaign dispatch (batch send run).
//   type = 'manual' | 'scheduled_send' | 'recurring' | 'daily_batch'
//   scheduled_send_id / recurring_campaign_id are typed FKs (exclusive arcs):
//     at most one is non-NULL, identifying the source of this dispatch.
//   Manual and daily_batch campaigns have both FKs NULL.
//   date is the YYYY-MM-DD UTC calendar day the send was dispatched.
//   Manual sends on the same calendar day share one campaigns row (grouped by day).

db.exec(`
  CREATE TABLE IF NOT EXISTS campaigns (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    type                  TEXT    NOT NULL,
    scheduled_send_id     INTEGER REFERENCES scheduled_sends(id),
    recurring_campaign_id INTEGER REFERENCES recurring_campaigns(id),
    identity_id           INTEGER REFERENCES sender_identities(id),
    label                 TEXT,
    status                TEXT    NOT NULL DEFAULT 'running',
    date                  TEXT    NOT NULL,
    created_at            TEXT    NOT NULL,
    completed_at          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_campaigns_type_date            ON campaigns(type, date);
  CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled_send_id    ON campaigns(scheduled_send_id);
  CREATE INDEX IF NOT EXISTS idx_campaigns_recurring_id         ON campaigns(recurring_campaign_id);
`);

// campaign_stats — one row per campaigns row, updated transactionally on each
//   delivery event.  Counters are the permanent historical record: they survive
//   the 90-day delivery_events retention window.
//   total_currently_deferred tracks the count of jobs still awaiting retry
//   (decremented when a deferred job is eventually delivered or bounced).

db.exec(`
  CREATE TABLE IF NOT EXISTS campaign_stats (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id              INTEGER NOT NULL UNIQUE REFERENCES campaigns(id),
    total_jobs               INTEGER NOT NULL DEFAULT 0,
    total_sent               INTEGER NOT NULL DEFAULT 0,
    total_send_failed        INTEGER NOT NULL DEFAULT 0,
    total_delivered          INTEGER NOT NULL DEFAULT 0,
    total_bounced            INTEGER NOT NULL DEFAULT 0,
    total_currently_deferred INTEGER NOT NULL DEFAULT 0,
    total_complained         INTEGER NOT NULL DEFAULT 0,
    last_updated             TEXT,
    created_at               TEXT    NOT NULL
  );
`);

// jobs: campaign_id links a job to its dispatch campaign.
//   delivery_status tracks the Postfix/MX delivery outcome independently from
//   the SMTP submission status (jobs.status).  Values:
//   SMTP_PENDING | SMTP_ACCEPTED | DEFERRED | DELIVERED | BOUNCED | SEND_FAILED | COMPLAINED
try { db.exec("ALTER TABLE jobs ADD COLUMN campaign_id     INTEGER REFERENCES campaigns(id)") } catch {}
try { db.exec("ALTER TABLE jobs ADD COLUMN delivery_status TEXT DEFAULT 'SMTP_PENDING'")      } catch {}

// delivery_events: job_id links canonical pipeline events to their jobs row.
//   NULL for legacy send_jobs events (sendJobId covers those).
//   dedup_key enforces idempotency: duplicate log lines from a restarted parser
//   are silently ignored via INSERT OR IGNORE.
try { db.exec("ALTER TABLE delivery_events ADD COLUMN job_id    INTEGER") } catch {}
try { db.exec("ALTER TABLE delivery_events ADD COLUMN dedup_key TEXT")    } catch {}

// Indexes for Milestone 6 hot paths (all idempotent)
// ─── Provisioning verification (controller ↔ node) ───────────────────────────
// An identity is only sendable when its OWNING node has proven it is locally
// provisioned (DKIM key + OpenDKIM tables + Postfix transport/bind/HELO) and its
// DNS (FCrDNS + DKIM public key) checks out. The node posts a report to
// POST /api/nodes/provisioning-report; only safe metadata is stored here — never
// keys, secrets, or raw config.
//   verificationStatus: 'unverified' | 'READY' | 'NOT_READY' | 'DNS_UNAVAILABLE'
try { db.exec("ALTER TABLE sender_identities ADD COLUMN verificationStatus   TEXT NOT NULL DEFAULT 'unverified'") } catch {}
try { db.exec("ALTER TABLE sender_identities ADD COLUMN lastVerifiedAt       TEXT")    } catch {}
try { db.exec("ALTER TABLE sender_identities ADD COLUMN verificationReasons  TEXT")    } catch {}
try { db.exec("ALTER TABLE sender_identities ADD COLUMN verifiedIpv4         TEXT")    } catch {}
try { db.exec("ALTER TABLE sender_identities ADD COLUMN verifiedHostname     TEXT")    } catch {}
try { db.exec("ALTER TABLE sender_identities ADD COLUMN verifiedDkimSelector TEXT")    } catch {}

// Ownership boundary: the canonical poll/claim filter jobs by their identity's
// owning server. This index supports the serverId+status lookup used by
// findNextPending's JOIN and claimJob's subquery.
db.exec(`CREATE INDEX        IF NOT EXISTS idx_sender_identities_server ON sender_identities(serverId, status, verificationStatus)`);
db.exec(`CREATE INDEX        IF NOT EXISTS idx_jobs_identity_id        ON jobs(identity_id)`);
db.exec(`CREATE INDEX        IF NOT EXISTS idx_jobs_queue_id          ON jobs(queue_id)`);
db.exec(`CREATE INDEX        IF NOT EXISTS idx_jobs_campaign_id       ON jobs(campaign_id)`);
db.exec(`CREATE INDEX        IF NOT EXISTS idx_jobs_delivery_status   ON jobs(delivery_status)`);
db.exec(`CREATE INDEX        IF NOT EXISTS idx_delivery_events_job_id ON delivery_events(job_id)`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_events_dedup  ON delivery_events(dedup_key)`);

// ─── Campaign Engagement: Buttons, Click Tracking, Open Tracking ───────────────
//
// buttons          — reusable CTA definition library (admin-facing).
// campaign_buttons — per-campaign FROZEN snapshot of a button (text+URL+style).
//                    The click redirect ALWAYS resolves its destination from here,
//                    so editing/deleting a button never changes an already-queued
//                    campaign's links. One row per (campaign, button) actually used.
// click_events     — immutable raw log; ONE row per /c/<token> request. Never a
//                    boolean. classification is analytics-only (never gates redirect).
// open_events      — immutable raw log; ONE row per /o/<token>.gif request.
//
// Neither event table stores the raw client IP — only a salted ip_hash + the
// derived `signals` JSON, so historical events can be reclassified without PII.

db.exec(`
  CREATE TABLE IF NOT EXISTS buttons (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    internal_name   TEXT NOT NULL,
    text            TEXT NOT NULL,
    destination_url TEXT NOT NULL,
    style           TEXT NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      TEXT NOT NULL,
    updated_at      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_buttons_status ON buttons(status);

  CREATE TABLE IF NOT EXISTS campaign_buttons (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id     INTEGER NOT NULL REFERENCES campaigns(id),
    button_id       INTEGER NOT NULL REFERENCES buttons(id),
    text            TEXT NOT NULL,
    destination_url TEXT NOT NULL,
    style           TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_buttons_unique   ON campaign_buttons(campaign_id, button_id);
  CREATE INDEX        IF NOT EXISTS idx_campaign_buttons_campaign ON campaign_buttons(campaign_id);

  CREATE TABLE IF NOT EXISTS click_events (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_button_id INTEGER NOT NULL REFERENCES campaign_buttons(id),
    campaign_id        INTEGER NOT NULL REFERENCES campaigns(id),
    contact_id         INTEGER,
    clicked_at         TEXT NOT NULL,
    http_method        TEXT,
    user_agent         TEXT,
    ip_hash            TEXT,
    is_prefetch        INTEGER NOT NULL DEFAULT 0,
    seconds_since_send INTEGER,
    signals            TEXT,
    classification     TEXT NOT NULL DEFAULT 'unknown',
    classified_reason  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_click_events_campaign ON click_events(campaign_id);
  CREATE INDEX IF NOT EXISTS idx_click_events_cbutton  ON click_events(campaign_button_id);
  CREATE INDEX IF NOT EXISTS idx_click_events_contact  ON click_events(contact_id);

  CREATE TABLE IF NOT EXISTS open_events (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id        INTEGER NOT NULL REFERENCES campaigns(id),
    contact_id         INTEGER,
    opened_at          TEXT NOT NULL,
    http_method        TEXT,
    user_agent         TEXT,
    ip_hash            TEXT,
    is_prefetch        INTEGER NOT NULL DEFAULT 0,
    seconds_since_send INTEGER,
    signals            TEXT,
    classification     TEXT NOT NULL DEFAULT 'unknown',
    classified_reason  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_open_events_campaign ON open_events(campaign_id);
  CREATE INDEX IF NOT EXISTS idx_open_events_contact  ON open_events(contact_id);
`);

// Global tracking config (singleton row id=1). open_tracking_enabled defaults to
// 1 (ON) — opens-by-default is a core engagement-report requirement. A pixel is
// still injected ONLY when tracking is effectively enabled AND the sending
// domain's click.<domain> tracking host is provisioned/ready (readiness gate in
// services/TrackingHostReadiness.js), so an ON default never ships a broken pixel.
db.exec(`
  CREATE TABLE IF NOT EXISTS tracking_config (
    id                    INTEGER PRIMARY KEY CHECK (id = 1),
    open_tracking_enabled INTEGER NOT NULL DEFAULT 1
  );
  INSERT OR IGNORE INTO tracking_config (id, open_tracking_enabled) VALUES (1, 1);
`);

// Per-campaign open-tracking override: NULL = inherit global, 0 = force off, 1 = force on.
try { db.exec("ALTER TABLE campaigns ADD COLUMN open_tracking_override INTEGER") } catch {}

// Composite indexes that materially support real query patterns:
//   • click_events(campaign_id, contact_id, clicked_at) — recipientRows GROUP BY,
//     the burst signal (distinct buttons per recipient in a window), and dedup.
//   • open_events(campaign_id, contact_id, opened_at)   — recipientRows GROUP BY + dedup.
db.exec("CREATE INDEX IF NOT EXISTS idx_click_events_campaign_contact ON click_events(campaign_id, contact_id, clicked_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_open_events_campaign_contact  ON open_events(campaign_id, contact_id, opened_at)");

// Compiled plain-text alternative for canonical jobs whose HTML body contains
// tracked buttons. When set, the poll endpoint surfaces it to the node as `txt`
// so the plain-text part keeps the button CTA ("TEXT: url") instead of the node
// stripping the HTML (which would drop the tracking link). NULL for every job that
// does not use buttons → existing send behaviour is unchanged.
try { db.exec("ALTER TABLE jobs ADD COLUMN body_text TEXT") } catch {}

// ─── Contact Groups + campaign targeting (Phase 0: additive schema only) ───────
//
// Groups let imported contacts be organised into named lists that campaigns and
// schedules can target. This phase adds STORAGE ONLY — nothing reads these tables
// or columns yet, so behaviour is unchanged.
//
// Membership is many-to-many (a contact can live in several lists). Targeting is
// stored as a SET of groups per source (recurring campaign / daily batch); an
// empty set is NOT "all" — target_mode makes the intent explicit (default 'all'
// preserves today's whole-pool behaviour for existing rows).
//
// campaign_send_ledger is the per-campaign de-duplication record ("this contact
// has been committed to this source"): source_type ∈ 'recurring' | 'daily_batch',
// source_id = recurring_campaigns.id (or the fixed sentinel 1 for the singleton
// daily batch). It is written at queue time by later phases — empty for now.
//
// FK policy: membership + ledger cascade on contact/group delete (rows are
// meaningless without their parent). The two TARGETING junctions use RESTRICT on
// group_id so a later phase's app-level "block deletion when in use" check wins
// rather than a group silently vanishing from a live campaign's audience.
db.exec(`
  CREATE TABLE IF NOT EXISTS contact_groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    createdAt   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contact_group_members (
    group_id   INTEGER NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES contacts(id)       ON DELETE CASCADE,
    addedAt    TEXT NOT NULL,
    PRIMARY KEY (group_id, contact_id)
  );
  CREATE INDEX IF NOT EXISTS idx_contact_group_members_contact ON contact_group_members(contact_id);

  CREATE TABLE IF NOT EXISTS recurring_campaign_groups (
    recurring_campaign_id INTEGER NOT NULL REFERENCES recurring_campaigns(id) ON DELETE CASCADE,
    group_id              INTEGER NOT NULL REFERENCES contact_groups(id)      ON DELETE RESTRICT,
    PRIMARY KEY (recurring_campaign_id, group_id)
  );
  CREATE INDEX IF NOT EXISTS idx_recurring_campaign_groups_group ON recurring_campaign_groups(group_id);

  CREATE TABLE IF NOT EXISTS daily_batch_groups (
    group_id INTEGER NOT NULL REFERENCES contact_groups(id) ON DELETE RESTRICT,
    PRIMARY KEY (group_id)
  );

  CREATE TABLE IF NOT EXISTS campaign_send_ledger (
    source_type TEXT    NOT NULL,
    source_id   INTEGER NOT NULL,
    contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    queued_at   TEXT    NOT NULL,
    PRIMARY KEY (source_type, source_id, contact_id)
  );
  CREATE INDEX IF NOT EXISTS idx_campaign_send_ledger_contact ON campaign_send_ledger(contact_id);
`);

// Explicit targeting mode. DEFAULT 'all' keeps every existing recurring campaign
// and the daily batch targeting the whole pool exactly as before (no behaviour
// change). Later phases add 'groups'. Idempotent — safe to re-run on upgrades.
try { db.exec("ALTER TABLE recurring_campaigns ADD COLUMN target_mode TEXT NOT NULL DEFAULT 'all'") } catch {}
try { db.exec("ALTER TABLE schedule_config     ADD COLUMN target_mode TEXT NOT NULL DEFAULT 'all'") } catch {}

export default db;
