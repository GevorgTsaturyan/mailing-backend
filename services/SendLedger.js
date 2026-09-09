import db from '../db.js';
import { suppressionExclusionSql } from './SuppressionService.js';

// ─── SendLedger — per-campaign "already committed" record (Phase 3) ───────────
//
// campaign_send_ledger answers "has this contact already been committed to this
// source?" It is the de-duplication source of truth for the automated pipelines
// (recurring campaigns + the daily batch), decoupled from contacts.status and
// from the operational job/queue tables. One row per (source_type, source_id,
// contact_id); the composite PK makes writes idempotent and race-safe.
//
//   source_type : 'recurring' | 'daily_batch'
//   source_id   : recurring_campaigns.id, or DAILY_BATCH_SOURCE_ID for the batch
//
// The ledger is WRITTEN by the queue helpers (scheduler.js), ledger-first inside
// the same transaction as the job insert, so a ledger row and its job are created
// atomically or not at all. Manual + one-off scheduled sends never write here.

// The daily batch is a singleton (schedule_config id=1); it has no per-campaign
// id, so it uses this fixed sentinel everywhere (selection, write, backfill).
export const DAILY_BATCH_SOURCE_ID = 1;

// Insert a claim. INSERT OR IGNORE → returns true when a NEW row was created,
// false when the contact was already committed to this source (PK collision).
// Must be called inside the caller's transaction so it commits/rolls back with
// the job it guards.
export function record(sourceType, sourceId, contactId, now) {
  const r = db.prepare(
    `INSERT OR IGNORE INTO campaign_send_ledger (source_type, source_id, contact_id, queued_at)
     VALUES (?, ?, ?, ?)`
  ).run(sourceType, sourceId, contactId, now);
  return r.changes > 0;
}

// Contacts eligible for the next send from a source: NOT already in this source's
// ledger, NOT suppressed (unsubscribed), ordered by id and capped at `limit`.
//   target_mode='all'    → whole contact pool
//   target_mode='groups' → DISTINCT union of the targeted groups' members;
//                          an empty groupIds set yields ZERO rows (never "all").
export function eligibleContacts({ sourceType, sourceId, targetMode, groupIds = [], limit }) {
  if (limit == null || limit <= 0) return [];
  const notLedgered = `NOT EXISTS (
      SELECT 1 FROM campaign_send_ledger l
      WHERE l.source_type = ? AND l.source_id = ? AND l.contact_id = c.id
    )`;
  const notSuppressed = suppressionExclusionSql('c');

  if (targetMode === 'groups') {
    const ids = [...new Set((groupIds || []).map(Number).filter((n) => Number.isInteger(n)))];
    if (ids.length === 0) return []; // empty group target is NEVER all contacts
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`
      SELECT DISTINCT c.* FROM contacts c
      JOIN contact_group_members m ON m.contact_id = c.id
      WHERE m.group_id IN (${placeholders})
        AND ${notLedgered}
        AND ${notSuppressed}
      ORDER BY c.id
      LIMIT ?
    `).all(...ids, sourceType, sourceId, limit);
  }

  // target_mode='all' (default)
  return db.prepare(`
    SELECT c.* FROM contacts c
    WHERE ${notLedgered}
      AND ${notSuppressed}
    ORDER BY c.id
    LIMIT ?
  `).all(sourceType, sourceId, limit);
}

// ── One-time migration backfill ────────────────────────────────────────────────
// Seed the ledger so existing sources do not re-send contacts they already
// handled once selection moves off status='pending'. Faithful to today's shared
// pool: every contact with status != 'pending' (sent/queued/failed) is seeded, so
// each existing source behaves exactly as before. Idempotent per row (INSERT OR
// IGNORE), but must be GUARDED to run once — see runBackfillOnce().
//
// Marker table records completion so a re-run after post-migration sends can never
// re-seed newly-non-pending contacts (which would wrongly suppress future sends).
function ensureMarkerTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name    TEXT PRIMARY KEY,
      ran_at  TEXT NOT NULL
    );
  `);
}

const BACKFILL_MARKER = 'phase3_ledger_backfill';

export function backfillHasRun() {
  ensureMarkerTable();
  return !!db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(BACKFILL_MARKER);
}

// Runs the backfill exactly once. Seeds each recurring campaign in
// status IN ('active','paused') plus the daily batch sentinel with all
// already-handled (status != 'pending') contacts, then records the marker — all
// in ONE transaction so a crash rolls back and it re-runs cleanly next boot.
// Returns { ran: boolean, seeded: number }.
export function runBackfillOnce() {
  ensureMarkerTable();
  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(BACKFILL_MARKER)) {
      return { ran: false, seeded: 0 };
    }
    const now = new Date().toISOString();
    const handled = db.prepare("SELECT id FROM contacts WHERE status <> 'pending'").all().map((r) => r.id);

    const ins = db.prepare(
      `INSERT OR IGNORE INTO campaign_send_ledger (source_type, source_id, contact_id, queued_at)
       VALUES (?, ?, ?, ?)`
    );
    let seeded = 0;
    const seed = (sourceType, sourceId) => {
      for (const cid of handled) seeded += ins.run(sourceType, sourceId, cid, now).changes;
    };

    const recurring = db.prepare(
      "SELECT id FROM recurring_campaigns WHERE status IN ('active','paused')"
    ).all();
    for (const rc of recurring) seed('recurring', rc.id);
    seed('daily_batch', DAILY_BATCH_SOURCE_ID);

    db.prepare('INSERT INTO schema_migrations (name, ran_at) VALUES (?, ?)').run(BACKFILL_MARKER, now);
    return { ran: true, seeded };
  })();
}
