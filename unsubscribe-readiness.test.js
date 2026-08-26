// Unsubscribe-host readiness gate — controller side.
// Campaign (contact-bound) jobs advertise the List-Unsubscribe URL in every email;
// they must NEVER be dispatched while that host is unverified (a dead unsubscribe
// endpoint funnels recipients to "Report spam"). Raw jobs carry no unsubscribe
// URL and stay dispatchable. Jobs are withheld, never failed — dispatch resumes
// automatically once the host verifies.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.UNSUBSCRIBE_SECRET        ||= 'test-unsubscribe-secret';
process.env.DB_PATH                   ||= ':memory:';
process.env.UNSUBSCRIBE_REQUIRE_READY   = 'true'; // the gate itself is under test

const db                = (await import('./db.js')).default;
const nodesRouter       = (await import('./routes/nodes.js')).default;
const unsubscribeRouter = (await import('./routes/unsubscribe.js')).default;
const { poll }          = await import('./services/PollingService.js');
const JobService        = await import('./services/JobService.js');
const Readiness         = await import('./services/UnsubscribeHostReadiness.js');

const app = express();
app.use(express.json());
app.use('/api/nodes', nodesRouter);
app.use(unsubscribeRouter);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

// ── Fixtures ──────────────────────────────────────────────────────────────────
const now = new Date().toISOString();
const KEY = 'UNSUB-GATE-KEY';
const serverId = Number(db.prepare(
  "INSERT INTO servers (label, apiKey, status, createdAt) VALUES ('unsub-gate', ?, 'online', ?)"
).run(KEY, now).lastInsertRowid);
const identityId = Number(db.prepare(
  `INSERT INTO sender_identities (serverId, domain, ip, fromAddr, fromName, dkimSelector, status, verificationStatus, dailyLimit, dailySentCount, createdAt)
   VALUES (?, 'serawin.net', '1.2.3.4', 's@serawin.net', 'S', 'mail', 'active', 'READY', 1000, 0, ?)`
).run(serverId, now).lastInsertRowid);

let seq = 0;
function mkContact() {
  const email = `ur-${Date.now()}-${seq++}@example.com`;
  return Number(db.prepare(
    "INSERT INTO contacts (firstName,lastName,email,status) VALUES ('T','U',?, 'pending')"
  ).run(email).lastInsertRowid);
}
function mkPendingJob(contactId = null, priority = 0) {
  return Number(db.prepare(
    "INSERT INTO jobs (status, identity_id, recipient, subject, body, content_type, contact_id, priority, created_at) VALUES ('PENDING', ?, 'r@x.com', 'Hi', 'Hi', 'html', ?, ?, ?)"
  ).run(identityId, contactId, priority, now).lastInsertRowid);
}
const jobRow  = (id) => db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
const cancel  = (id) => db.prepare("UPDATE jobs SET status='CANCELLED' WHERE id=?").run(id);

// ── Fail-closed default ───────────────────────────────────────────────────────
test('allowDispatch is FALSE before any successful probe (fail-closed)', () => {
  assert.equal(Readiness.isReady(), false);
  assert.equal(Readiness.allowDispatch(), false);
});

// ── Health endpoint (probe target) ────────────────────────────────────────────
test('GET /unsubscribe-health answers 200 {ok:true} with no-store', async () => {
  const res = await fetch(`${BASE}/unsubscribe-health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { ok: true });
});

// ── verify(): public probe, hairpin fallback ──────────────────────────────────
test('verify: public 200 → ready via public', async () => {
  const r = await Readiness.verify(async () => ({ status: 200 }));
  assert.equal(r.ready, true);
  assert.equal(r.via, 'public');
  assert.equal(Readiness.isReady(), true);
});

test('verify: public fails, local 200 → ready via hairpin fallback', async () => {
  const r = await Readiness.verify(async (url) => {
    if (String(url).startsWith('https://')) throw new Error('ENOTFOUND');
    return { status: 200 };
  });
  assert.equal(r.ready, true);
  assert.equal(r.via, 'local-fallback');
});

test('verify: both probes fail → not ready, dispatch withheld', async () => {
  const r = await Readiness.verify(async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(r.ready, false);
  assert.equal(Readiness.allowDispatch(), false);
});

// ── Canonical dispatch gate: poll ─────────────────────────────────────────────
test('poll withholds contact-bound jobs while not ready; raw jobs still flow', () => {
  Readiness._setReady(false);
  const campaignJob = mkPendingJob(mkContact(), 5); // higher priority than the raw job
  const rawJob      = mkPendingJob(null, 0);

  const j = poll(serverId);
  assert.ok(j, 'a job is still returned');
  assert.equal(j.id, rawJob, 'the raw job is dispatched, the campaign job is withheld');
  assert.equal(jobRow(campaignJob).status, 'PENDING', 'campaign job stays PENDING (withheld, not failed)');

  cancel(rawJob);
  Readiness._setReady(true);
  const j2 = poll(serverId);
  assert.equal(j2?.id, campaignJob, 'campaign dispatch resumes once the host is ready');
  cancel(campaignJob);
});

// ── Canonical dispatch gate: startJob (claim-time defense in depth) ───────────
test('startJob refuses (409) a contact-bound job while not ready; job stays PENDING', () => {
  Readiness._setReady(false);
  const jid = mkPendingJob(mkContact());

  const res = JobService.startJob(jid, serverId);
  assert.equal(res.status, 409);
  assert.match(res.error, /unsubscribe host/i);
  assert.equal(jobRow(jid).status, 'PENDING', 'not consumed, not failed');

  Readiness._setReady(true);
  const ok = JobService.startJob(jid, serverId);
  assert.equal(ok.ok, true, 'claim succeeds once the host is ready');
  cancel(jid);
});

test('startJob still claims RAW jobs while not ready (they carry no List-Unsubscribe)', () => {
  Readiness._setReady(false);
  const jid = mkPendingJob(null);
  const res = JobService.startJob(jid, serverId);
  assert.equal(res.ok, true);
  cancel(jid);
  Readiness._setReady(true);
});

// ── Legacy dispatch gate: GET /api/nodes/jobs ─────────────────────────────────
test('legacy /api/nodes/jobs returns [] while not ready; jobs stay queued, resume when ready', async () => {
  const sjId = Number(db.prepare(
    "INSERT INTO send_jobs (senderIdentityId, contactId, email, status, createdAt) VALUES (?, ?, 'x@x.com', 'queued', ?)"
  ).run(identityId, mkContact(), now).lastInsertRowid);

  Readiness._setReady(false);
  let res = await fetch(`${BASE}/api/nodes/jobs?apiKey=${KEY}&limit=50`);
  assert.deepEqual((await res.json()).jobs, []);
  assert.equal(db.prepare('SELECT status FROM send_jobs WHERE id=?').get(sjId).status, 'queued',
    'legacy job withheld, not claimed/cancelled');

  Readiness._setReady(true);
  res = await fetch(`${BASE}/api/nodes/jobs?apiKey=${KEY}&limit=50`);
  const { jobs } = await res.json();
  assert.ok(jobs.some((j) => j.id === sjId), 'legacy dispatch resumes once the host is ready');
  db.prepare("UPDATE send_jobs SET status='cancelled' WHERE id=?").run(sjId);
});

// ── Escape hatch ──────────────────────────────────────────────────────────────
test('UNSUBSCRIBE_REQUIRE_READY=false disables the gate (dev/test only)', () => {
  Readiness._setReady(false);
  process.env.UNSUBSCRIBE_REQUIRE_READY = 'false';
  assert.equal(Readiness.allowDispatch(), true);
  process.env.UNSUBSCRIBE_REQUIRE_READY = 'true';
  assert.equal(Readiness.allowDispatch(), false);
  Readiness._setReady(true);
});
