// Unit tests for ProvisioningRetryService
// Tests the core retry-loop behavior using a real in-memory DB.
// CF is disabled (CF_API_TOKEN='') and nginx phases are pre-set to avoid
// external calls — only the scheduleReverifyTask logic executes.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH                = ':memory:';
process.env.CF_API_TOKEN           = '';          // disable CF automation
process.env.UNSUBSCRIBE_REQUIRE_READY ||= 'false';
process.env.JWT_SECRET             = 'test-jwt-retry';

const db = (await import('./db.js')).default;
const { runRetries } = await import('./services/ProvisioningRetryService.js');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const now = new Date().toISOString();

const serverId = Number(
  db.prepare("INSERT INTO servers (label, apiKey, status, createdAt) VALUES ('retry-srv','RETRY-KEY','online',?)")
    .run(now).lastInsertRowid
);

// nginx phases: all OK (no PENDING TLS) so nginxNeedsRetry returns false
// → runRetries only runs scheduleReverifyTask, no external calls needed
const nginxPhasesOk = JSON.stringify({
  mailNode:     { status: 'DONE',   phases: {} },
  cloudflare:   { status: 'NOT_RUN', phases: {} },
  nginx:        { status: 'DONE',   phases: { unsubscribe: { status:'OK' }, click: { status:'OK' }, tls_unsubscribe: { status:'OK' }, tls_click: { status:'OK' } } },
  ptr:          { status: 'MANUAL', message: 'Set PTR manually' },
  verification: { status: 'PENDING', reasons: [] },
  updatedAt: now,
});

function mkIdentity(domain, verificationStatus = 'NOT_READY') {
  return Number(db.prepare(`
    INSERT INTO sender_identities
      (serverId, domain, ip, fromAddr, fromName, dkimSelector,
       status, verificationStatus, provisioningStatus,
       provisioningPhases, dailyLimit, dailySentCount, createdAt)
    VALUES (?, ?, '1.2.3.4', ?, 'T', 'mail',
            'active', ?, 'DONE', ?, 50, 0, ?)
  `).run(serverId, domain, `s@${domain}`, verificationStatus, nginxPhasesOk, now).lastInsertRowid);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('runRetries: does not create reverify task for READY identity', async () => {
  const id = mkIdentity('ready-test.example', 'READY');
  await runRetries();
  const tasks = db.prepare('SELECT id FROM provisioning_tasks WHERE identityId=?').all(id);
  assert.equal(tasks.length, 0, 'READY identities must not get reverify tasks');
});

test('runRetries: creates reverify task for DONE + NOT_READY identity', async () => {
  const id = mkIdentity('notready-test.example', 'NOT_READY');
  await runRetries();
  const task = db.prepare("SELECT taskType, status FROM provisioning_tasks WHERE identityId=?").get(id);
  assert.ok(task, 'Expected a reverify task to be created');
  assert.equal(task.taskType, 'reverify');
  assert.equal(task.status, 'PENDING');
});

test('runRetries: respects cooldown — no duplicate task within window', async () => {
  const id = mkIdentity('cooldown-test.example', 'NOT_READY');
  await runRetries();

  const count1 = db.prepare('SELECT count(*) AS n FROM provisioning_tasks WHERE identityId=?').get(id).n;
  assert.equal(count1, 1, 'First run should create one task');

  // Simulate: the task is now PENDING (cooldown was set by first run)
  // Running again should NOT create a second task
  await runRetries();

  const count2 = db.prepare('SELECT count(*) AS n FROM provisioning_tasks WHERE identityId=?').get(id).n;
  assert.equal(count2, 1, 'Second run must not create duplicate (task still PENDING)');
});

test('runRetries: does not create task when existing PENDING task is present', async () => {
  const id = mkIdentity('existing-task-test.example', 'NOT_READY');
  // Pre-insert a PENDING task
  db.prepare("INSERT INTO provisioning_tasks (identityId, serverId, status, taskType, requestedAt) VALUES (?,'"+serverId+"','PENDING','provision',?)")
    .run(id, now);

  await runRetries();

  const count = db.prepare('SELECT count(*) AS n FROM provisioning_tasks WHERE identityId=?').get(id).n;
  assert.equal(count, 1, 'Must not create reverify when a PENDING task already exists');
});

test('runRetries: updates nextReverifyAt cooldown after scheduling', async () => {
  const id = mkIdentity('cooldown-ts-test.example', 'NOT_READY');
  await runRetries();

  const si = db.prepare('SELECT nextReverifyAt FROM sender_identities WHERE id=?').get(id);
  assert.ok(si.nextReverifyAt, 'nextReverifyAt should be set after scheduling');
  assert.ok(new Date(si.nextReverifyAt) > new Date(), 'cooldown must be in the future');
});

test('runRetries: no OVH API calls — ptr phase is never automatically retried', async () => {
  // OvhService.js must not exist (verifies the file was never created)
  let imported = false;
  try {
    await import('./services/OvhService.js');
    imported = true;
  } catch {
    imported = false;
  }
  assert.equal(imported, false, 'OvhService.js must not exist — OVH PTR automation is intentionally removed');
});

test('runRetries: ptr phase stays MANUAL after retry cycle', async () => {
  const id = mkIdentity('ptr-manual-test.example', 'NOT_READY');
  await runRetries();
  const si = db.prepare('SELECT provisioningPhases FROM sender_identities WHERE id=?').get(id);
  const phases = JSON.parse(si.provisioningPhases || '{}');
  // ptr must remain MANUAL — retryIdentity must not change it
  assert.equal(phases.ptr?.status, 'MANUAL');
});
