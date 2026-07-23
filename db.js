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
    error_message TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_poll    ON jobs(status, priority DESC, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_jobs_node_id ON jobs(node_id);
`);

export default db;
