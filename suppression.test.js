// Defense-in-depth suppression enforcement tests.
// In-memory DB; bare Express apps mounting individual routers (no full server boot).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.UNSUBSCRIBE_SECRET ||= 'test-unsubscribe-secret';
process.env.DB_PATH            ||= ':memory:';

const db = (await import('./db.js')).default;
const { isContactSuppressed, isEmailSuppressed, suppressedContactIdSet } =
  await import('./services/SuppressionService.js');
const { queueCanonicalJobForContact } = await import('./scheduler.js');
const JobService                = await import('./services/JobService.js');
const { buildUnsubscribeUrl }   = await import('./services/unsubscribeToken.js');
const { processEvents }         = await import('./services/DeliveryEventService.js');
const sendRouter                = (await import('./routes/send.js')).default;
const nodesRouter               = (await import('./routes/nodes.js')).default;
const unsubscribeRouter         = (await import('./routes/unsubscribe.js')).default;

// ── App under test ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use('/api/send', sendRouter);
app.use('/api/nodes', nodesRouter);
app.use(unsubscribeRouter);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

// ── Fixtures ──────────────────────────────────────────────────────────────────
const now = new Date().toISOString();
const API_KEY = 'KEY-SUPPRESSION-TEST';
const serverId = Number(db.prepare(
  "INSERT INTO servers (label, apiKey, status, createdAt) VALUES ('node','" + API_KEY + "','online',?)"
).run(now).lastInsertRowid);
const identityId = Number(db.prepare(
  `INSERT INTO sender_identities (serverId, domain, ip, fromAddr, fromName, status, verificationStatus, dailyLimit, dailySentCount, createdAt)
   VALUES (?, 'serawin.net', '1.2.3.4', 'support@serawin.net', 'Support', 'active', 'READY', 100000, 0, ?)`
).run(serverId, now).lastInsertRowid);

let seq = 0;
function newContact(status = 'pending') {
  const email = `sup-${Date.now()}-${seq++}@example.com`;
  const id = Number(db.prepare(
    "INSERT INTO contacts (firstName, lastName, email, status) VALUES ('T', 'User', ?, ?)"
  ).run(email, status).lastInsertRowid);
  return { id, email, firstName: 'T', lastName: 'User' };
}
const canonicalJobCount = (cid) => db.prepare("SELECT COUNT(*) n FROM jobs WHERE contact_id=?").get(cid).n;
const jobRow            = (cid) => db.prepare("SELECT * FROM jobs WHERE contact_id=? ORDER BY id DESC LIMIT 1").get(cid);
const tmpl = { subject: 'Hi', html: '<p>Hi</p>', txt: 'Hi', content_type: 'html' };

// ── 2. Central eligibility check ──────────────────────────────────────────────

test('central: only unsubscribed is suppressed; pending/failed/sent are NOT', () => {
  assert.equal(isContactSuppressed(newContact('unsubscribed').id), true);
  assert.equal(isContactSuppressed(newContact('pending').id), false);
  assert.equal(isContactSuppressed(newContact('sent').id), false);
  // Test G — a transient 'failed' must NOT be treated as permanent suppression.
  assert.equal(isContactSuppressed(newContact('failed').id), false);
});

test('central: isEmailSuppressed + bulk set', () => {
  const u = newContact('unsubscribed');
  const p = newContact('pending');
  assert.equal(isEmailSuppressed(u.email), true);
  assert.equal(isEmailSuppressed(u.email.toUpperCase()), true, 'email match must be case-insensitive');
  assert.equal(isEmailSuppressed(p.email), false);
  const setResult = suppressedContactIdSet([u.id, p.id]);
  assert.equal(setResult.has(u.id), true);
  assert.equal(setResult.has(p.id), false);
});

// ── 4. Creation-time guard (canonical helper — the choke point for manual /
//        scheduled / recurring / daily canonical creation) ─────────────────────

test('creation: canonical helper skips suppressed and creates for eligible', () => {
  const sub = newContact('pending');
  assert.equal(queueCanonicalJobForContact(sub, null, tmpl, null, null, identityId, null), true);
  assert.equal(canonicalJobCount(sub.id), 1);

  const uns = newContact('unsubscribed');
  assert.equal(queueCanonicalJobForContact(uns, null, tmpl, null, null, identityId, null), false);
  assert.equal(canonicalJobCount(uns.id), 0, 'no job may be created for a suppressed contact');
});

test('creation: Test G — a failed (transient) contact can still be queued', () => {
  const failed = newContact('failed');
  assert.equal(queueCanonicalJobForContact(failed, null, tmpl, null, null, identityId, null), true);
  assert.equal(canonicalJobCount(failed.id), 1, 'transient failure must remain sendable/retryable');
});

// ── 4b. Raw job creation (POST /api/jobs → JobService.createJob) ──────────────

test('creation: raw createJob throws for suppressed recipient, allows eligible', () => {
  const uns = newContact('unsubscribed');
  assert.throws(() => JobService.createJob({ identity_id: identityId, recipient: uns.email, subject: 'Hi' }), /suppressed/i);
  const sub = newContact('pending');
  assert.ok(JobService.createJob({ identity_id: identityId, recipient: sub.email, subject: 'Hi' }).id);
});

// ── Test A — Manual send (POST /api/send), canonical + legacy ─────────────────

async function manualSend(contactIds, canonical) {
  process.env.USE_CANONICAL_QUEUE = canonical ? 'true' : 'false';
  const res = await fetch(`${BASE}/api/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contactIds, subject: 'Hi', html: '<p>Hi</p>', senderIdentityId: identityId }),
  });
  return res.json();
}

test('Test A — manual send (canonical): subscribed allowed, unsubscribed skipped', async () => {
  const sub = newContact('pending');
  const uns = newContact('unsubscribed');
  const { results } = await manualSend([sub.id, uns.id], true);
  const bySub = results.find((r) => r.id === sub.id);
  const byUns = results.find((r) => r.id === uns.id);
  assert.equal(bySub.status, 'queued');
  assert.equal(byUns.status, 'skipped');
  assert.match(byUns.note, /suppress/i);
  assert.equal(canonicalJobCount(uns.id), 0);
});

test('Test A — manual send (legacy): unsubscribed creates no send_jobs row', async () => {
  const uns = newContact('unsubscribed');
  const { results } = await manualSend([uns.id], false);
  assert.equal(results[0].status, 'skipped');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM send_jobs WHERE contactId=?').get(uns.id).n, 0);
});

// ── Test D — job created, THEN unsubscribe, THEN claim → NO SEND ──────────────

test('Test D — claim gate: proactive cancel on unsubscribe (canonical)', async () => {
  const c = newContact('pending');
  queueCanonicalJobForContact(c, null, tmpl, null, null, identityId, null);
  const before = jobRow(c.id);
  assert.equal(before.status, 'PENDING');

  // Unsubscribe via the real token endpoint (one-click POST).
  const path = '/u/' + buildUnsubscribeUrl(c.id).split('/u/')[1];
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  });
  assert.equal(res.status, 200);

  const afterJob = jobRow(c.id);
  assert.equal(afterJob.status, 'CANCELLED', 'queued job must be cancelled the moment the contact unsubscribes');

  // And a subsequent claim attempt must fail (job no longer PENDING).
  const startRes = JobService.startJob(afterJob.id, serverId);
  assert.equal(startRes.status, 409);
  assert.notEqual(jobRow(c.id).status, 'PROCESSING', 'a suppressed job must never reach PROCESSING');
});

test('Test D — claim gate: pure claim-time check (job slipped through, no proactive cancel)', () => {
  const c = newContact('pending');
  queueCanonicalJobForContact(c, null, tmpl, null, null, identityId, null);
  const job = jobRow(c.id);
  // Simulate the race: contact suppressed directly, WITHOUT proactive cancellation.
  db.prepare("UPDATE contacts SET status='unsubscribed' WHERE id=?").run(c.id);
  assert.equal(job.status, 'PENDING', 'job still PENDING — nothing cancelled it yet');

  const startRes = JobService.startJob(job.id, serverId);
  assert.equal(startRes.suppressed, true);
  assert.equal(startRes.status, 409);
  assert.equal(jobRow(c.id).status, 'CANCELLED', 'claim-time gate must cancel it instead of claiming');
});

// ── Legacy claim gate (GET /api/nodes/jobs) ──────────────────────────────────

test('legacy claim gate: /api/nodes/jobs never returns a suppressed recipient', async () => {
  const c = newContact('pending');
  db.prepare(`
    INSERT INTO send_jobs (senderIdentityId, contactId, email, status, createdAt)
    VALUES (?, ?, ?, 'queued', ?)
  `).run(identityId, c.id, c.email, now);
  // Suppress directly (simulate unsubscribe after queueing).
  db.prepare("UPDATE contacts SET status='unsubscribed' WHERE id=?").run(c.id);

  const res = await fetch(`${BASE}/api/nodes/jobs?apiKey=${API_KEY}&limit=50`);
  const { jobs } = await res.json();
  assert.equal(jobs.some((j) => j.contactId === c.id), false, 'suppressed job must not be handed to the node');

  const row = db.prepare('SELECT status FROM send_jobs WHERE contactId=?').get(c.id);
  assert.equal(row.status, 'cancelled', 'suppressed legacy job must be cancelled, not claimed');
});

// ── Test E — complaint suppresses + cancels outstanding jobs ──────────────────

test('Test E — complaint: unsubscribes contact and cancels their other queued jobs', () => {
  const c = newContact('pending');
  // Job A: already sent, carries the queueId the complaint references.
  db.prepare(`
    INSERT INTO jobs (status, identity_id, recipient, subject, body, content_type, contact_id, queue_id, delivery_status, created_at)
    VALUES ('SENT', ?, ?, 'Hi', 'Hi', 'html', ?, 'QIDCOMPLAINT', 'SMTP_ACCEPTED', ?)
  `).run(identityId, c.email, c.id, now);
  // Job B: still pending for the same contact — must be cancelled by the complaint.
  queueCanonicalJobForContact(c, null, tmpl, null, null, identityId, null);
  const pendingB = jobRow(c.id);
  assert.equal(pendingB.status, 'PENDING');

  const { processed } = processEvents([{ queueId: 'QIDCOMPLAINT', eventType: 'complained', logTime: now }]);
  assert.equal(processed, 1);

  assert.equal(db.prepare('SELECT status FROM contacts WHERE id=?').get(c.id).status, 'unsubscribed');
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(pendingB.id).status, 'CANCELLED',
    'complaint must cancel the contact’s other outstanding jobs');
});

// ── Test F — hard bounce (documented limitation) ──────────────────────────────

test('Test F — hard bounce marks contact failed (NOT auto-suppressed in current model)', () => {
  const c = newContact('pending');
  db.prepare(`
    INSERT INTO jobs (status, identity_id, recipient, subject, body, content_type, contact_id, queue_id, delivery_status, created_at)
    VALUES ('SENT', ?, ?, 'Hi', 'Hi', 'html', ?, 'QIDBOUNCE', 'SMTP_ACCEPTED', ?)
  `).run(identityId, c.email, c.id, now);
  processEvents([{ queueId: 'QIDBOUNCE', eventType: 'bounced', dsnCode: '5.1.1', reasonCategory: 'invalid_recipient', logTime: now }]);
  // Current schema cannot distinguish hard from soft bounce at the contact level:
  // it becomes 'failed', which is intentionally NOT suppressed here. Documented
  // limitation — hard-bounce suppression is deferred to the suppression_list redesign.
  assert.equal(db.prepare('SELECT status FROM contacts WHERE id=?').get(c.id).status, 'failed');
  assert.equal(isContactSuppressed(c.id), false);
});
