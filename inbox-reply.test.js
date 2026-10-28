// Inbox replies: POST /api/inbox/:id/reply queues a threaded, plain-text reply job
// from the identity that owns the mailbox; GET /api/inbox/:id lists replies.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'inbox-reply-test-secret';

const db = (await import('./db.js')).default;
const inboxRouter = (await import('./routes/inbox.js')).default;
const { requireAuth } = await import('./middleware/auth.js');
const { quoteOriginal, replySubject } = await import('./services/InboxReplyService.js');

const app = express();
app.use(express.json());
app.use('/api', requireAuth);
app.use('/api/inbox', inboxRouter);

let server, BASE;
const TOKEN = jwt.sign({ id: 1, username: 'admin' }, process.env.JWT_SECRET);
before(() => new Promise((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${server.address().port}`; r(); }); }));
after(() => new Promise((r) => server.close(r)));

const call = (method, path, body) => fetch(BASE + path, {
  method,
  headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (res) => ({ status: res.status, json: await res.json() }));

const now = new Date().toISOString();
const serverId = Number(db.prepare("INSERT INTO servers (label, apiKey, status, createdAt) VALUES ('n','KEY-REPLY','online',?)").run(now).lastInsertRowid);
const identityId = Number(db.prepare(`
  INSERT INTO sender_identities (serverId, domain, ip, fromAddr, fromName, status, verificationStatus, createdAt)
  VALUES (?, 'ardovia.co', '1.2.3.4', 'support@ardovia.co', 'Ardovia', 'active', 'READY', ?)
`).run(serverId, now).lastInsertRowid);

let seq = 0;
function inbound(o = {}) {
  return Number(db.prepare(`
    INSERT INTO inbound_messages (message_id, from_address, from_name, to_address, reply_to, subject, text_body,
      received_at, mailbox, domain, msg_references, server_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    o.message_id === undefined ? `<m${seq++}@gmail.com>` : o.message_id,
    o.from_address ?? 'edgar@gmail.com', o.from_name ?? 'Edgar', o.to_address ?? 'support@ardovia.co',
    o.reply_to ?? null, o.subject ?? 'Re: your account', o.text_body ?? 'Thanks!\nBest',
    now, o.mailbox ?? 'support@ardovia.co', 'ardovia.co', o.msg_references ?? null, serverId, now,
  ).lastInsertRowid);
}

test('replySubject adds a single Re:', () => {
  assert.equal(replySubject('Hello'), 'Re: Hello');
  assert.equal(replySubject('RE: Hello'), 'RE: Hello');
  assert.equal(replySubject(''), 'Re: (no subject)');
});

test('quoteOriginal quotes every line', () => {
  const q = quoteOriginal({ from_address: 'a@b.c', received_at: now, text_body: 'one\ntwo' });
  assert.match(q, /wrote:\n> one\n> two$/);
});

test('reply queues a threaded plain-text job from the mailbox identity', async () => {
  const id = inbound({ msg_references: '<root@ardovia.co>' });
  const res = await call('POST', `/api/inbox/${id}/reply`, { body: 'Hi Edgar, glad to help.' });
  assert.equal(res.status, 201);
  assert.equal(res.json.from_address, 'support@ardovia.co');
  assert.equal(res.json.to_address, 'edgar@gmail.com');
  assert.equal(res.json.job_status, 'PENDING');

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(res.json.job_id);
  assert.equal(job.identity_id, identityId);
  assert.equal(job.recipient, 'edgar@gmail.com');
  assert.equal(job.subject, 'Re: your account');
  assert.equal(job.content_type, 'text');
  assert.equal(job.contact_id, null);           // no unsubscribe link / campaign tracking
  assert.equal(job.in_reply_to, `<m${seq - 1}@gmail.com>`);
  assert.equal(job.msg_references, `<root@ardovia.co> <m${seq - 1}@gmail.com>`);
  assert.match(job.body, /^Hi Edgar, glad to help\.\n\nOn .* wrote:\n> Thanks!\n> Best$/);

  const detail = await call('GET', `/api/inbox/${id}`);
  assert.equal(detail.json.replies.length, 1);
  assert.equal(detail.json.reply_from, 'support@ardovia.co');
  assert.equal(detail.json.is_read, 1);
});

test('reply goes to Reply-To when present and can omit the quote', async () => {
  const id = inbound({ reply_to: 'Edgar <edgar.work@example.com>' });
  const res = await call('POST', `/api/inbox/${id}/reply`, { body: 'Short', includeQuote: false });
  assert.equal(res.status, 201);
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(res.json.job_id);
  assert.equal(job.recipient, 'edgar.work@example.com');
  assert.equal(job.body, 'Short');
});

test('empty body and unknown mailbox are rejected', async () => {
  const id = inbound();
  assert.equal((await call('POST', `/api/inbox/${id}/reply`, { body: '  ' })).status, 400);
  const other = inbound({ mailbox: 'info@unknown.com', to_address: 'info@unknown.com' });
  const res = await call('POST', `/api/inbox/${other}/reply`, { body: 'x' });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /No active sender identity/);
  assert.equal((await call('POST', '/api/inbox/99999/reply', { body: 'x' })).status, 404);
});

test('deleting a message removes its replies', async () => {
  const id = inbound();
  await call('POST', `/api/inbox/${id}/reply`, { body: 'x' });
  assert.equal((await call('DELETE', `/api/inbox/${id}`)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inbox_replies WHERE inbound_message_id = ?').get(id).n, 0);
});
