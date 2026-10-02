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

// serverC: fully isolated server for the new task-type / DKIM-key / phases tests
const API_KEY_C = 'PTASK-KEY-C';
const serverC = Number(
  db.prepare("INSERT INTO servers (label, apiKey, status, createdAt) VALUES ('srv-c', ?, 'online', ?)")
    .run(API_KEY_C, now).lastInsertRowid
);

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

// ── taskType propagation ──────────────────────────────────────────────────────

test('taskType: provision endpoint stores taskType=provision in DB', async () => {
  const id = mkIdentity(serverC, 'tasktype-test.example');
  await req('POST', `/api/sender-identities/${id}/provision`, {}, AUTH);
  const task = db.prepare('SELECT taskType FROM provisioning_tasks WHERE identityId=?').get(id);
  assert.equal(task.taskType, 'provision');
  // Drain the IN_PROGRESS task so serverC stays clean
  const t = db.prepare("SELECT id FROM provisioning_tasks WHERE identityId=? AND status='PENDING'").get(id);
  if (t) db.prepare("UPDATE provisioning_tasks SET status='DONE' WHERE id=?").run(t.id);
});

test('taskType: claim response includes taskType field', async () => {
  const id = mkIdentity(serverC, 'tasktype-claim-test.example');
  await req('POST', `/api/sender-identities/${id}/provision`, {}, AUTH);
  const { status, body } = await req('GET', `/api/nodes/provisioning-task?apiKey=${API_KEY_C}`);
  assert.equal(status, 200);
  assert.ok('taskType' in body, 'taskType must be present in claim response');
  assert.equal(body.taskType, 'provision');
  // Report result to clean up
  await req('POST', `/api/nodes/provisioning-task/${body.id}/result`, {
    apiKey: API_KEY_C, status: 'DONE', phases: [],
  });
});

test('taskType: reverify task can be inserted, claimed, and results reported', async () => {
  const id = mkIdentity(serverC, 'reverify-flow-test.example');

  // Insert a reverify task directly (as retry service would)
  db.prepare(
    "INSERT INTO provisioning_tasks (identityId, serverId, status, taskType, requestedAt) VALUES (?,?,'PENDING','reverify',?)"
  ).run(id, serverC, now);

  // Claim it
  const { body: claimed } = await req('GET', `/api/nodes/provisioning-task?apiKey=${API_KEY_C}`);
  assert.equal(claimed.taskType, 'reverify');
  assert.equal(claimed.identityId, id);

  // Report DONE
  const { status: rs, body: rb } = await req('POST', `/api/nodes/provisioning-task/${claimed.id}/result`, {
    apiKey: API_KEY_C, status: 'DONE',
    phases: [{ phase: 'verify', status: 'OK', message: 'Sent' }],
  });
  assert.equal(rs, 200);
  assert.equal(rb.ok, true);

  const task = db.prepare('SELECT status FROM provisioning_tasks WHERE id=?').get(claimed.id);
  assert.equal(task.status, 'DONE');
});

// ── provisioningPhases initialisation ────────────────────────────────────────

test('provision: initialises provisioningPhases blob with all-PENDING status', async () => {
  const id = mkIdentity(serverC, 'phases-init-test.example');
  await req('POST', `/api/sender-identities/${id}/provision`, {}, AUTH);

  const si = db.prepare('SELECT provisioningPhases FROM sender_identities WHERE id=?').get(id);
  assert.ok(si.provisioningPhases, 'provisioningPhases must be set');
  const phases = JSON.parse(si.provisioningPhases);
  assert.equal(phases.mailNode?.status,     'PENDING');
  assert.equal(phases.cloudflare?.status,   'PENDING');
  assert.equal(phases.nginx?.status,        'PENDING');
  assert.equal(phases.ptr?.status,          'PENDING');
  assert.equal(phases.verification?.status, 'PENDING');
  // Drain so serverC stays clean
  const t = db.prepare("SELECT id FROM provisioning_tasks WHERE identityId=? AND status='PENDING'").get(id);
  if (t) db.prepare("UPDATE provisioning_tasks SET status='DONE' WHERE id=?").run(t.id);
});

// ── DKIM public key storage ───────────────────────────────────────────────────

test('result: DONE with dkim_key phase stores dkimPublicKey on identity', async () => {
  const id = mkIdentity(serverC, 'dkim-pubkey-test.example');

  await req('POST', `/api/sender-identities/${id}/provision`, {}, AUTH);
  const { body: claimed } = await req('GET', `/api/nodes/provisioning-task?apiKey=${API_KEY_C}`);
  assert.equal(claimed.identityId, id, 'sanity: claimed task must belong to this identity');

  const pubKey = 'MIGfMA0GCSqGSIb3DQEBTestKey';
  await req('POST', `/api/nodes/provisioning-task/${claimed.id}/result`, {
    apiKey: API_KEY_C,
    status: 'DONE',
    phases: [
      { phase: 'dkim_key', status: 'OK', message: 'Generated', dkimPublicKey: pubKey },
      { phase: 'verify',   status: 'OK', message: 'Sent' },
    ],
  });

  const si = db.prepare('SELECT dkimPublicKey FROM sender_identities WHERE id=?').get(id);
  assert.equal(si.dkimPublicKey, pubKey, 'dkimPublicKey must be stored from dkim_key phase result');
});

// ── B. Identity cannot be READY/dispatched if task reported FAILED ────────────
// Regression: an identity whose provisioning task reports FAILED must have
// provisioningStatus='FAILED' and verificationStatus='unverified', blocking dispatch.

test('B: FAILED provisioning task keeps identity NOT dispatchable (verificationStatus stays unverified)', async () => {
  const id = mkIdentity(serverC, 'failed-prov-test.example');

  await req('POST', `/api/sender-identities/${id}/provision`, {}, AUTH);
  const { body: claimed } = await req('GET', `/api/nodes/provisioning-task?apiKey=${API_KEY_C}`);
  assert.equal(claimed.identityId, id);

  // Mail-node reports FAILED (simulates provisionPostfixTransport throwing
  // because senderTransportLive returned false after ensureSenderTransport).
  await req('POST', `/api/nodes/provisioning-task/${claimed.id}/result`, {
    apiKey: API_KEY_C,
    status: 'FAILED',
    phases: [{ phase: 'postfix_transport', status: 'FAILED', message: 'sender transport not live after provisioning' }],
    error: 'sender transport for failed-prov-test.example is not live after provisioning',
  });

  const si = db.prepare('SELECT provisioningStatus, verificationStatus FROM sender_identities WHERE id=?').get(id);
  assert.equal(si.provisioningStatus, 'FAILED', 'provisioningStatus must be FAILED');
  // verificationStatus is never set to READY when task failed (applyReports was never called)
  assert.notEqual(si.verificationStatus, 'READY', 'verificationStatus must NOT be READY after task failure');
});

// ── H. Delete → recreate same domain → provisioning starts fresh ─────────────
// Extends the delete+recreate test to verify the PROVISION task is claimed with
// a clean slate: no lingering IN_PROGRESS task, correct taskType, correct domain
// and IP in the claimed task payload.

test('H: delete → recreate ardovia.co → new provision task is claimable with correct domain+IP', async () => {
  const API_KEY_D = 'PTASK-KEY-D';
  const serverD = Number(
    db.prepare("INSERT INTO servers (label, apiKey, status, createdAt) VALUES ('srv-d', ?, 'online', ?)")
      .run(API_KEY_D, now).lastInsertRowid
  );
  const IP = '51.255.209.148';
  const DOMAIN = 'ardovia-repro.example';
  const FROM  = `support@${DOMAIN}`;

  // Step 1: create a provisioned identity (simulates existing ardovia.co state)
  const firstId = Number(db.prepare(`
    INSERT INTO sender_identities
      (serverId, domain, ip, fromAddr, fromName, dkimSelector,
       status, verificationStatus, provisioningStatus, dailyLimit, dailySentCount, createdAt)
    VALUES (?, ?, ?, ?, 'Ardovia', 'mail', 'active', 'READY', 'DONE', 50, 0, ?)
  `).run(serverD, DOMAIN, IP, FROM, now).lastInsertRowid);
  db.prepare("INSERT INTO provisioning_tasks (identityId, serverId, status, taskType, requestedAt) VALUES (?,?,'DONE','provision',?)")
    .run(firstId, serverD, now);

  // Step 2: delete (normal Controller flow)
  const del = await req('DELETE', `/api/sender-identities/${firstId}`, null, AUTH);
  assert.equal(del.status, 200);
  assert.equal(db.prepare('SELECT id FROM sender_identities WHERE id=?').get(firstId), undefined, 'identity removed');
  assert.equal(
    db.prepare('SELECT count(*) n FROM provisioning_tasks WHERE identityId=?').get(firstId).n,
    0, 'all provisioning tasks removed'
  );

  // Step 3: recreate through normal Controller flow
  const add = await req('POST', '/api/sender-identities', {
    serverId: serverD, domain: DOMAIN, ip: IP, fromAddr: FROM,
  }, AUTH);
  assert.equal(add.status, 200);
  const newId = add.body.id;
  assert.notEqual(newId, firstId, 'fresh identity row');
  assert.equal(add.body.verificationStatus ?? 'unverified', 'unverified', 'starts unverified');

  // Step 4: trigger provisioning
  const prov = await req('POST', `/api/sender-identities/${newId}/provision`, {}, AUTH);
  assert.equal(prov.status, 200);
  assert.equal(prov.body.status, 'PENDING');

  // Step 5: mail-node claims the task — must see correct domain and IP
  const { status: claimStatus, body: claimed } = await req('GET', `/api/nodes/provisioning-task?apiKey=${API_KEY_D}`);
  assert.equal(claimStatus, 200, 'task must be claimable');
  assert.equal(claimed.domain, DOMAIN, 'task carries the correct domain');
  assert.equal(claimed.ip, IP, 'task carries the assigned IP (not server main IP)');
  assert.equal(claimed.taskType, 'provision');
  assert.equal(claimed.identityId, newId);

  // Drain
  await req('POST', `/api/nodes/provisioning-task/${claimed.id}/result`, {
    apiKey: API_KEY_D, status: 'DONE', phases: [],
  });
});

// ── Manual PTR in pipeline ────────────────────────────────────────────────────

test('result: DONE sets ptr phase to MANUAL with generic (non-OVH) message', async () => {
  const id = mkIdentity(serverC, 'ptr-msg-test.example');

  await req('POST', `/api/sender-identities/${id}/provision`, {}, AUTH);
  const { body: claimed } = await req('GET', `/api/nodes/provisioning-task?apiKey=${API_KEY_C}`);
  assert.equal(claimed.identityId, id, 'sanity: claimed task must belong to this identity');

  await req('POST', `/api/nodes/provisioning-task/${claimed.id}/result`, {
    apiKey: API_KEY_C, status: 'DONE', phases: [],
  });

  // ptr phase is set inside the async post-DONE IIFE — give it a moment
  await new Promise(r => setTimeout(r, 150));

  const si = db.prepare('SELECT provisioningPhases FROM sender_identities WHERE id=?').get(id);
  const phases = si.provisioningPhases ? JSON.parse(si.provisioningPhases) : {};
  assert.equal(phases.ptr?.status, 'MANUAL', 'ptr phase must be MANUAL after provisioning');
  const msg = phases.ptr?.message || '';
  assert.ok(!msg.toLowerCase().includes('ovh'), 'PTR message must not mention OVH specifically');
  assert.ok(msg.includes('ptr-msg-test.example') || msg.includes('1.2.3.4'), 'PTR message must include domain or IP');
});
