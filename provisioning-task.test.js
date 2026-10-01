// Tests for the automated provisioning task flow:
//   GET  /api/nodes/provisioning-task        — poll + claim
//   POST /api/nodes/provisioning-task/:id/result — report result
//   POST /api/sender-identities/:id/provision   — trigger from UI (JWT)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import jwt from 'jsonwebtoken';

process.env.UNSUBSCRIBE_SECRET     ||= 'test-secret-provisioning';
process.env.DB_PATH                ||= ':memory:';
process.env.UNSUBSCRIBE_REQUIRE_READY ||= 'false';

const TEST_SECRET = 'jwt-secret-for-provisioning-task-tests';
process.env.JWT_SECRET = TEST_SECRET;

const db                     = (await import('./db.js')).default;
const nodesRouter            = (await import('./routes/nodes.js')).default;
const senderIdentitiesRouter = (await import('./routes/sender-identities.js')).default;
const { requireAuth }        = await import('./middleware/auth.js');

// ── Minimal Express app ───────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use('/api/nodes', nodesRouter);
app.use('/api', requireAuth);
app.use('/api/sender-identities', senderIdentitiesRouter);

let server, port;
before(() => new Promise((resolve) => {
  server = app.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
}));
after(() => server.close());

// ── HTTP helper ───────────────────────────────────────────────────────────────
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
        resolve({ status: res.status || res.statusCode, body: json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const TOKEN = jwt.sign({ id: 1, username: 'admin' }, TEST_SECRET, { expiresIn: '1h' });
const AUTH  = { Authorization: `Bearer ${TOKEN}` };

// ── Fixtures ──────────────────────────────────────────────────────────────────
const now   = new Date().toISOString();
const API_KEY_A = 'PTASK-KEY-A';
const API_KEY_B = 'PTASK-KEY-B';

const serverA = Number(
  db.prepare("INSERT INTO servers (label, apiKey, status, createdAt) VALUES ('srv-a', ?, 'online', ?)")
    .run(API_KEY_A, now).lastInsertRowid
);
const serverB = Number(
  db.prepare("INSERT INTO servers (label, apiKey, status, createdAt) VALUES ('srv-b', ?, 'online', ?)")
    .run(API_KEY_B, now).lastInsertRowid
);

const mkIdentity = (serverId, domain) => Number(db.prepare(`
  INSERT INTO sender_identities
    (serverId, domain, ip, fromAddr, fromName, dkimSelector, status, verificationStatus, dailyLimit, dailySentCount, createdAt)
  VALUES (?, ?, '1.2.3.4', 's@${domain}', 'S', 'mail', 'active', 'unverified', 50, 0, ?)
`).run(serverId, domain, now).lastInsertRowid);

const idA = mkIdentity(serverA, 'task-test-a.example');
const idB = mkIdentity(serverB, 'task-test-b.example');

// ── POST /api/sender-identities/:id/provision ─────────────────────────────────

test('provision: 401 without JWT', async () => {
  const { status } = await req('POST', `/api/sender-identities/${idA}/provision`, {});
  assert.equal(status, 401);
});

test('provision: 404 for unknown identity', async () => {
  const { status } = await req('POST', '/api/sender-identities/999999/provision', {}, AUTH);
  assert.equal(status, 404);
});

test('provision: creates PENDING task and sets provisioningStatus', async () => {
  const { status, body } = await req('POST', `/api/sender-identities/${idA}/provision`, {}, AUTH);
  assert.equal(status, 200);
  assert.equal(body.status, 'PENDING');
  assert.ok(body.taskId > 0);

  const si = db.prepare('SELECT provisioningStatus FROM sender_identities WHERE id=?').get(idA);
  assert.equal(si.provisioningStatus, 'PENDING');
});

test('provision: idempotent — second call returns existing task without creating a duplicate', async () => {
  const { body: first  } = await req('POST', `/api/sender-identities/${idA}/provision`, {}, AUTH);
  const { body: second } = await req('POST', `/api/sender-identities/${idA}/provision`, {}, AUTH);
  assert.equal(second.taskId, first.taskId);
  assert.equal(second.alreadyQueued, true);

  const count = db.prepare('SELECT count(*) AS n FROM provisioning_tasks WHERE identityId=?').get(idA).n;
  assert.equal(count, 1);
});

// ── GET /api/nodes/provisioning-task ─────────────────────────────────────────

test('poll task: 401 with invalid apiKey', async () => {
  const { status } = await req('GET', '/api/nodes/provisioning-task?apiKey=BAD-KEY');
  assert.equal(status, 401);
});

test('poll task: 204 when no task is pending for this server', async () => {
  // serverB has no tasks yet
  const { status } = await req('GET', `/api/nodes/provisioning-task?apiKey=${API_KEY_B}`);
  assert.equal(status, 204);
});

test('poll task: returns task and transitions to IN_PROGRESS', async () => {
  // serverA has the PENDING task from the provision test above
  const { status, body } = await req('GET', `/api/nodes/provisioning-task?apiKey=${API_KEY_A}`);
  assert.equal(status, 200);
  assert.equal(body.identityId, idA);
  assert.equal(body.domain, 'task-test-a.example');
  assert.ok(body.id > 0);

  const task = db.prepare('SELECT status FROM provisioning_tasks WHERE id=?').get(body.id);
  assert.equal(task.status, 'IN_PROGRESS');
});

test('poll task: 204 when task is already IN_PROGRESS (no double-claim)', async () => {
  // The task from serverA is now IN_PROGRESS; polling again returns 204
  const { status } = await req('GET', `/api/nodes/provisioning-task?apiKey=${API_KEY_A}`);
  assert.equal(status, 204);
});

// ── POST /api/nodes/provisioning-task/:id/result ──────────────────────────────
// These tests need the IN_PROGRESS task id. Query it inside each test so there
// is no module-level dependency on test ordering.

function getInProgressTaskA() {
  return db.prepare("SELECT id FROM provisioning_tasks WHERE serverId=? AND status='IN_PROGRESS'").get(serverA);
}

test('result: 401 with invalid apiKey', async () => {
  const taskA = getInProgressTaskA();
  const { status } = await req('POST', `/api/nodes/provisioning-task/${taskA.id}/result`, {
    apiKey: 'BAD', status: 'DONE', phases: [],
  });
  assert.equal(status, 401);
});

test('result: 404 when task belongs to a different server', async () => {
  const taskA = getInProgressTaskA();
  const { status } = await req('POST', `/api/nodes/provisioning-task/${taskA.id}/result`, {
    apiKey: API_KEY_B, status: 'DONE', phases: [],
  });
  assert.equal(status, 404);
});

test('result: 400 for invalid status value', async () => {
  const taskA = getInProgressTaskA();
  const { status } = await req('POST', `/api/nodes/provisioning-task/${taskA.id}/result`, {
    apiKey: API_KEY_A, status: 'RUNNING', phases: [],
  });
  assert.equal(status, 400);
});

test('result: DONE transitions task + identity provisioningStatus', async () => {
  const taskA = getInProgressTaskA();
  const phases = [
    { phase: 'dkim_key', status: 'OK', message: 'Generated' },
    { phase: 'verify',   status: 'OK', message: 'Sent' },
  ];
  const { status, body } = await req('POST', `/api/nodes/provisioning-task/${taskA.id}/result`, {
    apiKey: API_KEY_A, status: 'DONE', phases,
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);

  const task = db.prepare('SELECT status, phases FROM provisioning_tasks WHERE id=?').get(taskA.id);
  assert.equal(task.status, 'DONE');
  const saved = JSON.parse(task.phases);
  assert.equal(saved[0].phase, 'dkim_key');

  const si = db.prepare('SELECT provisioningStatus FROM sender_identities WHERE id=?').get(idA);
  assert.equal(si.provisioningStatus, 'DONE');
});

test('result: FAILED transitions task + identity to FAILED', async () => {
  // Create a fresh task on serverB's identity
  db.prepare("INSERT INTO provisioning_tasks (identityId, serverId, status, requestedAt) VALUES (?,?,'IN_PROGRESS',?)")
    .run(idB, serverB, now);
  const taskB = db.prepare("SELECT id FROM provisioning_tasks WHERE serverId=? AND status='IN_PROGRESS'").get(serverB);

  const { status } = await req('POST', `/api/nodes/provisioning-task/${taskB.id}/result`, {
    apiKey: API_KEY_B, status: 'FAILED', phases: [], error: 'opendkim-genkey not found',
  });
  assert.equal(status, 200);

  const task = db.prepare('SELECT status, error FROM provisioning_tasks WHERE id=?').get(taskB.id);
  assert.equal(task.status, 'FAILED');
  assert.equal(task.error, 'opendkim-genkey not found');

  const si = db.prepare('SELECT provisioningStatus FROM sender_identities WHERE id=?').get(idB);
  assert.equal(si.provisioningStatus, 'FAILED');
});
