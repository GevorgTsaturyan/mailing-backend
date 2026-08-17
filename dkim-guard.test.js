// OpenDKIM runtime failure guard — controller side.
// Signer-health dispatch gate + temporary-failure retry FSM (no permanent
// job/contact failure on an infrastructure/signing outage).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.UNSUBSCRIBE_SECRET ||= 'test-unsubscribe-secret';
process.env.DB_PATH            ||= ':memory:';

const db               = (await import('./db.js')).default;
const nodesRouter      = (await import('./routes/nodes.js')).default;
const jobsRouter       = (await import('./routes/jobs.js')).default;
const { recordHeartbeat, deriveSignerHealth } = await import('./services/HeartbeatService.js');
const { isSignerHealthy } = await import('./services/NodeRepository.js');
const { poll }         = await import('./services/PollingService.js');
const JobService       = await import('./services/JobService.js');

const app = express();
app.use(express.json());
app.use('/api/nodes', nodesRouter);
app.use('/api/jobs', jobsRouter);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

// ── Fixtures ──────────────────────────────────────────────────────────────────
const now = new Date().toISOString();
const KEY_A = 'DKIM-KEY-A', KEY_B = 'DKIM-KEY-B';
const mkServer = (k) => Number(db.prepare("INSERT INTO servers (label, apiKey, status, createdAt) VALUES (?,?, 'online', ?)").run('n-' + k, k, now).lastInsertRowid);
const serverA = mkServer(KEY_A);
const serverB = mkServer(KEY_B);
const identityId = Number(db.prepare(
  `INSERT INTO sender_identities (serverId, domain, ip, fromAddr, fromName, dkimSelector, status, verificationStatus, dailyLimit, dailySentCount, createdAt)
   VALUES (?, 'serawin.net', '1.2.3.4', 's@serawin.net', 'S', 'mail', 'active', 'READY', 1000, 0, ?)`
).run(serverA, now).lastInsertRowid);

let seq = 0;
function mkContact() {
  const email = `dg-${Date.now()}-${seq++}@example.com`;
  const id = Number(db.prepare("INSERT INTO contacts (firstName,lastName,email,status) VALUES ('T','U',?, 'pending')").run(email).lastInsertRowid);
  return { id, email };
}
function mkPendingJob(contactId = null) {
  return Number(db.prepare(
    "INSERT INTO jobs (status, identity_id, recipient, subject, body, content_type, contact_id, created_at) VALUES ('PENDING', ?, 'r@x.com', 'Hi', 'Hi', 'html', ?, ?)"
  ).run(identityId, contactId, now).lastInsertRowid);
}
const jobRow = (id) => db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
const setHealth = (serverId, v) => db.prepare('UPDATE servers SET openDkimHealthy=? WHERE id=?').run(v, serverId);

// ── deriveSignerHealth ────────────────────────────────────────────────────────
test('deriveSignerHealth: running+socket → 1, either down → 0, unknown → null', () => {
  assert.equal(deriveSignerHealth({ opendkim_running: true, opendkim_socket_ok: true }), 1);
  assert.equal(deriveSignerHealth({ opendkim_running: true, opendkim_socket_ok: false }), 0);
  assert.equal(deriveSignerHealth({ opendkim_running: false }), 0);
  assert.equal(deriveSignerHealth({ opendkim_running: true }), 1); // socket unknown, service up → healthy
  assert.equal(deriveSignerHealth({}), null);
});

test('isSignerHealthy: 0 → false; 1/NULL → true (permissive on unknown)', () => {
  setHealth(serverA, 1); assert.equal(isSignerHealthy(serverA), true);
  setHealth(serverA, 0); assert.equal(isSignerHealthy(serverA), false);
  setHealth(serverA, null); assert.equal(isSignerHealthy(serverA), true);
});

// ── Dispatch gate: poll / claim / legacy ─────────────────────────────────────
test('poll withholds jobs when the signer is down, resumes when healthy', () => {
  const jid = mkPendingJob();
  setHealth(serverA, 0);
  assert.equal(poll(serverA), null, 'no jobs handed out while OpenDKIM down');
  setHealth(serverA, 1);
  const job = poll(serverA);
  assert.ok(job && job.id === jid);
  // cleanup
  db.prepare("UPDATE jobs SET status='CANCELLED' WHERE id=?").run(jid);
});

test('startJob is refused (409) when the signer is down', () => {
  const jid = mkPendingJob();
  setHealth(serverA, 0);
  const res = JobService.startJob(jid, serverA);
  assert.equal(res.status, 409);
  assert.match(res.error, /signer|OpenDKIM/i);
  assert.equal(jobRow(jid).status, 'PENDING', 'job stays PENDING, not consumed');
  setHealth(serverA, 1);
  db.prepare("UPDATE jobs SET status='CANCELLED' WHERE id=?").run(jid);
});

test('legacy /api/nodes/jobs returns nothing when the signer is down', async () => {
  db.prepare("INSERT INTO send_jobs (senderIdentityId, email, status, createdAt) VALUES (?, 'x@x.com', 'queued', ?)").run(identityId, now);
  setHealth(serverA, 0);
  const res = await fetch(`${BASE}/api/nodes/jobs?apiKey=${KEY_A}&limit=50`);
  const body = await res.json();
  assert.deepEqual(body.jobs, []);
  setHealth(serverA, 1);
});

// ── Retry FSM: temporary failure requeues, does not fail contact ─────────────
test('retryJob requeues PROCESSING → PENDING with backoff; contact untouched', () => {
  setHealth(serverA, 1);
  const c = mkContact();
  const jid = mkPendingJob(c.id);
  assert.equal(JobService.startJob(jid, serverA).ok, true);
  assert.equal(jobRow(jid).status, 'PROCESSING');
  const attemptsBefore = jobRow(jid).attempts;

  const res = JobService.retryJob(jid, serverA);
  assert.equal(res.requeued, true);
  const j = jobRow(jid);
  assert.equal(j.status, 'PENDING', 'requeued, not failed');
  assert.equal(j.node_id, null, 'ownership cleared for re-claim');
  assert.ok(j.scheduled_for && j.scheduled_for > now, 'backoff scheduled_for set');
  assert.equal(j.attempts, attemptsBefore, 'attempts preserved (bumps again on next claim)');
  // §16/§17 — the contact must NOT be marked failed by an infra/signing outage.
  assert.equal(db.prepare('SELECT status FROM contacts WHERE id=?').get(c.id).status, 'pending');
});

test('retryJob gives up (FAILED) after max attempts, still leaves contact untouched', () => {
  const c = mkContact();
  const jid = mkPendingJob(c.id);
  JobService.startJob(jid, serverA);
  db.prepare('UPDATE jobs SET attempts=10 WHERE id=?').run(jid); // at cap
  const res = JobService.retryJob(jid, serverA);
  assert.equal(res.gaveUp, true);
  assert.equal(jobRow(jid).status, 'FAILED');
  assert.equal(db.prepare('SELECT status FROM contacts WHERE id=?').get(c.id).status, 'pending', 'contact not failed even on give-up');
});

test('a node cannot retry another node\'s job', () => {
  const jid = mkPendingJob();
  JobService.startJob(jid, serverA);
  const res = JobService.retryJob(jid, serverB);
  assert.equal(res.status, 403);
  assert.equal(jobRow(jid).status, 'PROCESSING', 'unchanged by foreign retry');
});

// ── Heartbeat integration + isolation ────────────────────────────────────────
test('heartbeat sets signer health; recovery restores dispatch', () => {
  recordHeartbeat(KEY_A, { opendkim_running: false, opendkim_socket_ok: false });
  assert.equal(isSignerHealthy(serverA), false);
  recordHeartbeat(KEY_A, { opendkim_running: true, opendkim_socket_ok: true });
  assert.equal(isSignerHealthy(serverA), true);
});

test('a node cannot report another node\'s signer health (heartbeat keyed by apiKey)', () => {
  recordHeartbeat(KEY_A, { opendkim_running: true, opendkim_socket_ok: true });   // A healthy
  recordHeartbeat(KEY_B, { opendkim_running: false, opendkim_socket_ok: false }); // B down
  assert.equal(isSignerHealthy(serverA), true, 'B\'s heartbeat must not affect A');
  assert.equal(isSignerHealthy(serverB), false);
});
