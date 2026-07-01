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

export default db;
