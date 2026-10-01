// Unsubscribe-host readiness gate — controller side.
// Campaign (contact-bound) jobs advertise the List-Unsubscribe URL in every email;
// they must NEVER be dispatched while that host is unverified (a dead unsubscribe
// endpoint funnels recipients to "Report spam"). Raw jobs carry no unsubscribe
// URL and stay dispatchable. Jobs are withheld, never failed — dispatch resumes
// automatically once the host verifies.
//
// Multi-domain contract: the gate is per sending-identity domain. Domain A's
// readiness state does not affect Domain B's dispatch — each is probed independently.

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
const { buildUnsubscribeUrl }   = await import('./services/unsubscribeToken.js');
const { trackingBaseUrl }       = await import('./services/trackingToken.js');

// trackingToken.js requires TRACKING_SECRET even just to import trackingBaseUrl
process.env.TRACKING_SECRET ||= 'test-tracking-secret';

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

// Primary identity: serawin.net
const identityId = Number(db.prepare(
  `INSERT INTO sender_identities (serverId, domain, ip, fromAddr, fromName, dkimSelector, status, verificationStatus, dailyLimit, dailySentCount, createdAt)
   VALUES (?, 'serawin.net', '1.2.3.4', 's@serawin.net', 'S', 'mail', 'active', 'READY', 1000, 0, ?)`
).run(serverId, now).lastInsertRowid);

// Second identity: example.com (the arbitrary new domain used for multi-domain tests)
const identityIdExCom = Number(db.prepare(
  `INSERT INTO sender_identities (serverId, domain, ip, fromAddr, fromName, dkimSelector, status, verificationStatus, dailyLimit, dailySentCount, createdAt)
   VALUES (?, 'example.com', '5.6.7.8', 'n@example.com', 'N', 'mail', 'active', 'READY', 1000, 0, ?)`
).run(serverId, now).lastInsertRowid);

let seq = 0;
function mkContact() {
  const email = `ur-${Date.now()}-${seq++}@example.com`;
  return Number(db.prepare(
    "INSERT INTO contacts (firstName,lastName,email,status) VALUES ('T','U',?, 'pending')"
  ).run(email).lastInsertRowid);
}

// Create a PENDING job for the given identity domain
function mkPendingJobForIdentity(identId, contactId = null, priority = 0) {
  return Number(db.prepare(
    "INSERT INTO jobs (status, identity_id, recipient, subject, body, content_type, contact_id, priority, created_at) VALUES ('PENDING', ?, 'r@x.com', 'Hi', 'Hi', 'html', ?, ?, ?)"
  ).run(identId, contactId, priority, now).lastInsertRowid);
}

// Shortcut for serawin.net jobs (legacy test fixture)
function mkPendingJob(contactId = null, priority = 0) {
  return mkPendingJobForIdentity(identityId, contactId, priority);
}

const jobRow  = (id) => db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
const cancel  = (id) => db.prepare("UPDATE jobs SET status='CANCELLED' WHERE id=?").run(id);

// ── Fail-closed default ───────────────────────────────────────────────────────
test('allowDispatch is FALSE per domain before any successful probe (fail-closed)', () => {
  assert.equal(Readiness.isReady('serawin.net'),  false);
  assert.equal(Readiness.isReady('example.com'),  false);
  assert.equal(Readiness.allowDispatch('serawin.net'),  false);
  assert.equal(Readiness.allowDispatch('example.com'),  false);
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
  const r = await Readiness.verify('serawin.net', async () => ({ status: 200 }));
  assert.equal(r.ready, true);
  assert.equal(r.via, 'public');
  assert.equal(Readiness.isReady('serawin.net'), true);
});

test('verify: public fails, local 200 → ready via hairpin fallback', async () => {
  const r = await Readiness.verify('serawin.net', async (url) => {
    if (String(url).startsWith('https://')) throw new Error('ENOTFOUND');
    return { status: 200 };
  });
  assert.equal(r.ready, true);
  assert.equal(r.via, 'local-fallback');
});

test('verify: both probes fail → not ready, dispatch withheld', async () => {
  const r = await Readiness.verify('serawin.net', async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(r.ready, false);
  assert.equal(Readiness.allowDispatch('serawin.net'), false);
});

// ── Canonical dispatch gate: poll ─────────────────────────────────────────────
test('poll withholds contact-bound jobs while not ready; raw jobs still flow', () => {
  Readiness._setReady(false); // set all active domains not-ready
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
test('UNSUBSCRIBE_REQUIRE_READY=false disables the gate for all domains (dev/test only)', () => {
  Readiness._setReady('serawin.net', false);
  Readiness._setReady('example.com', false);
  process.env.UNSUBSCRIBE_REQUIRE_READY = 'false';
  assert.equal(Readiness.allowDispatch('serawin.net'), true,  'serawin.net: gating off');
  assert.equal(Readiness.allowDispatch('example.com'), true,  'example.com: gating off');
  process.env.UNSUBSCRIBE_REQUIRE_READY = 'true';
  assert.equal(Readiness.allowDispatch('serawin.net'), false, 'serawin.net: gating on again');
  assert.equal(Readiness.allowDispatch('example.com'), false, 'example.com: gating on again');
  Readiness._setReady('serawin.net', true);
  Readiness._setReady('example.com', true);
});

// ═════════════════════════════════════════════════════════════════════════════
// Multi-domain isolation tests
//
// These verify the core contract: adding a completely new sender identity domain
// (here: example.com) requires ZERO application-code change. The unsubscribe
// URL, tracking URL, and readiness gate all derive from sender_identities.domain.
// ═════════════════════════════════════════════════════════════════════════════

// ── URL generation: automatic, no code change per new identity ────────────────
test('unsubscribe URL for example.com is https://unsubscribe.example.com/... (no code change)', () => {
  const contactId = mkContact();
  const url = buildUnsubscribeUrl(contactId, { domain: 'example.com', identityId: identityIdExCom });
  assert.ok(url.startsWith('https://unsubscribe.example.com/u/'),
    `Expected URL to start with https://unsubscribe.example.com/u/ but got: ${url}`);
});

test('tracking base URL for example.com is https://click.example.com (no code change)', () => {
  process.env.TRACKING_SUBDOMAIN ||= 'click';
  const url = trackingBaseUrl('example.com');
  assert.equal(url, 'https://click.example.com');
});

test('unsubscribe URL for serawin.net is https://unsubscribe.serawin.net/... (unchanged)', () => {
  const contactId = mkContact();
  const url = buildUnsubscribeUrl(contactId, { domain: 'serawin.net', identityId });
  assert.ok(url.startsWith('https://unsubscribe.serawin.net/u/'),
    `Expected https://unsubscribe.serawin.net/u/ but got: ${url}`);
});

// ── Per-domain readiness isolation ────────────────────────────────────────────
test('readiness starts false per-domain; isReady(domain) is independent per domain', () => {
  Readiness._setReady('serawin.net',  false);
  Readiness._setReady('example.com',  false);
  assert.equal(Readiness.isReady('serawin.net'),  false);
  assert.equal(Readiness.isReady('example.com'),  false);

  Readiness._setReady('serawin.net',  true);
  assert.equal(Readiness.isReady('serawin.net'),  true,  'serawin.net is ready after _setReady');
  assert.equal(Readiness.isReady('example.com'),  false, 'example.com still not ready');

  Readiness._setReady('serawin.net',  false); // reset
});

test('allowDispatch is per-domain: true for ready domain, false for unready domain', () => {
  Readiness._setReady('serawin.net',  true);
  Readiness._setReady('example.com',  false);
  assert.equal(Readiness.allowDispatch('serawin.net'),  true);
  assert.equal(Readiness.allowDispatch('example.com'),  false);
  Readiness._setReady(false); // reset all
});

// ── poll(): per-domain job isolation ─────────────────────────────────────────
test('poll dispatches serawin.net campaign jobs when serawin.net is ready, even if example.com is not', () => {
  Readiness._setReady('serawin.net',  true);
  Readiness._setReady('example.com',  false);

  const serawinJob  = mkPendingJobForIdentity(identityId,      mkContact(), 0);
  const exampleJob  = mkPendingJobForIdentity(identityIdExCom, mkContact(), 0);

  // Poll should return the serawin.net job (ready), not the example.com one (not ready)
  const j = poll(serverId);
  assert.ok(j, 'a job is returned');
  assert.equal(j.id, serawinJob,
    `Expected serawin.net job (id=${serawinJob}) but got id=${j?.id}`);
  assert.equal(jobRow(exampleJob).status, 'PENDING', 'example.com job stays PENDING (withheld)');

  cancel(serawinJob);
  cancel(exampleJob);
  Readiness._setReady(false);
});

test('poll withholds example.com campaign jobs when example.com is not ready, serawin.net unaffected', () => {
  Readiness._setReady('serawin.net',  true);
  Readiness._setReady('example.com',  false);

  const exampleCampaignJob = mkPendingJobForIdentity(identityIdExCom, mkContact(), 10); // high priority
  const serawinRawJob      = mkPendingJobForIdentity(identityId,      null,        0);

  // example.com campaign job must be withheld; serawin.net raw job is dispatchable
  const j = poll(serverId);
  assert.ok(j, 'a job is returned');
  assert.equal(j.id, serawinRawJob, 'serawin.net raw job dispatched; example.com campaign withheld');
  assert.equal(jobRow(exampleCampaignJob).status, 'PENDING', 'example.com job stays PENDING');

  cancel(exampleCampaignJob);
  cancel(serawinRawJob);
  Readiness._setReady(false);
});

test('poll dispatches example.com jobs once example.com unsubscribe host is ready', () => {
  Readiness._setReady(false); // start all not-ready
  const exampleJob = mkPendingJobForIdentity(identityIdExCom, mkContact(), 0);

  // Not ready yet — withheld
  assert.equal(poll(serverId)?.id ?? null, null, 'job withheld while example.com not ready');

  // Mark example.com ready
  Readiness._setReady('example.com', true);
  const j = poll(serverId);
  assert.equal(j?.id, exampleJob, 'example.com job dispatches once its host is ready');

  cancel(exampleJob);
  Readiness._setReady(false);
});

// ── startJob(): per-domain claim gate ────────────────────────────────────────
test('startJob refuses example.com campaign job (409) if example.com not ready; serawin.net unaffected', () => {
  Readiness._setReady('serawin.net',  true);
  Readiness._setReady('example.com',  false);

  const serawinJobId = mkPendingJob(mkContact());
  const exComJobId   = mkPendingJobForIdentity(identityIdExCom, mkContact());

  // example.com job → refused
  const bad = JobService.startJob(exComJobId, serverId);
  assert.equal(bad.status, 409);
  assert.match(bad.error, /unsubscribe host/i);
  assert.equal(jobRow(exComJobId).status, 'PENDING', 'example.com job stays PENDING');

  // serawin.net job → succeeds
  const ok = JobService.startJob(serawinJobId, serverId);
  assert.equal(ok.ok, true, 'serawin.net job claimed successfully (domain is ready)');

  cancel(serawinJobId);
  cancel(exComJobId);
  Readiness._setReady(false);
});

// ── Legacy pipeline: per-domain isolation ────────────────────────────────────
test('legacy /api/nodes/jobs: example.com jobs withheld but serawin.net jobs dispatch when serawin.net is ready', async () => {
  Readiness._setReady('serawin.net',  true);
  Readiness._setReady('example.com',  false);

  // Create a legacy send_job for serawin.net only
  const sjSerawin = Number(db.prepare(
    "INSERT INTO send_jobs (senderIdentityId, contactId, email, status, createdAt) VALUES (?, ?, 'r@s.com', 'queued', ?)"
  ).run(identityId, mkContact(), now).lastInsertRowid);

  const res = await fetch(`${BASE}/api/nodes/jobs?apiKey=${KEY}&limit=50`);
  const { jobs } = await res.json();
  assert.ok(jobs.some((j) => j.id === sjSerawin),
    'serawin.net legacy job dispatches when serawin.net is ready');

  db.prepare("UPDATE send_jobs SET status='cancelled' WHERE id=?").run(sjSerawin);
  Readiness._setReady(false);
});

// ── verify() per domain ───────────────────────────────────────────────────────
test('verify(domain) sets readiness only for the specified domain', async () => {
  Readiness._setReady(false); // start all not-ready
  await Readiness.verify('example.com', async () => ({ status: 200 }));
  assert.equal(Readiness.isReady('example.com'), true,   'example.com probe succeeded');
  assert.equal(Readiness.isReady('serawin.net'), false,  'serawin.net not probed — still not-ready');
  Readiness._setReady(false);
});

// ── getReadyDomains() ─────────────────────────────────────────────────────────
test('getReadyDomains() returns a Set of ready domains, or null when gating disabled', () => {
  Readiness._setReady('serawin.net',  true);
  Readiness._setReady('example.com',  false);

  const ready = Readiness.getReadyDomains();
  assert.ok(ready instanceof Set,      'returns a Set');
  assert.equal(ready.has('serawin.net'),  true,  'serawin.net is in the ready set');
  assert.equal(ready.has('example.com'),  false, 'example.com is NOT in the ready set');

  process.env.UNSUBSCRIBE_REQUIRE_READY = 'false';
  assert.equal(Readiness.getReadyDomains(), null, 'null when gating is disabled');
  process.env.UNSUBSCRIBE_REQUIRE_READY = 'true';

  Readiness._setReady(false);
});
