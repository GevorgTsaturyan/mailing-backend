// Tests for the delete → re-add lifecycle of sender identities.
//
// Regression: with foreign_keys=ON, deleting an identity that has
// provisioning_tasks rows previously failed with "FOREIGN KEY constraint failed",
// so a provisioned identity could never be removed and re-added. These tests
// verify a clean delete (child rows cleared) and a clean re-add of the same
// domain/fromAddr afterwards.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import jwt from 'jsonwebtoken';

process.env.DB_PATH ||= ':memory:';
process.env.UNSUBSCRIBE_REQUIRE_READY ||= 'false';
const TEST_SECRET = 'jwt-secret-identity-delete-tests';
process.env.JWT_SECRET = TEST_SECRET;

const db                     = (await import('./db.js')).default;
const senderIdentitiesRouter = (await import('./routes/sender-identities.js')).default;
const { requireAuth }        = await import('./middleware/auth.js');

const app = express();
app.use(express.json());
app.use('/api', requireAuth);
app.use('/api/sender-identities', senderIdentitiesRouter);

let server, port;
before(() => new Promise((resolve) => {
  server = app.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
}));
after(() => server.close());

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const opts = {
      hostname: '127.0.0.1', port, path, method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json; try { json = JSON.parse(data); } catch { json = data; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const TOKEN = jwt.sign({ id: 1, username: 'admin' }, TEST_SECRET, { expiresIn: '1h' });
const AUTH  = { Authorization: `Bearer ${TOKEN}` };
const now   = new Date().toISOString();

const serverId = Number(
  db.prepare("INSERT INTO servers (label, apiKey, status, createdAt) VALUES ('del-srv','DEL-KEY','online',?)")
    .run(now).lastInsertRowid
);

// Create an identity + simulate its provisioning lifecycle rows.
function provisionedIdentity(domain, fromAddr) {
  const id = Number(db.prepare(`
    INSERT INTO sender_identities
      (serverId, domain, ip, fromAddr, fromName, dkimSelector,
       status, verificationStatus, provisioningStatus, provisioningPhases, dailyLimit, dailySentCount, createdAt)
    VALUES (?, ?, '1.2.3.4', ?, 'T', 'mail', 'active', 'READY', 'DONE', ?, 50, 0, ?)
  `).run(serverId, domain, fromAddr, JSON.stringify({ mailNode: { status: 'DONE' } }), now).lastInsertRowid);
  db.prepare("INSERT INTO provisioning_tasks (identityId, serverId, status, taskType, requestedAt) VALUES (?,?,'DONE','provision',?)").run(id, serverId, now);
  db.prepare("INSERT INTO provisioning_tasks (identityId, serverId, status, taskType, requestedAt) VALUES (?,?,'DONE','reverify',?)").run(id, serverId, now);
  return id;
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('delete: removes a provisioned identity AND its provisioning_tasks (no FK error)', async () => {
  const id = provisionedIdentity('del-ardovia.example', 's@del-ardovia.example');
  assert.equal(db.prepare('SELECT count(*) n FROM provisioning_tasks WHERE identityId=?').get(id).n, 2);

  const { status, body } = await req('DELETE', `/api/sender-identities/${id}`, null, AUTH);
  assert.equal(status, 200);
  assert.equal(body.ok, true);

  assert.equal(db.prepare('SELECT id FROM sender_identities WHERE id=?').get(id), undefined, 'identity row gone');
  assert.equal(db.prepare('SELECT count(*) n FROM provisioning_tasks WHERE identityId=?').get(id).n, 0, 'provisioning_tasks gone');
});

test('delete → re-add same domain/fromAddr: creates a fresh identity with no leftover state', async () => {
  const domain = 'readd.example', fromAddr = 's@readd.example';
  const firstId = provisionedIdentity(domain, fromAddr);

  const del = await req('DELETE', `/api/sender-identities/${firstId}`, null, AUTH);
  assert.equal(del.status, 200);

  // Re-add the same identity
  const add = await req('POST', '/api/sender-identities', { serverId, domain, ip: '1.2.3.4', fromAddr }, AUTH);
  assert.equal(add.status, 200);
  assert.notEqual(add.body.id, firstId, 'a fresh row with a new id is created');
  assert.equal(add.body.domain, domain);
  // Fresh identity: unprovisioned, no phases, no tasks referencing it
  assert.equal(add.body.provisioningStatus ?? 'unprovisioned', 'unprovisioned');
  assert.equal(db.prepare('SELECT count(*) n FROM provisioning_tasks WHERE identityId=?').get(add.body.id).n, 0);

  // And it can be provisioned cleanly
  const prov = await req('POST', `/api/sender-identities/${add.body.id}/provision`, {}, AUTH);
  assert.equal(prov.status, 200);
  assert.equal(prov.body.status, 'PENDING');
});

test('delete: blocked (409) while active jobs exist, and nothing is removed', async () => {
  const id = provisionedIdentity('busy.example', 's@busy.example');
  db.prepare("INSERT INTO send_jobs (senderIdentityId, email, status, createdAt) VALUES (?, 'to@busy.example', 'queued', ?)").run(id, now);

  const { status, body } = await req('DELETE', `/api/sender-identities/${id}`, null, AUTH);
  assert.equal(status, 409);
  assert.match(body.error, /pending jobs/i);
  assert.ok(db.prepare('SELECT id FROM sender_identities WHERE id=?').get(id), 'identity NOT deleted while jobs pending');
});

test('delete: preserves historical send_jobs rows but drops the FK reference', async () => {
  const id = provisionedIdentity('history.example', 's@history.example');
  const jobId = Number(db.prepare("INSERT INTO send_jobs (senderIdentityId, email, status, createdAt) VALUES (?, 'to@history.example', 'sent', ?)").run(id, now).lastInsertRowid);

  const { status } = await req('DELETE', `/api/sender-identities/${id}`, null, AUTH);
  assert.equal(status, 200);

  const job = db.prepare('SELECT id, senderIdentityId, status FROM send_jobs WHERE id=?').get(jobId);
  assert.ok(job, 'historical send_jobs row preserved');
  assert.equal(job.senderIdentityId, null, 'FK reference cleared');
  assert.equal(job.status, 'sent', 'history intact');
});

test('delete: idempotent for an unknown id', async () => {
  const { status, body } = await req('DELETE', '/api/sender-identities/999999', null, AUTH);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

// ── Production repro: identity id=5 (ardovia.co) with a completed campaign + SENT
//    job + 4 completed provisioning_tasks, blocked by the campaigns FK. ────────────

// Attach the exact dependent shape from the production evidence to an identity.
function attachCampaignAndSentJob(identityId) {
  const campaignId = Number(db.prepare(`
    INSERT INTO campaigns (type, identity_id, label, status, date, created_at, completed_at)
    VALUES ('manual', ?, 'Manual blast', 'completed', ?, ?, ?)
  `).run(identityId, now, now, now).lastInsertRowid);
  const jobId = Number(db.prepare(`
    INSERT INTO jobs (status, identity_id, recipient, subject, created_at, campaign_id)
    VALUES ('SENT', ?, 'r@gmail.com', 'Hello', ?, ?)
  `).run(identityId, now, campaignId).lastInsertRowid);
  return { campaignId, jobId };
}

// (A) The exact failure: completed campaign + SENT job + completed provisioning tasks.
test('A: identity with completed campaign + SENT job + DONE provisioning tasks is removable', async () => {
  const id = provisionedIdentity('repro-ardovia.example', 's@repro-ardovia.example');
  // Mirror production: 4 provisioning_tasks (1 provision + 3 reverify), all DONE.
  db.prepare("INSERT INTO provisioning_tasks (identityId, serverId, status, taskType, requestedAt) VALUES (?,?,'DONE','reverify',?)").run(id, serverId, now);
  db.prepare("INSERT INTO provisioning_tasks (identityId, serverId, status, taskType, requestedAt) VALUES (?,?,'DONE','reverify',?)").run(id, serverId, now);
  const { campaignId, jobId } = attachCampaignAndSentJob(id);
  assert.equal(db.prepare('SELECT count(*) n FROM provisioning_tasks WHERE identityId=?').get(id).n, 4);

  const { status, body } = await req('DELETE', `/api/sender-identities/${id}`, null, AUTH);
  assert.equal(status, 200, 'delete must succeed despite the campaigns FK');
  assert.equal(body.ok, true);
  assert.equal(db.prepare('SELECT id FROM sender_identities WHERE id=?').get(id), undefined, 'identity gone');

  // (D) history preserved, references detached
  const camp = db.prepare('SELECT id, identity_id, status FROM campaigns WHERE id=?').get(campaignId);
  assert.ok(camp, 'campaign row preserved');
  assert.equal(camp.identity_id, null, 'campaign.identity_id detached');
  assert.equal(camp.status, 'completed', 'campaign history intact');
  const job = db.prepare('SELECT id, identity_id, status, campaign_id FROM jobs WHERE id=?').get(jobId);
  assert.ok(job, 'SENT job preserved');
  assert.equal(job.identity_id, null, 'job.identity_id detached');
  assert.equal(job.status, 'SENT', 'job history intact');
  assert.equal(job.campaign_id, campaignId, 'job still linked to its campaign');
});

// (B) Pending/retry provisioning task must not be orphaned after deletion.
test('B: pending/in-progress provisioning tasks are removed (no orphaned work)', async () => {
  const id = provisionedIdentity('pending-task.example', 's@pending-task.example');
  db.prepare("INSERT INTO provisioning_tasks (identityId, serverId, status, taskType, requestedAt) VALUES (?,?,'PENDING','reverify',?)").run(id, serverId, now);
  db.prepare("INSERT INTO provisioning_tasks (identityId, serverId, status, taskType, requestedAt) VALUES (?,?,'IN_PROGRESS','provision',?)").run(id, serverId, now);

  const { status } = await req('DELETE', `/api/sender-identities/${id}`, null, AUTH);
  assert.equal(status, 200);
  assert.equal(db.prepare("SELECT count(*) n FROM provisioning_tasks WHERE identityId=?").get(id).n, 0,
    'no provisioning_tasks (pending/in-progress/done) remain for the deleted identity');
});

// (C) No scheduler/provisioning/retry process may continue operating on it.
test('C: after deletion the retry service never processes the deleted identity', async () => {
  const { runRetries } = await import('./services/ProvisioningRetryService.js');
  const id = provisionedIdentity('no-retry.example', 's@no-retry.example');
  attachCampaignAndSentJob(id);

  const del = await req('DELETE', `/api/sender-identities/${id}`, null, AUTH);
  assert.equal(del.status, 200);

  // Retry-candidate precondition: no DONE identity row with this id remains.
  const candidate = db.prepare("SELECT id FROM sender_identities WHERE id=? AND provisioningStatus='DONE'").get(id);
  assert.equal(candidate, undefined, 'deleted identity is not a retry candidate');

  // Behavioural: runRetries must never hand the deleted domain to the pipeline/probe.
  const provisioned = [], probed = [];
  await runRetries({
    provisioner:  async (identity) => { provisioned.push(identity.domain); },
    hostsHealthy: async (domain)   => { probed.push(domain); return { ok: true, hosts: {} }; },
  });
  assert.ok(!provisioned.includes('no-retry.example'), 'controller pipeline must not run for a deleted identity');
  assert.ok(!probed.includes('no-retry.example'), 'host health probe must not run for a deleted identity');
});

// (E) Deleting an identity must not break other identities on the same server.
test('E: deleting one identity leaves siblings on the same server intact', async () => {
  const keep = provisionedIdentity('keep.example', 's@keep.example');
  const drop = provisionedIdentity('drop.example', 's@drop.example');
  const keepCamp = attachCampaignAndSentJob(keep);

  const del = await req('DELETE', `/api/sender-identities/${drop}`, null, AUTH);
  assert.equal(del.status, 200);

  const sib = db.prepare('SELECT id, serverId, verificationStatus FROM sender_identities WHERE id=?').get(keep);
  assert.ok(sib, 'sibling identity still present');
  assert.equal(sib.serverId, serverId);
  assert.equal(db.prepare('SELECT count(*) n FROM provisioning_tasks WHERE identityId=?').get(keep).n, 2,
    "sibling's provisioning_tasks untouched");
  const sibCamp = db.prepare('SELECT identity_id FROM campaigns WHERE id=?').get(keepCamp.campaignId);
  assert.equal(sibCamp.identity_id, keep, "sibling's campaign remains linked");
});

// (F) Delete + re-add + provision must be a clean lifecycle (provisioning starts).
test('F: delete → re-add same domain → provisioning starts normally', async () => {
  const domain = 'lifecycle.example', fromAddr = 's@lifecycle.example';
  const firstId = provisionedIdentity(domain, fromAddr);
  attachCampaignAndSentJob(firstId);

  assert.equal((await req('DELETE', `/api/sender-identities/${firstId}`, null, AUTH)).status, 200);

  const add = await req('POST', '/api/sender-identities', { serverId, domain, ip: '1.2.3.4', fromAddr }, AUTH);
  assert.equal(add.status, 200);
  assert.notEqual(add.body.id, firstId, 'fresh identity row');

  const prov = await req('POST', `/api/sender-identities/${add.body.id}/provision`, {}, AUTH);
  assert.equal(prov.status, 200);
  assert.equal(prov.body.status, 'PENDING', 'provisioning starts for the re-added identity');
  const task = db.prepare("SELECT taskType, status FROM provisioning_tasks WHERE identityId=?").get(add.body.id);
  assert.equal(task.taskType, 'provision');
  assert.equal(task.status, 'PENDING');
});
