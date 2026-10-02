// Unit tests for ProvisioningRetryService.
// Real in-memory DB; all external effects (controller pipeline + strict host
// health probe) are injected so no network / CF / certbot / sudo is touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH                = ':memory:';
process.env.CF_API_TOKEN           = '';          // disable CF automation
process.env.UNSUBSCRIBE_REQUIRE_READY ||= 'false';
process.env.JWT_SECRET             = 'test-jwt-retry';

const db = (await import('./db.js')).default;
const { runRetries, controllerNeedsRetry } = await import('./services/ProvisioningRetryService.js');

// ── Injected stubs (default: do nothing / report healthy) ──────────────────────
const noopProvision = async () => {};
const healthyProbe  = async () => ({ ok: true,  hosts: { click: { ok: true  }, unsubscribe: { ok: true  } } });
const brokenClick   = async () => ({ ok: false, hosts: { click: { ok: false }, unsubscribe: { ok: true  } } });
const brokenUnsub   = async () => ({ ok: false, hosts: { click: { ok: true  }, unsubscribe: { ok: false } } });

// run() always injects safe defaults so a test never hits the real pipeline/probe
// for identities created by OTHER tests (shared in-memory DB).
function run(opts = {}) {
  return runRetries({ provisioner: noopProvision, hostsHealthy: healthyProbe, ...opts });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
const now = new Date().toISOString();
const serverId = Number(
  db.prepare("INSERT INTO servers (label, apiKey, status, createdAt) VALUES ('retry-srv','RETRY-KEY','online',?)")
    .run(now).lastInsertRowid
);

const phasesComplete = JSON.stringify({
  mailNode:     { status: 'DONE',    phases: {} },
  cloudflare:   { status: 'NOT_RUN', phases: {} },
  dns:          { status: 'OK',      message: 'resolves' },
  nginx:        { status: 'DONE',    phases: { unsubscribe: { status:'OK' }, click: { status:'OK' }, tls_unsubscribe: { status:'OK' }, tls_click: { status:'OK' } } },
  ptr:          { status: 'MANUAL',  message: 'Set PTR manually' },
  verification: { status: 'PENDING', reasons: [] },
  updatedAt: now,
});

const phasesNeedingNginx = JSON.stringify({
  mailNode:     { status: 'DONE',    phases: {} },
  cloudflare:   { status: 'OK',      phases: { a_unsubscribe: { status:'OK' }, a_click: { status:'OK' } } },
  dns:          { status: 'PENDING', message: 'waiting for DNS' },
  nginx:        { status: 'PENDING', message: 'deferred', phases: {} },
  ptr:          { status: 'MANUAL',  message: 'Set PTR manually' },
  verification: { status: 'PENDING', reasons: [] },
  updatedAt: now,
});

// Matches what serawin.net has in production: only the verification phase is
// present because the identity was set up before the controller pipeline existed.
const phasesVerificationOnly = JSON.stringify({
  verification: { status: 'READY', reasons: [], checkedAt: now },
});

function mkIdentity(domain, verificationStatus = 'NOT_READY', phasesBlob = phasesComplete) {
  return Number(db.prepare(`
    INSERT INTO sender_identities
      (serverId, domain, ip, fromAddr, fromName, dkimSelector,
       status, verificationStatus, provisioningStatus,
       provisioningPhases, dailyLimit, dailySentCount, createdAt)
    VALUES (?, ?, '1.2.3.4', ?, 'T', 'mail',
            'active', ?, 'DONE', ?, 50, 0, ?)
  `).run(serverId, domain, `s@${domain}`, verificationStatus, phasesBlob, now).lastInsertRowid);
}

// Creates a manually-provisioned identity (provisioningStatus = 'unprovisioned'),
// as serawin.net was set up before the controller pipeline existed.
function mkManualIdentity(domain, verificationStatus = 'READY', phasesBlob = phasesVerificationOnly) {
  return Number(db.prepare(`
    INSERT INTO sender_identities
      (serverId, domain, ip, fromAddr, fromName, dkimSelector,
       status, verificationStatus, provisioningStatus,
       provisioningPhases, dailyLimit, dailySentCount, createdAt)
    VALUES (?, ?, '1.2.3.4', ?, 'T', 'mail',
            'active', ?, 'unprovisioned', ?, 50, 0, ?)
  `).run(serverId, domain, `s@${domain}`, verificationStatus, phasesBlob, now).lastInsertRowid);
}

function phasesOf(id) {
  return JSON.parse(db.prepare('SELECT provisioningPhases FROM sender_identities WHERE id=?').get(id).provisioningPhases || '{}');
}

// ── Reverify scheduling (non-READY flow) ───────────────────────────────────────

test('runRetries: does not create reverify task for READY identity', async () => {
  const id = mkIdentity('ready-test.example', 'READY');
  await run();
  const tasks = db.prepare('SELECT id FROM provisioning_tasks WHERE identityId=?').all(id);
  assert.equal(tasks.length, 0, 'READY identities must not get reverify tasks');
});

test('runRetries: creates reverify task for DONE + NOT_READY identity', async () => {
  const id = mkIdentity('notready-test.example', 'NOT_READY');
  await run();
  const task = db.prepare("SELECT taskType, status FROM provisioning_tasks WHERE identityId=?").get(id);
  assert.ok(task, 'Expected a reverify task to be created');
  assert.equal(task.taskType, 'reverify');
  assert.equal(task.status, 'PENDING');
});

test('runRetries: respects cooldown — no duplicate task within window', async () => {
  const id = mkIdentity('cooldown-test.example', 'NOT_READY');
  await run();
  const count1 = db.prepare('SELECT count(*) AS n FROM provisioning_tasks WHERE identityId=?').get(id).n;
  assert.equal(count1, 1, 'First run should create one task');
  await run();
  const count2 = db.prepare('SELECT count(*) AS n FROM provisioning_tasks WHERE identityId=?').get(id).n;
  assert.equal(count2, 1, 'Second run must not create duplicate (task still PENDING)');
});

test('runRetries: does not create task when existing PENDING task is present', async () => {
  const id = mkIdentity('existing-task-test.example', 'NOT_READY');
  db.prepare("INSERT INTO provisioning_tasks (identityId, serverId, status, taskType, requestedAt) VALUES (?,?,'PENDING','provision',?)")
    .run(id, serverId, now);
  await run();
  const count = db.prepare('SELECT count(*) AS n FROM provisioning_tasks WHERE identityId=?').get(id).n;
  assert.equal(count, 1, 'Must not create reverify when a PENDING task already exists');
});

test('runRetries: updates nextReverifyAt cooldown after scheduling', async () => {
  const id = mkIdentity('cooldown-ts-test.example', 'NOT_READY');
  await run();
  const si = db.prepare('SELECT nextReverifyAt FROM sender_identities WHERE id=?').get(id);
  assert.ok(si.nextReverifyAt, 'nextReverifyAt should be set after scheduling');
  assert.ok(new Date(si.nextReverifyAt) > new Date(), 'cooldown must be in the future');
});

// ── Controller pipeline routing (non-READY) ────────────────────────────────────

test('runRetries: routes incomplete-pipeline identity through controller provisioner', async () => {
  const id = mkIdentity('gate-retry.example', 'NOT_READY', phasesNeedingNginx);
  const calls = [];
  await run({ provisioner: async (identity) => { calls.push(identity.id); } });
  assert.ok(calls.includes(id), 'identity with pending DNS/nginx must be routed to the controller pipeline');
});

test('runRetries: does NOT call controller provisioner when pipeline already complete', async () => {
  const id = mkIdentity('complete-pipeline.example', 'NOT_READY', phasesComplete);
  const calls = [];
  await run({ provisioner: async (identity) => { calls.push(identity.id); } });
  assert.ok(!calls.includes(id), 'completed pipeline must not re-run the controller provisioner');
  const task = db.prepare("SELECT taskType FROM provisioning_tasks WHERE identityId=?").get(id);
  assert.equal(task?.taskType, 'reverify');
});

test('controllerNeedsRetry: gate logic (pending DNS/nginx → true, complete → false)', async () => {
  assert.equal(controllerNeedsRetry(JSON.parse(phasesNeedingNginx)), true);
  assert.equal(controllerNeedsRetry(JSON.parse(phasesComplete)), false);
  assert.equal(controllerNeedsRetry({ nginx: { status: 'DONE', phases: {} } }), true); // dns missing
});

// ── Fix A: heal READY-but-incomplete controller hosts ──────────────────────────

test('READY + broken click host → controller provisioning is triggered (healed)', async () => {
  const id = mkIdentity('ready-broken-click.example', 'READY', phasesComplete);
  const calls = [];
  await run({
    hostsHealthy: brokenClick,
    provisioner:  async (identity) => { calls.push(identity.id); },
  });
  assert.ok(calls.includes(id), 'a READY identity with a broken click host must be healed');
  // No mail-node reverify for an already-READY identity
  const task = db.prepare("SELECT id FROM provisioning_tasks WHERE identityId=?").get(id);
  assert.equal(task, undefined, 'must NOT schedule a reverify for a READY identity');
  // Controller health recorded for the UI
  assert.equal(phasesOf(id).controllerHealth?.status, 'FAILED');
});

test('READY + broken unsubscribe host → controller provisioning is triggered (healed)', async () => {
  const id = mkIdentity('ready-broken-unsub.example', 'READY', phasesComplete);
  const calls = [];
  await run({
    hostsHealthy: brokenUnsub,
    provisioner:  async (identity) => { calls.push(identity.id); },
  });
  assert.ok(calls.includes(id), 'a READY identity with a broken unsubscribe host must be healed');
  assert.equal(phasesOf(id).controllerHealth?.status, 'FAILED');
});

test('READY + both controller hosts healthy → NO provisioning (no churn)', async () => {
  const id = mkIdentity('ready-healthy.example', 'READY', phasesComplete);
  const calls = [];
  await run({
    hostsHealthy: healthyProbe,
    provisioner:  async (identity) => { calls.push(identity.id); },
  });
  assert.ok(!calls.includes(id), 'a healthy READY identity must not trigger provisioning');
  assert.equal(phasesOf(id).controllerHealth?.status, 'OK');
  const task = db.prepare("SELECT id FROM provisioning_tasks WHERE identityId=?").get(id);
  assert.equal(task, undefined, 'no reverify for healthy READY identity');
});

test('Calerion-like recovery: READY + legacy (no phase blob) + broken click → healed', async () => {
  // Legacy identity: READY, no provisioningPhases at all (predates the pipeline).
  const id = Number(db.prepare(`
    INSERT INTO sender_identities
      (serverId, domain, ip, fromAddr, fromName, dkimSelector,
       status, verificationStatus, provisioningStatus, dailyLimit, dailySentCount, createdAt)
    VALUES (?, 'calerion-like.example', '1.2.3.4', 's@calerion-like.example', 'T', 'mail',
            'active', 'READY', 'DONE', 50, 0, ?)
  `).run(serverId, now).lastInsertRowid);
  const calls = [];
  await run({
    hostsHealthy: brokenClick,
    provisioner:  async (identity) => { calls.push(identity.id); },
  });
  assert.ok(calls.includes(id), 'legacy READY identity with a broken click host must be detected and healed');
  assert.equal(phasesOf(id).controllerHealth?.status, 'FAILED');
});

// ── Fix B: manually-provisioned (unprovisioned + READY) identities ────────────
// Covers serawin.net-style identities: set up before the controller pipeline
// existed, provisioningStatus = 'unprovisioned', verificationStatus = 'READY'.
// Previously excluded from the retry loop → permanent false NEEDS_ATTENTION.

test('PR-1: unprovisioned + READY identity IS included in health check', async () => {
  const id = mkManualIdentity('pr1-manual.example', 'READY');
  await run();
  const phases = phasesOf(id);
  assert.ok(phases.controllerHealth, 'controllerHealth must be written for unprovisioned+READY identity');
  assert.ok(phases.controllerHealth.checkedAt, 'checkedAt must be set');
});

test('PR-2: unprovisioned + NOT_READY identity is excluded from health check', async () => {
  const id = mkManualIdentity('pr2-notready.example', 'NOT_READY');
  await run();
  const phases = phasesOf(id);
  assert.equal(phases.controllerHealth, undefined,
    'unprovisioned+NOT_READY must not be health-checked (excluded from candidates query)');
});

test('PR-3: serawin.net scenario — unprovisioned + READY + healthy hosts → controllerHealth OK, no reprovisioning', async () => {
  const id = mkManualIdentity('pr3-serawin.example', 'READY', phasesVerificationOnly);
  const calls = [];
  await run({
    hostsHealthy: healthyProbe,
    provisioner:  async (identity) => { calls.push(identity.id); },
  });
  assert.equal(phasesOf(id).controllerHealth?.status, 'OK',
    'healthy manually-provisioned identity must get controllerHealth = OK (clears NEEDS_ATTENTION)');
  assert.ok(!calls.includes(id),
    'healthy manually-provisioned identity must NOT trigger controller reprovisioning');
});

test('PR-4: unprovisioned + READY + broken host → controller healing IS triggered', async () => {
  const id = mkManualIdentity('pr4-broken.example', 'READY', phasesVerificationOnly);
  const calls = [];
  await run({
    hostsHealthy: brokenClick,
    provisioner:  async (identity) => { calls.push(identity.id); },
  });
  assert.ok(calls.includes(id),
    'manually-provisioned identity with a broken click host must be passed to the controller pipeline');
  assert.equal(phasesOf(id).controllerHealth?.status, 'FAILED');
});

test('PR-5: unprovisioned + READY identity never receives a reverify task', async () => {
  const id = mkManualIdentity('pr5-noreverify.example', 'READY');
  await run();
  const task = db.prepare('SELECT id FROM provisioning_tasks WHERE identityId=?').get(id);
  assert.equal(task, undefined, 'READY identity must never get a reverify task, regardless of provisioningStatus');
});

// ── Guards ─────────────────────────────────────────────────────────────────────

test('runRetries: no OVH — OvhService.js must not exist', async () => {
  let imported = false;
  try { await import('./services/OvhService.js'); imported = true; } catch { imported = false; }
  assert.equal(imported, false, 'OVH PTR automation must remain absent');
});

test('runRetries: ptr phase stays MANUAL after retry cycle', async () => {
  const id = mkIdentity('ptr-manual-test.example', 'NOT_READY');
  await run();
  const phases = phasesOf(id);
  assert.equal(phases.ptr?.status, 'MANUAL');
});
