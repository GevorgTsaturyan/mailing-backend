// Tests for the token-based unsubscribe system (RFC 8058 one-click + body flow).
// Runs against an in-memory SQLite DB and a bare Express app mounting only the
// unsubscribe router — no full server boot, no touching the dev database.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

// Env must be set BEFORE the modules that read it are imported. Static imports are
// hoisted, so we use dynamic import() below (after these assignments run).
process.env.UNSUBSCRIBE_SECRET   ||= 'test-unsubscribe-secret';
process.env.UNSUBSCRIBE_BASE_URL ||= 'https://unsubscribe.serawin.net';
process.env.DB_PATH              ||= ':memory:';

const db                 = (await import('./db.js')).default;
const { signToken, verifyToken, buildUnsubscribeUrl } = await import('./services/unsubscribeToken.js');
const unsubscribeRouter  = (await import('./routes/unsubscribe.js')).default;

const app = express();
app.use(unsubscribeRouter);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

// ── helpers ───────────────────────────────────────────────────────────────────

let seq = 0;
function newContact(status = 'pending') {
  const email = `unsub-${Date.now()}-${seq++}@example.com`;
  const r = db.prepare(
    "INSERT INTO contacts (firstName, lastName, email, status) VALUES ('T', 'User', ?, ?)"
  ).run(email, status);
  return { id: Number(r.lastInsertRowid), email };
}
const statusOf = (id) => db.prepare('SELECT status FROM contacts WHERE id = ?').get(id)?.status;
// Path (host-less) for our local test server, reusing the real signed token.
const pathFor  = (id) => '/u/' + buildUnsubscribeUrl(id).split('/u/')[1];

const formPost = (path) => fetch(BASE + path, {
  method:  'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body:    'List-Unsubscribe=One-Click',
});

// ── token unit tests ────────────────────────────────────────────────────────

test('token: sign/verify round-trips the payload', () => {
  const p = verifyToken(signToken({ c: 42, v: 1 }));
  assert.equal(p.c, 42);
});

test('token: tampered signature is rejected', () => {
  const t = signToken({ c: 42, v: 1 });
  const tampered = t.slice(0, -2) + (t.endsWith('AA') ? 'BB' : 'AA');
  assert.equal(verifyToken(tampered), null);
});

test('token: URL carries no plaintext email (no @ in token)', () => {
  const url = buildUnsubscribeUrl(42);
  assert.match(url, /^https:\/\/unsubscribe\.serawin\.net\/u\//);
  assert.doesNotMatch(url, /@/, 'unsubscribe URL must not embed an email address');
});

// ── Test 1 — GET does not unsubscribe ─────────────────────────────────────────

test('GET /u/:token renders a confirmation page and does NOT unsubscribe', async () => {
  const c = newContact();
  const res = await fetch(BASE + pathFor(c.id));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Unsubscribe/i);
  assert.match(html, /<form[^>]*method="POST"/i, 'must offer a POST confirmation form');
  assert.equal(statusOf(c.id), 'pending', 'GET must never mutate (scanner/prefetch-safe)');
});

// ── Test 2 — confirmation POST unsubscribes ───────────────────────────────────

test('POST /u/:token (confirmation form) unsubscribes the contact', async () => {
  const c = newContact();
  const res = await fetch(BASE + pathFor(c.id), { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(statusOf(c.id), 'unsubscribed');
});

// ── Test 3 — RFC 8058 one-click POST ──────────────────────────────────────────

test('POST /u/:token one-click (List-Unsubscribe=One-Click) unsubscribes', async () => {
  const c = newContact();
  const res = await formPost(pathFor(c.id));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(statusOf(c.id), 'unsubscribed');
});

// ── Test 4 — repeated one-click request is idempotent ─────────────────────────

test('repeated one-click POST is idempotent and stays successful', async () => {
  const c = newContact();
  const r1 = await formPost(pathFor(c.id));
  const r2 = await formPost(pathFor(c.id));
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(statusOf(c.id), 'unsubscribed');
  // Exactly one contact row, still unsubscribed — no duplicate/second store.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM contacts WHERE id=?').get(c.id).n, 1);
});

test('one-click on an already-unsubscribed contact still returns success', async () => {
  const c = newContact('unsubscribed');
  const res = await formPost(pathFor(c.id));
  assert.equal(res.status, 200);
  assert.equal(statusOf(c.id), 'unsubscribed');
});

// ── Test 5 — invalid / tampered token ─────────────────────────────────────────

test('tampered token is rejected and unsubscribes nobody', async () => {
  const c = newContact();
  const good = pathFor(c.id);
  const bad  = good.slice(0, -2) + (good.endsWith('AA') ? 'BB' : 'AA');
  const res = await fetch(BASE + bad, { method: 'POST' });
  assert.equal(res.status, 404);
  assert.equal(statusOf(c.id), 'pending', 'a forged token must not unsubscribe the real contact');
});

test('valid signature for a non-existent contact returns 404', async () => {
  const res = await fetch(BASE + '/u/' + buildUnsubscribeUrl(999999).split('/u/')[1], { method: 'POST' });
  assert.equal(res.status, 404);
});
