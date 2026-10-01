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
