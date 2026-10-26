// Recurring campaigns: start date, per-weekday time ranges, resend to non-openers.
// Mode-agnostic like scheduler-targeting.test.js (jobs + send_jobs counted together)
// except the resend tests, which need canonical `jobs` rows as their source.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH ||= ':memory:';

const db = (await import('./db.js')).default;
const { applyRecurringCampaigns } = await import('./scheduler.js');
const RS = await import('./services/RecurringSchedule.js');
const { resendPreview } = await import('./services/SendLedger.js');

const MODE = process.env.USE_CANONICAL_QUEUE === 'true' ? 'canonical' : 'legacy';
const now = new Date().toISOString();
const todayUTC = now.slice(0, 10);
const todayWeekday = new Date().getUTCDay();
const dayOffset = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const serverId = Number(db.prepare(
  "INSERT INTO servers (label, apiKey, status, createdAt) VALUES ('node','KEY-RS','online',?)"
).run(now).lastInsertRowid);
const identityId = Number(db.prepare(
  `INSERT INTO sender_identities (serverId, domain, ip, fromAddr, fromName, status, verificationStatus, dailyLimit, dailySentCount, createdAt)
   VALUES (?, 'serawin.net', '1.2.3.4', 'support@serawin.net', 'Support', 'active', 'READY', 1000000, 0, ?)`
).run(serverId, now).lastInsertRowid);

let seq = 0;
const newContact = (status = 'pending') => Number(db.prepare(
  "INSERT INTO contacts (firstName,lastName,email,status) VALUES ('T','U',?,?)"
).run(`rs-${Date.now()}-${seq++}@example.com`, status).lastInsertRowid);
const newGroup = (contactIds) => {
  const id = Number(db.prepare('INSERT INTO contact_groups (name, createdAt) VALUES (?, ?)').run(`RS-${seq++}`, now).lastInsertRowid);
  for (const cid of contactIds) db.prepare('INSERT INTO contact_group_members (group_id, contact_id, addedAt) VALUES (?,?,?)').run(id, cid, now);
  return id;
};
function newRecurring({ groupIds = [], startDate = null, weekly = null, targetMode = 'groups', resendIds = null }) {
  const id = Number(db.prepare(`
    INSERT INTO recurring_campaigns (name, subject, html, txt, content_type, startTime, endTime, initialCount, increasePercent,
      status, currentDay, target_mode, start_date, weekly_schedule, resend_campaign_ids, createdAt)
    VALUES (?, 'S','<p>hi</p>','hi','html','00:00','23:59',1000,0,'active',0,?,?,?,?,?)
  `).run(`rs-${seq++}`, targetMode, startDate, weekly ? JSON.stringify(weekly) : null, resendIds ? JSON.stringify(resendIds) : null, now).lastInsertRowid);
  for (const gid of groupIds) db.prepare('INSERT INTO recurring_campaign_groups (recurring_campaign_id, group_id) VALUES (?,?)').run(id, gid);
  return id;
}
const queuedCount = (cid) =>
  db.prepare('SELECT COUNT(*) n FROM jobs WHERE contact_id=?').get(cid).n +
  db.prepare('SELECT COUNT(*) n FROM send_jobs WHERE contactId=?').get(cid).n;
const rc = (id) => db.prepare('SELECT * FROM recurring_campaigns WHERE id=?').get(id);

beforeEach(() => {
  db.prepare("UPDATE recurring_campaigns SET status='paused'").run();
  db.prepare('UPDATE schedule_config SET enabled=0 WHERE id=1').run();
});

// ── Pure helpers ──────────────────────────────────────────────────────────────

test('splitCount distributes evenly, remainder first', () => {
  assert.deepEqual(RS.splitCount(30, 3), [10, 10, 10]);
  assert.deepEqual(RS.splitCount(10, 3), [4, 3, 3]);
  assert.deepEqual(RS.splitCount(5, 0), []);
});

test('rangesForDay: legacy row → single window every day', () => {
  const legacy = { startTime: '09:00', endTime: '17:00', start_date: null, weekly_schedule: null };
  assert.deepEqual(RS.rangesForDay(legacy, '2026-10-25'), [{ start: '09:00', end: '17:00' }]);
  assert.deepEqual(RS.rangesForDay(legacy, '2026-10-26'), [{ start: '09:00', end: '17:00' }]);
});

test('rangesForDay: honours start date and weekday', () => {
  const c = { startTime: '09:00', endTime: '17:00', start_date: '2026-10-27',
    weekly_schedule: JSON.stringify({ 2: [{ start: '09:00', end: '10:00' }, { start: '14:00', end: '15:00' }] }) };
  assert.deepEqual(RS.rangesForDay(c, '2026-10-26'), []);            // before start date
  assert.equal(RS.rangesForDay(c, '2026-10-27').length, 2);           // Tuesday
  assert.deepEqual(RS.rangesForDay(c, '2026-10-28'), []);            // Wednesday: off
});

test('validateWeeklySchedule rejects bad input', () => {
  assert.ok(RS.validateWeeklySchedule({}).error);
  assert.ok(RS.validateWeeklySchedule({ 7: [{ start: '09:00', end: '10:00' }] }).error);
  assert.ok(RS.validateWeeklySchedule({ 1: [{ start: '10:00', end: '09:00' }] }).error);
  assert.ok(RS.validateWeeklySchedule({ 1: [{ start: '09:00', end: '11:00' }, { start: '10:00', end: '12:00' }] }).error);
  assert.deepEqual(RS.validateWeeklySchedule(null), { value: null });
  assert.deepEqual(
    RS.validateWeeklySchedule({ 1: [{ start: '14:00', end: '15:00' }, { start: '09:00', end: '10:00' }], 2: [] }).value,
    { 1: [{ start: '09:00', end: '10:00' }, { start: '14:00', end: '15:00' }] },
  );
});

// ── Scheduler integration ─────────────────────────────────────────────────────

test(`[${MODE}] legacy campaign (no start date / weekly schedule) still sends today`, () => {
  const a = newContact();
  const id = newRecurring({ groupIds: [newGroup([a])] });
  applyRecurringCampaigns();
  assert.equal(queuedCount(a), 1);
  assert.equal(rc(id).currentDay, 1);
});

test(`[${MODE}] future start date sends nothing and does not advance the day`, () => {
  const a = newContact();
  const id = newRecurring({ groupIds: [newGroup([a])], startDate: dayOffset(2) });
  applyRecurringCampaigns();
  assert.equal(queuedCount(a), 0);
  assert.equal(rc(id).currentDay, 0);
  assert.equal(rc(id).lastRunDate, null);
});

test(`[${MODE}] start date of today sends today`, () => {
  const a = newContact();
  newRecurring({ groupIds: [newGroup([a])], startDate: todayUTC });
  applyRecurringCampaigns();
  assert.equal(queuedCount(a), 1);
});

test(`[${MODE}] weekday without ranges is skipped`, () => {
  const a = newContact();
  const other = (todayWeekday + 1) % 7;
  const id = newRecurring({ groupIds: [newGroup([a])], weekly: { [other]: [{ start: '00:00', end: '23:59' }] } });
  applyRecurringCampaigns();
  assert.equal(queuedCount(a), 0);
  assert.equal(rc(id).currentDay, 0);
});

test(`[${MODE}] weekday with several ranges sends within them`, () => {
  const contacts = [newContact(), newContact(), newContact()];
  newRecurring({
    groupIds: [newGroup(contacts)],
    weekly: { [todayWeekday]: [{ start: '00:00', end: '11:00' }, { start: '12:00', end: '23:59' }] },
  });
  applyRecurringCampaigns();
  for (const c of contacts) assert.equal(queuedCount(c), 1);
});

// ── Resend to non-openers (canonical source jobs) ─────────────────────────────

function sourceCampaign(rows) {
  const cid = Number(db.prepare(
    "INSERT INTO campaigns (type, label, status, date, created_at) VALUES ('recurring','src','running',?,?)"
  ).run(todayUTC, now).lastInsertRowid);
  for (const { contact, status = 'SENT', delivery = 'DELIVERED', opened = false, clicked = false } of rows) {
    db.prepare(`INSERT INTO jobs (status, recipient, subject, contact_id, campaign_id, delivery_status, created_at)
                VALUES (?, 'x@example.com', 'S', ?, ?, ?, ?)`).run(status, contact, cid, delivery, now);
    if (opened) db.prepare('INSERT INTO open_events (campaign_id, contact_id, opened_at) VALUES (?,?,?)').run(cid, contact, now);
    if (clicked) {
      const btn = Number(db.prepare("INSERT INTO buttons (internal_name, text, destination_url, created_at) VALUES ('b','b','https://e.com',?)").run(now).lastInsertRowid);
      const cb  = Number(db.prepare("INSERT INTO campaign_buttons (campaign_id, button_id, text, destination_url, created_at) VALUES (?,?,'b','https://e.com',?)").run(cid, btn, now).lastInsertRowid);
      db.prepare('INSERT INTO click_events (campaign_button_id, campaign_id, contact_id, clicked_at) VALUES (?,?,?,?)').run(cb, cid, contact, now);
    }
  }
  return cid;
}

test(`[${MODE}] resend targets only delivered non-openers`, () => {
  const nonOpener = newContact('sent'), opener = newContact('sent'), clicker = newContact('sent'),
        bounced = newContact('sent'), unsub = newContact('unsubscribed'), outsider = newContact();
  const src = sourceCampaign([
    { contact: nonOpener }, { contact: opener, opened: true }, { contact: clicker, clicked: true },
    { contact: bounced, delivery: 'BOUNCED' }, { contact: unsub },
  ]);
  assert.deepEqual(resendPreview([src]), { sent: 5, opened: 2, eligible: 1 });

  const id = newRecurring({ targetMode: 'resend', resendIds: [src] });
  applyRecurringCampaigns();
  const resent = (cid) =>
    db.prepare('SELECT COUNT(*) n FROM jobs WHERE contact_id=? AND campaign_id<>?').get(cid, src).n +
    db.prepare('SELECT COUNT(*) n FROM send_jobs WHERE contactId=?').get(cid).n;
  assert.equal(resent(nonOpener), 1);
  for (const c of [opener, clicker, bounced, unsub, outsider]) assert.equal(resent(c), 0);

  // Next run: nobody left → completed, nothing re-sent.
  db.prepare('UPDATE recurring_campaigns SET lastRunDate=NULL WHERE id=?').run(id);
  applyRecurringCampaigns();
  assert.equal(resent(nonOpener), 1);
  assert.equal(rc(id).status, 'completed');
});

test(`[${MODE}] resend with empty source set never falls back to all contacts`, () => {
  const a = newContact();
  newRecurring({ targetMode: 'resend', resendIds: [] });
  applyRecurringCampaigns();
  assert.equal(queuedCount(a), 0);
});
