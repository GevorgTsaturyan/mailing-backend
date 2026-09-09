// Phase 4 — targeting config on recurring campaigns + daily batch, and group
// deletion safety (409 vs ?detach=true). In-memory DB; bare Express apps.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.DB_PATH ||= ':memory:';

const db               = (await import('./db.js')).default;
const groupsRouter     = (await import('./routes/groups.js')).default;
const recurringRouter  = (await import('./routes/recurring-campaigns.js')).default;
const scheduleRouter   = (await import('./routes/schedule.js')).default;

const app = express();
app.use(express.json());
app.use('/api/groups', groupsRouter);
app.use('/api/recurring-campaigns', recurringRouter);
app.use('/api/schedule', scheduleRouter);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const req = async (method, path, body) => {
  const opts = { method };
  if (body !== undefined) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const mkGroup = async (name) => (await req('POST', '/api/groups', { name })).body;

// Add a member so a groups-mode recurring campaign isn't auto-"completed" (empty
// pool) by the applyRecurringCampaigns() call that POST/PUT triggers — keeps it
// active/paused for the deletion-guard assertions, in both queue modes.
let seq = 0;
async function addMember(groupId) {
  const cid = Number(db.prepare("INSERT INTO contacts (firstName,lastName,email,status) VALUES ('T','U',?, 'pending')")
    .run(`gt-${Date.now()}-${seq++}@example.com`).lastInsertRowid);
  await req('POST', `/api/groups/${groupId}/members`, { contactIds: [cid] });
  return cid;
}

// ── Recurring campaign targeting ────────────────────────────────────────────────
test('recurring: default target_mode is all when omitted', async () => {
  const r = await req('POST', '/api/recurring-campaigns', { name: 'RT-default', subject: 'S', html: '<p>x</p>' });
  assert.equal(r.status, 201);
  assert.equal(r.body.target_mode, 'all');
  assert.deepEqual(r.body.groupIds, []);
});

test('recurring: groups mode requires at least one group', async () => {
  const r = await req('POST', '/api/recurring-campaigns', { name: 'RT-empty', subject: 'S', html: '<p>x</p>', target_mode: 'groups', groupIds: [] });
  assert.equal(r.status, 400);
});

test('recurring: groups mode stores group targeting; GET returns groupIds', async () => {
  const g = await mkGroup('RT-G1');
  const r = await req('POST', '/api/recurring-campaigns', { name: 'RT-grp', subject: 'S', html: '<p>x</p>', target_mode: 'groups', groupIds: [g.id] });
  assert.equal(r.status, 201);
  assert.equal(r.body.target_mode, 'groups');
  assert.deepEqual(r.body.groupIds, [g.id]);

  const list = await req('GET', '/api/recurring-campaigns');
  const row = list.body.find((c) => c.id === r.body.id);
  assert.deepEqual(row.groupIds, [g.id]);
});

test('recurring: editing to groups with no groups is rejected; switching to all clears groups', async () => {
  const g = await mkGroup('RT-G2');
  const c = (await req('POST', '/api/recurring-campaigns', { name: 'RT-edit', subject: 'S', html: '<p>x</p>', target_mode: 'groups', groupIds: [g.id] })).body;

  const bad = await req('PUT', `/api/recurring-campaigns/${c.id}`, { target_mode: 'groups', groupIds: [] });
  assert.equal(bad.status, 400);

  const toAll = await req('PUT', `/api/recurring-campaigns/${c.id}`, { target_mode: 'all' });
  assert.equal(toAll.status, 200);
  assert.equal(toAll.body.target_mode, 'all');
  assert.deepEqual(toAll.body.groupIds, []); // membership cleared
});

// ── Daily batch targeting ─────────────────────────────────────────────────────
test('daily batch: enabling group mode with no groups is rejected', async () => {
  const r = await req('POST', '/api/schedule', { enabled: true, target_mode: 'groups', groupIds: [] });
  assert.equal(r.status, 400);
});

test('daily batch: group mode stores groups and GET returns them', async () => {
  const g = await mkGroup('DB-G1');
  const r = await req('POST', '/api/schedule', { enabled: true, target_mode: 'groups', groupIds: [g.id] });
  assert.equal(r.status, 200);
  assert.equal(r.body.target_mode, 'groups');
  assert.deepEqual(r.body.groupIds, [g.id]);

  const get = await req('GET', '/api/schedule');
  assert.deepEqual(get.body.groupIds, [g.id]);
});

// ── Group deletion safety ─────────────────────────────────────────────────────
test('delete: 409 when targeted by an active recurring campaign, with usage info', async () => {
  const g = await mkGroup('DEL-active');
  await addMember(g.id); // keep the campaign active (non-empty pool)
  const c = (await req('POST', '/api/recurring-campaigns', { name: 'DEL-rc', subject: 'S', html: '<p>x</p>', target_mode: 'groups', groupIds: [g.id] })).body;

  const del = await req('DELETE', `/api/groups/${g.id}`);
  assert.equal(del.status, 409);
  assert.equal(del.body.usages.recurring.length, 1);
  assert.equal(del.body.usages.recurring[0].id, c.id);
});

test('delete: completed recurring campaign does NOT block deletion', async () => {
  const g = await mkGroup('DEL-completed');
  const c = (await req('POST', '/api/recurring-campaigns', { name: 'DEL-done', subject: 'S', html: '<p>x</p>', target_mode: 'groups', groupIds: [g.id] })).body;
  db.prepare("UPDATE recurring_campaigns SET status='completed' WHERE id=?").run(c.id);

  const del = await req('DELETE', `/api/groups/${g.id}`);
  assert.equal(del.status, 200);
  // its stale junction row was cleaned up
  assert.equal(db.prepare('SELECT COUNT(*) n FROM recurring_campaign_groups WHERE group_id=?').get(g.id).n, 0);
});

test('delete ?detach=true: detaches, pauses emptied campaign, reports it', async () => {
  const g = await mkGroup('DEL-detach');
  await addMember(g.id); // keep the campaign active so detach can pause it
  const c = (await req('POST', '/api/recurring-campaigns', { name: 'DEL-pauseme', subject: 'S', html: '<p>x</p>', target_mode: 'groups', groupIds: [g.id] })).body;

  const del = await req('DELETE', `/api/groups/${g.id}?detach=true`);
  assert.equal(del.status, 200);
  assert.equal(del.body.detached, true);
  assert.ok(del.body.paused.some((p) => p.id === c.id));
  assert.equal(db.prepare('SELECT status FROM recurring_campaigns WHERE id=?').get(c.id).status, 'paused');
});

test('delete ?detach=true: disables a group-mode daily batch left with zero groups', async () => {
  const g = await mkGroup('DEL-db');
  await req('POST', '/api/schedule', { enabled: true, target_mode: 'groups', groupIds: [g.id] });

  const del = await req('DELETE', `/api/groups/${g.id}?detach=true`);
  assert.equal(del.status, 200);
  assert.equal(del.body.dailyBatchDisabled, true);
  assert.equal(db.prepare('SELECT enabled FROM schedule_config WHERE id=1').get().enabled, 0);
});

test('delete: an unreferenced group deletes without detach', async () => {
  const g = await mkGroup('DEL-free');
  const del = await req('DELETE', `/api/groups/${g.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.detached, false);
});
