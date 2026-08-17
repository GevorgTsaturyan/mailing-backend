// Multi-node identity/job ownership isolation tests.
// Invariant: a job can only be polled/claimed by the mail node that owns the
// exact sending identity associated with that job.
//
// In-memory DB; a bare Express app mounting the real canonical jobs router so the
// apiKey→server auth binding and the poll/start ownership path are exercised end-to-end.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.UNSUBSCRIBE_SECRET ||= 'test-unsubscribe-secret';
process.env.DB_PATH            ||= ':memory:';

const db          = (await import('./db.js')).default;
const jobsRouter  = (await import('./routes/jobs.js')).default;

const app = express();
app.use(express.json());
app.use('/api/jobs', jobsRouter);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

// ── Fixtures: two nodes, three identities (A owns two → multi-domain) ─────────
const now = new Date().toISOString();
function makeServer(apiKey) {
  return Number(db.prepare(
    "INSERT INTO servers (label, apiKey, status, createdAt) VALUES (?, ?, 'online', ?)"
  ).run('node-' + apiKey, apiKey, now).lastInsertRowid);
}
function makeIdentity(serverId, domain, status = 'active') {
  return Number(db.prepare(
    `INSERT INTO sender_identities (serverId, domain, ip, fromAddr, fromName, dkimSelector, status, verificationStatus, dailyLimit, dailySentCount, createdAt)
     VALUES (?, ?, '1.2.3.4', ?, 'Support', 'mail', ?, 'READY', 1000, 0, ?)`
  ).run(serverId, domain, `support@${domain}`, status, now).lastInsertRowid);
}
function makeJob(identityId, email = 'r@example.com') {
  return Number(db.prepare(
    "INSERT INTO jobs (status, identity_id, recipient, subject, body, content_type, created_at) VALUES ('PENDING', ?, ?, 'Hi', 'Hi', 'html', ?)"
  ).run(identityId, email, now).lastInsertRowid);
}
const jobStatus = (id) => db.prepare('SELECT status FROM jobs WHERE id=?').get(id)?.status;

const KEY_A = 'APIKEY-NODE-A';
const KEY_B = 'APIKEY-NODE-B';
const serverA = makeServer(KEY_A);
const serverB = makeServer(KEY_B);
const idA1 = makeIdentity(serverA, 'serawin.net');     // Node A
const idA2 = makeIdentity(serverA, 'domain2.example'); // Node A (second domain)
const idB1 = makeIdentity(serverB, 'example.net');     // Node B

// ── HTTP helpers (the real node protocol) ─────────────────────────────────────
async function pollAs(apiKey) {
  const res = await fetch(`${BASE}/api/jobs/poll?apiKey=${encodeURIComponent(apiKey)}`);
  return { status: res.status, job: res.status === 200 ? await res.json() : null };
}
async function startAs(apiKey, jobId) {
  const res = await fetch(`${BASE}/api/jobs/${jobId}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// Drain any jobs left PENDING by earlier tests so each poll test is deterministic.
function cancelAllPending() {
  db.prepare("UPDATE jobs SET status='CANCELLED' WHERE status='PENDING'").run();
}

// ── Test 1 — owner polls its own job → returned ──────────────────────────────
test('Test 1 — Node A receives a job for an identity it owns', async () => {
  cancelAllPending();
  const job = makeJob(idA1);
  const { status, job: got } = await pollAs(KEY_A);
  assert.equal(status, 200);
  assert.equal(got.id, job);
  // The controller supplies the authoritative sender config (task §10/§11).
  assert.equal(got.domain, 'serawin.net');
  assert.equal(got.fromAddr, 'support@serawin.net');
  assert.equal(got.dkimSelector, 'mail');
});

// ── Test 2 — non-owner polls → job NOT returned ──────────────────────────────
test('Test 2 — Node B does NOT receive Node A\'s job', async () => {
  cancelAllPending();
  makeJob(idA1);
  const { status } = await pollAs(KEY_B);
  assert.equal(status, 204, 'Node B owns no matching identity → nothing to poll');
});

// ── Test 3 — non-owner polling leaves the job PENDING ────────────────────────
test('Test 3 — repeated non-owner polls never consume the job', async () => {
  cancelAllPending();
  const job = makeJob(idA1);
  for (let i = 0; i < 3; i++) await pollAs(KEY_B);
  assert.equal(jobStatus(job), 'PENDING', 'job must remain claimable by its true owner');
});

// ── Test 4 & 5 — only the owner can claim; exactly-once ──────────────────────
test('Test 4/5 — only the owner claims; non-owner 403; double-claim 409', async () => {
  cancelAllPending();
  const job = makeJob(idA1);

  // Non-owner cannot claim, even knowing the job id.
  const bTry = await startAs(KEY_B, job);
  assert.equal(bTry.status, 403);
  assert.equal(jobStatus(job), 'PENDING');

  // Owner claims exactly once.
  const a1 = await startAs(KEY_A, job);
  assert.equal(a1.status, 200);
  assert.equal(jobStatus(job), 'PROCESSING');

  // A second claim (any node) fails — the job is no longer PENDING.
  const a2 = await startAs(KEY_A, job);
  assert.equal(a2.status, 409);
});

// ── Test 6 — job with unresolvable ownership can never become sendable ────────
// Two layers protect this: (a) the jobs.identity_id FK rejects a nonexistent
// identity at insert time; (b) a NULL identity_id (FK-permitted, e.g. a legacy/
// buggy insert) is excluded by the poll INNER JOIN and the claim ownership subquery.
test('Test 6 — nonexistent identity is rejected by FK; NULL-owner job is never claimable', async () => {
  cancelAllPending();

  // (a) A job referencing a nonexistent identity cannot even be created.
  assert.throws(() => makeJob(999999), /FOREIGN KEY/i);

  // (b) A NULL-owner job (ambiguous) is never returned and never claimable.
  const job = makeJob(null);
  assert.equal((await pollAs(KEY_A)).status, 204);
  assert.equal((await pollAs(KEY_B)).status, 204);
  assert.equal((await startAs(KEY_A, job)).status, 403, 'unowned identity → cannot claim');
  assert.equal(jobStatus(job), 'PENDING', 'stays PENDING → never sent');
});

// ── Test 7 — disabling an identity removes claimability ──────────────────────
test('Test 7 — a node cannot claim jobs for a paused identity', async () => {
  cancelAllPending();
  const job = makeJob(idA1);
  db.prepare("UPDATE sender_identities SET status='paused' WHERE id=?").run(idA1);
  try {
    assert.equal((await pollAs(KEY_A)).status, 204, 'paused identity → poll returns nothing');
    assert.equal((await startAs(KEY_A, job)).status, 403, 'paused identity → claim refused');
    assert.equal(jobStatus(job), 'PENDING');
  } finally {
    db.prepare("UPDATE sender_identities SET status='active' WHERE id=?").run(idA1); // restore
  }
  // Re-activated → claimable again.
  assert.equal((await startAs(KEY_A, job)).status, 200);
});

// ── Security — client-supplied identity cannot cross the auth binding ────────
test('Security — unknown apiKey is rejected; foreign key cannot claim', async () => {
  cancelAllPending();
  const job = makeJob(idA1);
  const res = await fetch(`${BASE}/api/jobs/poll?apiKey=NOT-A-REAL-KEY`);
  assert.equal(res.status, 401, 'poll requires a valid apiKey (the node auth binding)');
  // Even with a valid-but-foreign key, ownership blocks the claim.
  assert.equal((await startAs(KEY_B, job)).status, 403);
});

// ── Multi-domain — one node legitimately owns multiple identities ────────────
test('Multi-domain — Node A can claim jobs across all identities it owns', async () => {
  cancelAllPending();
  const jobD2 = makeJob(idA2, 'user@x.com'); // A's second domain
  const claim = await startAs(KEY_A, jobD2);
  assert.equal(claim.status, 200, 'owner may claim any of its identities (not one-node-one-domain)');
  assert.equal(jobStatus(jobD2), 'PROCESSING');

  // Node B still cannot touch it.
  cancelAllPending();
  const jobD2b = makeJob(idA2);
  assert.equal((await startAs(KEY_B, jobD2b)).status, 403);
  assert.equal((await pollAs(KEY_B)).status, 204);
});
