// POST /api/sender-identities idempotency: re-running add-identity.sh with the
// same parameters must not create duplicate rows. The route returns the existing
// row on a second call with the same (serverId, fromAddr).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.DB_PATH            ||= ':memory:';
process.env.UNSUBSCRIBE_SECRET ||= 'test-secret';
process.env.UNSUBSCRIBE_REQUIRE_READY ||= 'false';

const db = (await import('./db.js')).default;
const senderIdentitiesRouter = (await import('./routes/sender-identities.js')).default;

const app = express();
app.use(express.json());
app.use('/api/sender-identities', senderIdentitiesRouter);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const now = new Date().toISOString();
const srv = Number(
  db.prepare("INSERT INTO servers (label, apiKey, status, createdAt) VALUES ('test', 'key-idem', 'online', ?)").run(now).lastInsertRowid
);

const post = (body) =>
  fetch(`${BASE}/api/sender-identities`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

const rowCount = () =>
  db.prepare('SELECT COUNT(*) AS n FROM sender_identities WHERE serverId = ?').get(srv).n;

// ── 1. First POST creates the row ─────────────────────────────────────────────
test('first POST creates a new sender identity row', async () => {
  const res = await post({
    serverId: srv, domain: 'example.com', ip: '1.2.3.4',
    fromAddr: 'noreply@example.com', fromName: 'Test', dkimSelector: 'mail',
    dailyLimit: 100, warmupStage: 1,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.domain, 'example.com');
  assert.equal(res.body.fromAddr, 'noreply@example.com');
  assert.ok(res.body.id, 'must return an id');
  assert.equal(rowCount(), 1);
});

// ── 2. Identical second POST returns existing row — no new row created ─────────
test('second POST with same fromAddr returns existing row without creating a duplicate', async () => {
  const first = await post({
    serverId: srv, domain: 'example.com', ip: '1.2.3.4',
    fromAddr: 'noreply@example.com', fromName: 'Test', dkimSelector: 'mail',
    dailyLimit: 100, warmupStage: 1,
  });
  const second = await post({
    serverId: srv, domain: 'example.com', ip: '1.2.3.4',
    fromAddr: 'noreply@example.com', fromName: 'Test', dkimSelector: 'mail',
    dailyLimit: 100, warmupStage: 1,
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.id, first.body.id, 'must return the same row id');
  assert.equal(rowCount(), 1, 'must not create a duplicate row');
});

// ── 3. Different fromAddr on same server/domain creates a new row ─────────────
test('different fromAddr on same server creates a distinct row', async () => {
  await post({
    serverId: srv, domain: 'example.com', ip: '1.2.3.4',
    fromAddr: 'support@example.com', fromName: 'Support', dkimSelector: 'mail',
    dailyLimit: 50, warmupStage: 1,
  });
  assert.equal(rowCount(), 2, 'noreply@ and support@ must be separate identities');
});

// ── 4. Multiple independent identities on same server — no cross-contamination ─
test('multiple identities on same server are independent', async () => {
  const r1 = await post({
    serverId: srv, domain: 'alpha.example', ip: '10.0.0.1',
    fromAddr: 'hi@alpha.example', fromName: 'Alpha', dkimSelector: 'mail',
    dailyLimit: 200, warmupStage: 2,
  });
  const r2 = await post({
    serverId: srv, domain: 'beta.example', ip: '10.0.0.2',
    fromAddr: 'hi@beta.example', fromName: 'Beta', dkimSelector: 'mail',
    dailyLimit: 300, warmupStage: 3,
  });
  assert.ok(r1.body.id !== r2.body.id, 'distinct identities must have distinct ids');
  assert.equal(r1.body.domain, 'alpha.example');
  assert.equal(r2.body.domain, 'beta.example');
  assert.equal(r1.body.ip, '10.0.0.1');
  assert.equal(r2.body.ip, '10.0.0.2');
  assert.equal(r1.body.dailyLimit, 200);
  assert.equal(r2.body.dailyLimit, 300);
});

// ── 5. Idempotent re-POST for each of the two new identities returns same rows ──
test('re-POSTing each of two identities returns their own existing rows', async () => {
  const alpha1 = await post({
    serverId: srv, domain: 'alpha.example', ip: '10.0.0.1',
    fromAddr: 'hi@alpha.example', fromName: 'Alpha', dkimSelector: 'mail',
    dailyLimit: 200, warmupStage: 2,
  });
  const beta1 = await post({
    serverId: srv, domain: 'beta.example', ip: '10.0.0.2',
    fromAddr: 'hi@beta.example', fromName: 'Beta', dkimSelector: 'mail',
    dailyLimit: 300, warmupStage: 3,
  });
  // Re-POST alpha; must not return beta's row
  const alpha2 = await post({
    serverId: srv, domain: 'alpha.example', ip: '10.0.0.1',
    fromAddr: 'hi@alpha.example', fromName: 'Alpha', dkimSelector: 'mail',
    dailyLimit: 200, warmupStage: 2,
  });
  assert.equal(alpha2.body.id, alpha1.body.id, 'alpha re-POST must return alpha row');
  assert.notEqual(alpha2.body.id, beta1.body.id, 'alpha re-POST must not return beta row');
});
