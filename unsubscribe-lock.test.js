import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
process.env.DB_PATH ||= ':memory:';
process.env.UNSUBSCRIBE_SECRET ||= 'test-unsubscribe-secret';
const db = (await import('./db.js')).default;
const contacts = (await import('./routes/contacts.js')).default;
const failed = (await import('./routes/failed-mails.js')).default;
const unsub = (await import('./routes/unsubscribe.js')).default;
const { signToken } = await import('./services/unsubscribeToken.js');
const { isContactSuppressed } = await import('./services/SuppressionService.js');
const app = express(); app.use(express.json());
app.use('/api/contacts', contacts); app.use('/api/failed-mails', failed); app.use('/', unsub);
const server = app.listen(0); after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}`;
const mk = (email, status = 'pending', reason = null) => Number(db.prepare('INSERT INTO contacts (firstName,lastName,email,status,suppression_reason) VALUES (?,?,?,?,?)').run('A', 'B', email, status, reason).lastInsertRowid);
const put = (id, body) => fetch(`${base}/api/contacts/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('operator cannot re-subscribe an unsubscribed contact (status stays, still suppressed)', async () => {
  const id = mk('u1@x.com', 'unsubscribed', 'unsubscribe');
  const r = await put(id, { status: 'pending', firstName: 'New' });
  const c = await r.json();
  assert.equal(c.status, 'unsubscribed'); assert.equal(c.firstName, 'New');
  assert.equal(isContactSuppressed(id), true);
});

test('complaint is locked too, even if status was changed elsewhere', async () => {
  const id = mk('c1@x.com', 'pending', 'complaint');
  const c = await (await put(id, { status: 'pending' })).json();
  assert.equal(c.status, 'unsubscribed');
  assert.equal(isContactSuppressed(id), true);
});

test('failed-mails reset: lifts a bounce, never an unsubscribe', async () => {
  const b = mk('b1@x.com', 'failed', 'hard_bounce');
  const u = mk('b2@x.com', 'unsubscribed', 'unsubscribe');
  assert.equal((await (await fetch(`${base}/api/failed-mails/${b}/reset`, { method: 'POST' })).json()).statusLocked, false);
  assert.equal((await (await fetch(`${base}/api/failed-mails/${u}/reset`, { method: 'POST' })).json()).statusLocked, true);
  assert.equal(isContactSuppressed(b), false);
  assert.equal(isContactSuppressed(u), true);
});

test('malformed but validly signed unsubscribe token → 404, not 500', async () => {
  const bad = signToken({ c: { x: 1 }, v: 1 });
  assert.equal((await fetch(`${base}/u/${bad}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })).status, 404);
  assert.equal((await fetch(`${base}/u/${bad}`)).status, 404);
});
