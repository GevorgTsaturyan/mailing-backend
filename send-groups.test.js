// Phase 2 — group selection as an additional recipient source for manual send
// and one-off scheduled sends. In-memory DB; bare Express apps mounting the
// send + scheduled-sends + groups routers. Assertions are mode-agnostic (count
// jobs across both queue tables) so this file passes with USE_CANONICAL_QUEUE
// on and off.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.DB_PATH ||= ':memory:';
// leave USE_CANONICAL_QUEUE unset → legacy send_jobs path

const db                 = (await import('./db.js')).default;
const sendRouter         = (await import('./routes/send.js')).default;
const scheduledRouter    = (await import('./routes/scheduled-sends.js')).default;
const groupsRouter       = (await import('./routes/groups.js')).default;

const app = express();
app.use(express.json());
app.use('/api/send', sendRouter);
app.use('/api/scheduled-sends', scheduledRouter);
app.use('/api/groups', groupsRouter);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

// An active, READY identity so the legacy path will actually queue.
const now = new Date().toISOString();
const serverId = Number(db.prepare(
  "INSERT INTO servers (label, apiKey, status, createdAt) VALUES ('node','KEY-SEND-GROUPS','online',?)"
).run(now).lastInsertRowid);
db.prepare(
  `INSERT INTO sender_identities (serverId, domain, ip, fromAddr, fromName, status, verificationStatus, dailyLimit, dailySentCount, createdAt)
   VALUES (?, 'serawin.net', '1.2.3.4', 'support@serawin.net', 'Support', 'active', 'READY', 100000, 0, ?)`
).run(serverId, now);

const req = async (method, path, body) => {
  const opts = { method };
  if (body !== undefined) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

let seq = 0;
function newContact(status = 'pending') {
  const email = `sg-${Date.now()}-${seq++}@example.com`;
  const id = Number(db.prepare(
    "INSERT INTO contacts (firstName, lastName, email, status) VALUES ('T','User',?,?)"
  ).run(email, status).lastInsertRowid);
  return { id, email };
}
const mkGroup = async (name, contactIds = []) => {
  const g = (await req('POST', '/api/groups', { name })).body;
  if (contactIds.length) await req('POST', `/api/groups/${g.id}/members`, { contactIds });
  return g;
};
// Mode-agnostic: count jobs in whichever table the active queue mode uses.
const legacyJobCount = (cid) =>
  db.prepare('SELECT COUNT(*) n FROM send_jobs WHERE contactId=?').get(cid).n +
  db.prepare('SELECT COUNT(*) n FROM jobs WHERE contact_id=?').get(cid).n;

// ── Manual send ────────────────────────────────────────────────────────────────
test('manual send: groups-only request queues each group member once', async () => {
  const a = newContact(), b = newContact();
  const g = await mkGroup('SG-only', [a.id, b.id]);

  const r = await req('POST', '/api/send', { groupIds: [g.id], subject: 'Hi', html: '<p>x</p>' });
  assert.equal(r.status, 200);
  const queued = r.body.results.filter((x) => x.status === 'queued').map((x) => x.id).sort();
  assert.deepEqual(queued, [a.id, b.id].sort());
  assert.equal(legacyJobCount(a.id), 1);
  assert.equal(legacyJobCount(b.id), 1);
});

test('manual send: contacts + groups union dedups an overlapping contact to ONE job', async () => {
  const shared = newContact(), onlyGroup = newContact();
  const g = await mkGroup('SG-union', [shared.id, onlyGroup.id]);

  // `shared` is passed both explicitly and via the group
  const r = await req('POST', '/api/send', { contactIds: [shared.id], groupIds: [g.id], subject: 'Hi', html: '<p>x</p>' });
  assert.equal(r.status, 200);
  const queuedIds = r.body.results.filter((x) => x.status === 'queued').map((x) => x.id).sort();
  assert.deepEqual(queuedIds, [shared.id, onlyGroup.id].sort());
  // exactly one job for the overlapping contact — no double-queue within the op
  assert.equal(legacyJobCount(shared.id), 1);
});

test('manual send: no groupIds behaves exactly as before', async () => {
  const a = newContact();
  const r = await req('POST', '/api/send', { contactIds: [a.id], subject: 'Hi', html: '<p>x</p>' });
  assert.equal(r.status, 200);
  assert.equal(r.body.results.length, 1);
  assert.equal(r.body.results[0].status, 'queued');
});

test('manual send: empty effective set → 400', async () => {
  const r = await req('POST', '/api/send', { contactIds: [], groupIds: [], subject: 'Hi', html: '<p>x</p>' });
  assert.equal(r.status, 400);
});

test('manual send: unknown group id is ignored, explicit contact still queues', async () => {
  const a = newContact();
  const r = await req('POST', '/api/send', { contactIds: [a.id], groupIds: [987654], subject: 'Hi', html: '<p>x</p>' });
  assert.equal(r.status, 200);
  assert.equal(r.body.results.filter((x) => x.status === 'queued').length, 1);
});

test('manual send: in-flight guard still skips an already-queued contact', async () => {
  const a = newContact();
  const g = await mkGroup('SG-inflight', [a.id]);
  const first  = await req('POST', '/api/send', { groupIds: [g.id], subject: 'Hi', html: '<p>x</p>' });
  assert.equal(first.body.results[0].status, 'queued');
  // second send while the first job is still 'queued' → skipped, not double-queued
  const second = await req('POST', '/api/send', { groupIds: [g.id], subject: 'Hi', html: '<p>x</p>' });
  assert.equal(second.body.results[0].status, 'skipped');
  assert.equal(legacyJobCount(a.id), 1);
});

// ── One-off scheduled send ───────────────────────────────────────────────────────
const snapshotOf = (id) => JSON.parse(db.prepare('SELECT contactIds FROM scheduled_sends WHERE id=?').get(id).contactIds);

test('scheduled send: groups resolve to a distinct snapshot at creation', async () => {
  const a = newContact(), b = newContact();
  const g = await mkGroup('SG-sched', [a.id, b.id]);

  const r = await req('POST', '/api/scheduled-sends', {
    groupIds: [g.id], scheduledAt: new Date().toISOString(), subject: 'Hi', html: '<p>x</p>',
  });
  assert.equal(r.status, 201);
  assert.deepEqual(snapshotOf(r.body.id).sort(), [a.id, b.id].sort());
});

test('scheduled send: contacts + groups union deduped in the snapshot', async () => {
  const shared = newContact(), extra = newContact();
  const g = await mkGroup('SG-sched-union', [shared.id, extra.id]);

  const r = await req('POST', '/api/scheduled-sends', {
    contactIds: [shared.id], groupIds: [g.id],
    scheduledAt: new Date().toISOString(), subject: 'Hi', html: '<p>x</p>',
  });
  assert.equal(r.status, 201);
  const snap = snapshotOf(r.body.id).sort();
  assert.deepEqual(snap, [shared.id, extra.id].sort()); // shared appears once
});

test('scheduled send: membership change after creation does NOT alter the snapshot', async () => {
  const a = newContact();
  const g = await mkGroup('SG-frozen', [a.id]);
  const r = await req('POST', '/api/scheduled-sends', {
    groupIds: [g.id], scheduledAt: new Date().toISOString(), subject: 'Hi', html: '<p>x</p>',
  });
  const b = newContact();
  await req('POST', `/api/groups/${g.id}/members`, { contactIds: [b.id] });
  assert.deepEqual(snapshotOf(r.body.id), [a.id]); // still just the original member
});

test('scheduled send: no groupIds behaves exactly as before', async () => {
  const a = newContact();
  const r = await req('POST', '/api/scheduled-sends', {
    contactIds: [a.id], scheduledAt: new Date().toISOString(), subject: 'Hi', html: '<p>x</p>',
  });
  assert.equal(r.status, 201);
  assert.deepEqual(snapshotOf(r.body.id), [a.id]);
});

test('scheduled send: empty effective set → 400', async () => {
  const r = await req('POST', '/api/scheduled-sends', {
    groupIds: [], scheduledAt: new Date().toISOString(), subject: 'Hi', html: '<p>x</p>',
  });
  assert.equal(r.status, 400);
});
