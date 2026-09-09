// Phase 3 — automated targeting via the ledger, exercised end-to-end through the
// scheduler's plan functions. Mode-agnostic: assertions use the ledger + a combined
// job count (jobs + send_jobs), so the SAME file verifies both queue modes when
// the suite is run with USE_CANONICAL_QUEUE on and off.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH ||= ':memory:';

const db = (await import('./db.js')).default;
const { applyRecurringCampaigns, applyScheduleConfig } = await import('./scheduler.js');
const Ledger = await import('./services/SendLedger.js');
const { DAILY_BATCH_SOURCE_ID } = Ledger;

const MODE = process.env.USE_CANONICAL_QUEUE === 'true' ? 'canonical' : 'legacy';
const now = new Date().toISOString();

// An active, READY identity with generous capacity (both pipelines require this).
const serverId = Number(db.prepare(
  "INSERT INTO servers (label, apiKey, status, createdAt) VALUES ('node','KEY-SCHED-TARGET','online',?)"
).run(now).lastInsertRowid);
db.prepare(
  `INSERT INTO sender_identities (serverId, domain, ip, fromAddr, fromName, status, verificationStatus, dailyLimit, dailySentCount, createdAt)
   VALUES (?, 'serawin.net', '1.2.3.4', 'support@serawin.net', 'Support', 'active', 'READY', 1000000, 0, ?)`
).run(serverId, now);
// Daily-batch template.
db.prepare("INSERT OR IGNORE INTO templates (name, subject, html, txt) VALUES ('welcome','Hi','<p>hi</p>','hi')").run();

let seq = 0;
const newContact = (status = 'pending') => {
  const email = `st-${Date.now()}-${seq++}@example.com`;
  return Number(db.prepare("INSERT INTO contacts (firstName,lastName,email,status) VALUES ('T','U',?,?)").run(email, status).lastInsertRowid);
};
const newGroup = (name, contactIds = []) => {
  const id = Number(db.prepare('INSERT INTO contact_groups (name, createdAt) VALUES (?, ?)').run(name, now).lastInsertRowid);
  for (const cid of contactIds) db.prepare('INSERT INTO contact_group_members (group_id, contact_id, addedAt) VALUES (?,?,?)').run(id, cid, now);
  return id;
};
function newRecurring({ name, targetMode = 'all', groupIds = [], initialCount = 1000 }) {
  const id = Number(db.prepare(`
    INSERT INTO recurring_campaigns (name, subject, html, txt, content_type, startTime, endTime, initialCount, increasePercent, status, currentDay, target_mode, createdAt)
    VALUES (?, 'S','<p>hi</p>','hi','html','00:00','23:59',?,0,'active',0,?,?)
  `).run(name, initialCount, targetMode, now).lastInsertRowid);
  for (const gid of groupIds) db.prepare('INSERT INTO recurring_campaign_groups (recurring_campaign_id, group_id) VALUES (?,?)').run(id, gid);
  return id;
}
const enableDailyBatch = ({ targetMode = 'all', groupIds = [], batchSize = 1000 }) => {
  db.prepare("UPDATE schedule_config SET enabled=1, batchSize=?, startTime='00:00', endTime='23:59', template='welcome', target_mode=? WHERE id=1")
    .run(batchSize, targetMode);
  db.prepare('DELETE FROM daily_batch_groups').run();
  for (const gid of groupIds) db.prepare('INSERT INTO daily_batch_groups (group_id) VALUES (?)').run(gid);
};

const queuedCount = (cid) =>
  db.prepare('SELECT COUNT(*) n FROM jobs WHERE contact_id=?').get(cid).n +
  db.prepare('SELECT COUNT(*) n FROM send_jobs WHERE contactId=?').get(cid).n;
const ledgerCount = (st, sid, cid) =>
  db.prepare('SELECT COUNT(*) n FROM campaign_send_ledger WHERE source_type=? AND source_id=? AND contact_id=?').get(st, sid, cid).n;

// Isolate each test: only the campaigns/daily-batch it activates should run.
beforeEach(() => {
  db.prepare("UPDATE recurring_campaigns SET status='paused'").run();
  db.prepare('UPDATE schedule_config SET enabled=0 WHERE id=1').run();
});

test(`[${MODE}] overlapping groups queue a contact only once`, () => {
  const shared = newContact(), other = newContact();
  const g1 = newGroup('OG1', [shared, other]);
  const g2 = newGroup('OG2', [shared]);
  const id = newRecurring({ name: 'overlap', targetMode: 'groups', groupIds: [g1, g2] });
  applyRecurringCampaigns();
  assert.equal(queuedCount(shared), 1);
  assert.equal(ledgerCount('recurring', id, shared), 1);
  assert.equal(queuedCount(other), 1);
});

test(`[${MODE}] recurring does not resend a ledgered contact on the next run`, () => {
  const a = newContact();
  const g = newGroup('RC1', [a]);
  const id = newRecurring({ name: 'norepeat', targetMode: 'groups', groupIds: [g] });
  applyRecurringCampaigns();
  assert.equal(queuedCount(a), 1);

  // simulate "next day" + a newly added member
  db.prepare('UPDATE recurring_campaigns SET lastRunDate=NULL WHERE id=?').run(id);
  const b = newContact();
  db.prepare('INSERT INTO contact_group_members (group_id, contact_id, addedAt) VALUES (?,?,?)').run(g, b, now);
  applyRecurringCampaigns();

  assert.equal(queuedCount(a), 1);   // NOT resent
  assert.equal(queuedCount(b), 1);   // new member picked up
});

test(`[${MODE}] daily batch does not resend a ledgered contact`, () => {
  const a = newContact();
  const g = newGroup('DB1', [a]);
  enableDailyBatch({ targetMode: 'groups', groupIds: [g] });
  applyScheduleConfig();
  assert.equal(queuedCount(a), 1);
  assert.equal(ledgerCount('daily_batch', DAILY_BATCH_SOURCE_ID, a), 1);

  applyScheduleConfig();             // run again same "day"
  assert.equal(queuedCount(a), 1);   // not resent
});

test(`[${MODE}] different campaigns independently send to the same contact`, () => {
  const x = newContact();
  const g = newGroup('IND', [x]);
  const a = newRecurring({ name: 'indA', targetMode: 'groups', groupIds: [g] });
  const b = newRecurring({ name: 'indB', targetMode: 'groups', groupIds: [g] });
  applyRecurringCampaigns();         // processes both active campaigns
  assert.equal(queuedCount(x), 2);   // one per campaign
  assert.equal(ledgerCount('recurring', a, x), 1);
  assert.equal(ledgerCount('recurring', b, x), 1);
});

test(`[${MODE}] unsubscribed contacts are excluded before LIMIT`, () => {
  const u = newContact('unsubscribed');
  const p = newContact('pending');
  const g = newGroup('UNSUB', [u, p]);
  newRecurring({ name: 'unsub', targetMode: 'groups', groupIds: [g], initialCount: 1 }); // LIMIT 1
  applyRecurringCampaigns();
  assert.equal(queuedCount(u), 0);   // unsub not sent
  assert.equal(queuedCount(p), 1);   // the slot went to the pending contact, not wasted on u
});

test(`[${MODE}] a failed contact remains eligible for a campaign`, () => {
  const f = newContact('failed');
  const g = newGroup('FAIL', [f]);
  const id = newRecurring({ name: 'failelig', targetMode: 'groups', groupIds: [g] });
  applyRecurringCampaigns();
  assert.equal(queuedCount(f), 1);   // failed is NOT suppression
  assert.equal(ledgerCount('recurring', id, f), 1);
});

test(`[${MODE}] empty group target never means all contacts`, () => {
  const lonely = newContact();       // exists but in no targeted group
  const id = newRecurring({ name: 'emptygroups', targetMode: 'groups', groupIds: [] });
  applyRecurringCampaigns();
  assert.equal(queuedCount(lonely), 0);
  assert.equal(ledgerCount('recurring', id, lonely), 0);
  // exhausted-eligibility → completed
  assert.equal(db.prepare('SELECT status FROM recurring_campaigns WHERE id=?').get(id).status, 'completed');
});

test(`[${MODE}] existing campaign does not resend after backfill`, () => {
  const sent    = newContact('sent');     // already handled pre-migration
  const pend    = newContact('pending');
  const g       = newGroup('BFG', [sent, pend]);
  const id = newRecurring({ name: 'bf-existing', targetMode: 'groups', groupIds: [g] });

  // Backfill seeds all non-pending contacts (incl. `sent`) into active campaigns.
  Ledger.runBackfillOnce();
  db.prepare('UPDATE recurring_campaigns SET lastRunDate=NULL WHERE id=?').run(id);
  db.prepare("UPDATE recurring_campaigns SET status='active' WHERE id=?").run(id); // beforeEach paused it before backfill

  applyRecurringCampaigns();
  assert.equal(queuedCount(sent), 0);            // not resent — was backfilled
  assert.equal(queuedCount(pend), 1);            // pending still sent
  assert.equal(ledgerCount('recurring', id, sent), 1); // seeded by backfill
});
