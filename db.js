import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, 'data', 'mail.db'));

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
db.exec(`CREATE INDEX        IF NOT EXISTS idx_jobs_queue_id          ON jobs(queue_id)`);
db.exec(`CREATE INDEX        IF NOT EXISTS idx_jobs_campaign_id       ON jobs(campaign_id)`);
db.exec(`CREATE INDEX        IF NOT EXISTS idx_jobs_delivery_status   ON jobs(delivery_status)`);
db.exec(`CREATE INDEX        IF NOT EXISTS idx_delivery_events_job_id ON delivery_events(job_id)`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_events_dedup  ON delivery_events(dedup_key)`);

export default db;
