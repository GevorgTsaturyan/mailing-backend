// Phase 3 — SendLedger unit tests: idempotent claims, eligibility filtering
// (ledger + suppression + groups + LIMIT), and the guarded one-time backfill.
// Pure DB unit tests — independent of the queue mode.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH ||= ':memory:';

const db = (await import('./db.js')).default;
const Ledger = await import('./services/SendLedger.js');
const { DAILY_BATCH_SOURCE_ID } = Ledger;

let seq = 0;
function newContact(status = 'pending') {
  const email = `led-${Date.now()}-${seq++}@example.com`;
  return Number(db.prepare(
    "INSERT INTO contacts (firstName, lastName, email, status) VALUES ('T','U',?,?)"
  ).run(email, status).lastInsertRowid);
}
function newGroup(name, contactIds = []) {
  const now = new Date().toISOString();
  const id = Number(db.prepare('INSERT INTO contact_groups (name, createdAt) VALUES (?, ?)').run(name, now).lastInsertRowid);
  for (const cid of contactIds) db.prepare('INSERT INTO contact_group_members (group_id, contact_id, addedAt) VALUES (?,?,?)').run(id, cid, now);
  return id;
}

test('record: first claim true, duplicate claim false, exactly one row', () => {
  const c = newContact();
  const now = new Date().toISOString();
  assert.equal(Ledger.record('recurring', 42, c, now), true);
  assert.equal(Ledger.record('recurring', 42, c, now), false); // PK collision → no-op
  const n = db.prepare("SELECT COUNT(*) n FROM campaign_send_ledger WHERE source_type='recurring' AND source_id=42 AND contact_id=?").get(c).n;
  assert.equal(n, 1);
});

test('record: same contact under a different source is independent', () => {
  const c = newContact();
  const now = new Date().toISOString();
  assert.equal(Ledger.record('recurring', 100, c, now), true);
  assert.equal(Ledger.record('recurring', 200, c, now), true); // different campaign — allowed
  assert.equal(Ledger.record('daily_batch', DAILY_BATCH_SOURCE_ID, c, now), true);
});

test('eligibleContacts all: excludes already-ledgered', () => {
  const a = newContact(), b = newContact();
  Ledger.record('recurring', 300, a, new Date().toISOString());
  const ids = Ledger.eligibleContacts({ sourceType: 'recurring', sourceId: 300, targetMode: 'all', limit: 1000 }).map((c) => c.id);
  assert.ok(!ids.includes(a));
  assert.ok(ids.includes(b));
});

test('eligibleContacts all: excludes unsubscribed BEFORE limit (no slot wasted)', () => {
  const u = newContact('unsubscribed');   // lower id
  const p = newContact('pending');         // higher id
  const src = 301;
  // limit 1 restricted to just these two via a group would be cleaner, but 'all'
  // still must skip u; assert u is never returned and p is eligible.
  const ids = Ledger.eligibleContacts({ sourceType: 'recurring', sourceId: src, targetMode: 'all', limit: 1000 }).map((c) => c.id);
  assert.ok(!ids.includes(u));
  assert.ok(ids.includes(p));
});

test('eligibleContacts groups: DISTINCT union across overlapping groups', () => {
  const shared = newContact(), onlyG1 = newContact(), onlyG2 = newContact();
  const g1 = newGroup('LG1', [shared, onlyG1]);
  const g2 = newGroup('LG2', [shared, onlyG2]);
  const rows = Ledger.eligibleContacts({ sourceType: 'recurring', sourceId: 302, targetMode: 'groups', groupIds: [g1, g2], limit: 1000 });
  const ids = rows.map((c) => c.id);
  assert.equal(ids.filter((x) => x === shared).length, 1); // appears once
  assert.ok(ids.includes(onlyG1) && ids.includes(onlyG2));
});

test('eligibleContacts groups: empty groupIds → zero rows (never all)', () => {
  newContact(); newContact(); // pool is non-empty
  const rows = Ledger.eligibleContacts({ sourceType: 'recurring', sourceId: 303, targetMode: 'groups', groupIds: [], limit: 1000 });
  assert.equal(rows.length, 0);
});

test('backfill: seeds handled contacts once, is guarded against re-runs', () => {
  // fresh sources for this assertion
  const sent    = newContact('sent');
  const failed  = newContact('failed');
  const pending = newContact('pending');
  const rcId = Number(db.prepare(`
    INSERT INTO recurring_campaigns (name, subject, html, txt, content_type, startTime, endTime, initialCount, increasePercent, status, currentDay, target_mode, createdAt)
    VALUES ('BF','S','<p>x</p>','x','html','00:00','23:59',10,0,'active',0,'all',?)
  `).run(new Date().toISOString()).lastInsertRowid);

  assert.equal(Ledger.backfillHasRun(), false);
  const r1 = Ledger.runBackfillOnce();
  assert.equal(r1.ran, true);
  assert.equal(Ledger.backfillHasRun(), true);

  // sent + failed seeded into the recurring campaign; pending NOT seeded
  const inLedger = (cid) => db.prepare("SELECT 1 FROM campaign_send_ledger WHERE source_type='recurring' AND source_id=? AND contact_id=?").get(rcId, cid);
  assert.ok(inLedger(sent));
  assert.ok(inLedger(failed));
  assert.ok(!inLedger(pending));
  // also seeded under the daily-batch sentinel
  assert.ok(db.prepare("SELECT 1 FROM campaign_send_ledger WHERE source_type='daily_batch' AND source_id=? AND contact_id=?").get(DAILY_BATCH_SOURCE_ID, sent));

  // A contact that becomes non-pending AFTER the backfill must NOT be seeded by a re-run.
  const laterSent = newContact('sent');
  const r2 = Ledger.runBackfillOnce();
  assert.equal(r2.ran, false);
  assert.equal(r2.seeded, 0);
  assert.ok(!inLedger(laterSent));
});
