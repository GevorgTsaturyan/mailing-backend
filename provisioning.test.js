// Controller-side provisioning verification tests: apply node reports, enforce
// ownership, transition rules, and the job creation/dispatch readiness gate.
// In-memory DB; bare Express app mounting the real nodes router.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.UNSUBSCRIBE_SECRET ||= 'test-unsubscribe-secret';
process.env.DB_PATH            ||= ':memory:';
process.env.UNSUBSCRIBE_REQUIRE_READY ||= 'false'; // gate under test in unsubscribe-readiness.test.js

const db                 = (await import('./db.js')).default;
const nodesRouter        = (await import('./routes/nodes.js')).default;
const senderIdentitiesRouter = (await import('./routes/sender-identities.js')).default;
const JobService         = await import('./services/JobService.js');
const { findNextPending, identitySendable } = await import('./services/JobRepository.js');

const app = express();
app.use(express.json());
app.use('/api/nodes', nodesRouter);
app.use('/api/sender-identities', senderIdentitiesRouter);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

// ── Fixtures: two nodes, identities owned respectively ────────────────────────
const now = new Date().toISOString();
const KEY_A = 'PROV-KEY-A', KEY_B = 'PROV-KEY-B';
const mkServer = (k) => Number(db.prepare("INSERT INTO servers (label, apiKey, status, createdAt) VALUES (?,?, 'online', ?)").run('n-' + k, k, now).lastInsertRowid);
const mkIdentity = (serverId, domain, ip, status = 'active', vstatus = 'unverified') => Number(db.prepare(
  `INSERT INTO sender_identities (serverId, domain, ip, fromAddr, fromName, dkimSelector, status, verificationStatus, dailyLimit, dailySentCount, createdAt)
   VALUES (?, ?, ?, ?, 'S', 'mail', ?, ?, 1000, 0, ?)`
).run(serverId, domain, ip, `s@${domain}`, status, vstatus, now).lastInsertRowid);

const serverA = mkServer(KEY_A);
const serverB = mkServer(KEY_B);
const idA  = mkIdentity(serverA, 'serawin.net', '149.202.93.154');
const idA2 = mkIdentity(serverA, 'domain2.example', '203.0.113.7');
const idB  = mkIdentity(serverB, 'example.net', '198.51.100.5');

const vstatus = (id) => db.prepare('SELECT verificationStatus FROM sender_identities WHERE id=?').get(id)?.verificationStatus;
const report = (apiKey, reports) => fetch(`${BASE}/api/nodes/provisioning-report`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ apiKey, reports }),
}).then(async (res) => ({ status: res.status, body: await res.json() }));

const READY = (id, domain, ip) => ({ identityId: id, domain, ip, selector: 'mail', hostname: `mail.${domain}`, status: 'READY', reasons: [] });

// ── Report application + job-creation gate ────────────────────────────────────

test('unverified identity cannot create a job; READY report unlocks it', async () => {
  // Before verification: creation is refused.
  assert.equal(identitySendable(idA), false);
  assert.throws(() => JobService.createJob({ identity_id: idA, recipient: 'u@x.com', subject: 'Hi' }), /verified|READY/i);

  // Node A reports READY for its own identity.
  const res = await report(KEY_A, [READY(idA, 'serawin.net', '149.202.93.154')]);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.applied, [{ identityId: idA, status: 'READY' }]);
  assert.equal(vstatus(idA), 'READY');

  // Now creation succeeds.
  assert.equal(identitySendable(idA), true);
  assert.ok(JobService.createJob({ identity_id: idA, recipient: 'u@x.com', subject: 'Hi' }).id);
});

// ── Dispatch gate: unverified identity's jobs are never polled ───────────────
test('dispatch gate — a job for a non-READY identity is never returned by poll', () => {
  // Isolate from jobs left PENDING by earlier tests.
  db.prepare("UPDATE jobs SET status='CANCELLED' WHERE status='PENDING'").run();
  // idA2 is still unverified. Insert a PENDING job directly (bypassing createJob).
  db.prepare("INSERT INTO jobs (status, identity_id, recipient, subject, body, content_type, created_at) VALUES ('PENDING', ?, 'r@x.com', 'Hi', 'Hi', 'html', ?)").run(idA2, now);
  assert.equal(findNextPending(serverA), null, 'unverified identity → job withheld');

  // Mark READY → now dispatchable to its owner.
  db.prepare("UPDATE sender_identities SET verificationStatus='READY' WHERE id=?").run(idA2);
  const job = findNextPending(serverA);
  assert.ok(job && job.identity_id === idA2);
});

// ── Security: ownership enforcement (§11, §12, §23) ───────────────────────────
test('a node cannot verify an identity it does not own (rejected, no change)', async () => {
  // Node B tries to report Node A's identity.
  const before = vstatus(idB);
  const res = await report(KEY_B, [READY(idA, 'serawin.net', '149.202.93.154')]);
  assert.equal(res.status, 200);
  assert.equal(res.body.applied.length, 0);
  assert.equal(res.body.rejected.length, 1);
  assert.match(res.body.rejected[0].reason, /not owned/i);
  // idA readiness unchanged by B's report; idB unchanged.
  assert.equal(vstatus(idB), before);
});

test('server identity comes from apiKey, not the body (no serverId spoofing)', async () => {
  // Even if a body tried to carry a serverId, the route ignores it; auth = apiKey.
  const res = await report(KEY_B, [{ ...READY(idA, 'serawin.net', '149.202.93.154'), serverId: serverA }]);
  assert.equal(res.body.applied.length, 0, 'B still cannot touch A\'s identity');
});

test('invalid apiKey is rejected', async () => {
  const res = await fetch(`${BASE}/api/nodes/provisioning-report`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: 'nope', reports: [] }),
  });
  assert.equal(res.status, 401);
});

// ── Transition rules ──────────────────────────────────────────────────────────
test('DNS_UNAVAILABLE does NOT downgrade a proven READY identity', async () => {
  await report(KEY_A, [READY(idA, 'serawin.net', '149.202.93.154')]);
  assert.equal(vstatus(idA), 'READY');
  const res = await report(KEY_A, [{ identityId: idA, status: 'DNS_UNAVAILABLE', reasons: ['PTR lookup unavailable'] }]);
  assert.equal(res.body.applied[0].status, 'READY', 'transient DNS keeps proven READY');
  assert.equal(vstatus(idA), 'READY');
});

test('a definite NOT_READY downgrades and blocks sending again', async () => {
  await report(KEY_A, [READY(idA, 'serawin.net', '149.202.93.154')]);
  assert.equal(identitySendable(idA), true);
  await report(KEY_A, [{ identityId: idA, status: 'NOT_READY', reasons: ['DKIM private key missing'] }]);
  assert.equal(vstatus(idA), 'NOT_READY');
  assert.equal(identitySendable(idA), false);
  assert.throws(() => JobService.createJob({ identity_id: idA, recipient: 'u@x.com', subject: 'Hi' }), /verified|READY/i);
  await report(KEY_A, [READY(idA, 'serawin.net', '149.202.93.154')]); // restore for other tests
});

test('repeated identical report is idempotent', async () => {
  const r1 = await report(KEY_A, [READY(idA, 'serawin.net', '149.202.93.154')]);
  const r2 = await report(KEY_A, [READY(idA, 'serawin.net', '149.202.93.154')]);
  assert.deepEqual(r1.body.applied, r2.body.applied);
  assert.equal(vstatus(idA), 'READY');
});

test('multiple owned identities verify independently in one report', async () => {
  const res = await report(KEY_A, [
    READY(idA, 'serawin.net', '149.202.93.154'),
    READY(idA2, 'domain2.example', '203.0.113.7'),
  ]);
  assert.equal(res.body.applied.length, 2);
  assert.equal(vstatus(idA), 'READY');
  assert.equal(vstatus(idA2), 'READY');
});

// ── Bypass: mutating verified attributes must reset verification ─────────────
test('changing a verified identity\'s ip/domain/selector resets it to unverified', async () => {
  await report(KEY_A, [READY(idA, 'serawin.net', '149.202.93.154')]);
  assert.equal(identitySendable(idA), true);

  // Admin changes the source IP → prior node proof no longer applies.
  const res = await fetch(`${BASE}/api/sender-identities/${idA}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ip: '203.0.113.222' }),
  });
  assert.equal(res.status, 200);
  assert.equal(vstatus(idA), 'unverified', 'verification invalidated on IP change');
  assert.equal(identitySendable(idA), false, 'cannot send until re-verified');

  // A pure metadata change (fromName) must NOT reset a proven identity.
  await report(KEY_A, [READY(idA, 'serawin.net', '203.0.113.222')]);
  assert.equal(vstatus(idA), 'READY');
  await fetch(`${BASE}/api/sender-identities/${idA}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fromName: 'New Name' }),
  });
  assert.equal(vstatus(idA), 'READY', 'cosmetic change keeps verification');
});

test('verificationStatus cannot be set through the identity API (node-proven only)', async () => {
  db.prepare("UPDATE sender_identities SET verificationStatus='unverified' WHERE id=?").run(idB);
  await fetch(`${BASE}/api/sender-identities/${idB}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verificationStatus: 'READY', status: 'active' }),
  });
  assert.equal(vstatus(idB), 'unverified', 'API must not let an admin mark an identity verified');
});

// ── No secrets stored ─────────────────────────────────────────────────────────
test('no secret columns exist on sender_identities (only safe metadata stored)', () => {
  const cols = db.prepare('PRAGMA table_info(sender_identities)').all().map((c) => c.name);
  for (const c of ['verificationStatus', 'lastVerifiedAt', 'verificationReasons', 'verifiedIpv4', 'verifiedHostname', 'verifiedDkimSelector']) {
    assert.ok(cols.includes(c), `column ${c} present`);
  }
  // Sanity: we never added a column that would hold key material.
  assert.equal(cols.some((c) => /private|key_material|secret/i.test(c)), false);
});
