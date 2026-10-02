// Tests for the Inbox / Replies feature.
// Covers:
//   POST /api/nodes/inbound-messages — authentication, insertion, deduplication,
//     malformed input, HTML sanitization
//   GET  /api/inbox               — pagination, domain filter, read filter, search
//   GET  /api/inbox/stats         — unread count
//   GET  /api/inbox/:id           — full message
//   PATCH /api/inbox/:id/read
//   PATCH /api/inbox/:id/unread
//   Authorization (JWT required for user endpoints)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http   from 'node:http';
import express from 'express';
import jwt    from 'jsonwebtoken';

process.env.UNSUBSCRIBE_SECRET          ||= 'test-inbox-secret';
process.env.DB_PATH                      = ':memory:';
process.env.UNSUBSCRIBE_REQUIRE_READY   ||= 'false';

const TEST_SECRET = 'inbox-test-jwt-secret';
process.env.JWT_SECRET = TEST_SECRET;

const db           = (await import('./db.js')).default;
const nodesRouter  = (await import('./routes/nodes.js')).default;
const inboxRouter  = (await import('./routes/inbox.js')).default;
const { requireAuth } = await import('./middleware/auth.js');

const app = express();
app.use(express.json());
app.use('/api/nodes', nodesRouter);
app.use('/api', requireAuth);
app.use('/api/inbox', inboxRouter);

let server, BASE;
before(() => new Promise((resolve) => {
  server = app.listen(0, '127.0.0.1', () => {
    BASE = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
after(() => server.close());

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const opts = {
      hostname: '127.0.0.1',
      port:     server.address().port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
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

// ── Fixtures ──────────────────────────────────────────────────────────────────

const now = new Date().toISOString();
const API_KEY = 'INBOX-TEST-KEY-001';

const serverId = Number(
  db.prepare("INSERT INTO servers (label, apiKey, status, createdAt) VALUES ('inbox-srv', ?, 'online', ?)")
    .run(API_KEY, now).lastInsertRowid
);

// Helper to POST messages as the mail-node would
async function nodePost(messages) {
  return req('POST', '/api/nodes/inbound-messages', { apiKey: API_KEY, messages });
}

// Helper to insert a single message and return its id
async function insertOne(overrides = {}) {
  const msg = {
    message_id:   overrides.message_id   || `<${Date.now()}-${Math.random()}@test.com>`,
    from_address: overrides.from_address || 'sender@gmail.com',
    from_name:    overrides.from_name    || 'Test Sender',
    to_address:   overrides.to_address   || 'support@calerion.org',
    reply_to:     overrides.reply_to     || null,
    subject:      overrides.subject      || 'Test subject',
    text_body:    overrides.text_body    || 'Plain text body.',
    html_body:    overrides.html_body    || null,
    received_at:  overrides.received_at  || now,
    mailbox:      overrides.mailbox      || overrides.to_address || 'support@calerion.org',
    has_attachments: overrides.has_attachments || 0,
    in_reply_to:  overrides.in_reply_to  || null,
    ...overrides,
  };
  const r = await nodePost([msg]);
  assert.equal(r.status, 200);
  // Return id from DB (look up by message_id)
  const row = db.prepare('SELECT id FROM inbound_messages WHERE message_id = ?').get(msg.message_id);
  return row?.id;
}

// ── Node ingestion: authentication ────────────────────────────────────────────

test('INBOX-A: invalid apiKey → 401', async () => {
  const r = await req('POST', '/api/nodes/inbound-messages', {
    apiKey: 'WRONG-KEY',
    messages: [],
  });
  assert.equal(r.status, 401);
  assert.ok(r.body.error);
});

test('INBOX-B: missing messages array → 400', async () => {
  const r = await req('POST', '/api/nodes/inbound-messages', {
    apiKey: API_KEY,
    messages: 'not-an-array',
  });
  assert.equal(r.status, 400);
});

// ── Node ingestion: basic insertion ──────────────────────────────────────────

test('INBOX-C: valid message is inserted, response counts correctly', async () => {
  const r = await nodePost([{
    message_id:   '<inbox-c@test.com>',
    from_address: 'alice@example.com',
    to_address:   'support@calerion.org',
    subject:      'Hello from Alice',
    text_body:    'Hi there!',
    received_at:  now,
    mailbox:      'support@calerion.org',
    has_attachments: 0,
  }]);
  assert.equal(r.status, 200);
  assert.equal(r.body.inserted, 1);
  assert.equal(r.body.duplicates, 0);
  assert.equal(r.body.errors, 0);
});

test('INBOX-D: duplicate message_id → not inserted again (idempotent)', async () => {
  const msg = {
    message_id:   '<inbox-d-dedup@test.com>',
    from_address: 'bob@example.com',
    to_address:   'support@ardovia.co',
    subject:      'Dedup test',
    text_body:    'First submission.',
    received_at:  now,
    mailbox:      'support@ardovia.co',
    has_attachments: 0,
  };

  const r1 = await nodePost([msg]);
  assert.equal(r1.body.inserted,   1);
  assert.equal(r1.body.duplicates, 0);

  const r2 = await nodePost([msg]);
  assert.equal(r2.body.inserted,   0);
  assert.equal(r2.body.duplicates, 1);

  const count = db.prepare('SELECT COUNT(*) as c FROM inbound_messages WHERE message_id = ?')
    .get('<inbox-d-dedup@test.com>').c;
  assert.equal(count, 1);
});

test('INBOX-E: message without to_address or mailbox → counted as error, not inserted', async () => {
  const r = await nodePost([{
    message_id:   '<inbox-e@test.com>',
    from_address: 'x@example.com',
    subject:      'Missing to',
    // No to_address, no mailbox
  }]);
  assert.equal(r.status, 200);
  assert.equal(r.body.errors, 1);
  assert.equal(r.body.inserted, 0);
});

test('INBOX-F: batch of mixed valid/dup/error counted correctly', async () => {
  const valid = {
    message_id: '<inbox-f-valid@test.com>',
    from_address: 'f@example.com',
    to_address: 'support@calerion.org',
    mailbox: 'support@calerion.org',
    subject: 'Valid',
    text_body: 'OK',
    received_at: now,
  };
  // Insert first to make it a dup
  await nodePost([valid]);

  const r = await nodePost([
    valid,                      // duplicate
    { from_address: 'g@x.com' }, // error (no to_address)
    {
      message_id: '<inbox-f-new@test.com>',
      from_address: 'h@example.com',
      to_address: 'support@serawin.net',
      mailbox: 'support@serawin.net',
      subject: 'New',
      text_body: 'New message',
      received_at: now,
    },
  ]);

  assert.equal(r.body.inserted,   1, 'one new message');
  assert.equal(r.body.duplicates, 1, 'one duplicate');
  assert.equal(r.body.errors,     1, 'one error');
});

// ── HTML sanitization ─────────────────────────────────────────────────────────

test('INBOX-G: HTML sanitization strips <script> tags', async () => {
  const r = await nodePost([{
    message_id:   '<inbox-g-xss@test.com>',
    from_address: 'attacker@evil.com',
    to_address:   'support@calerion.org',
    mailbox:      'support@calerion.org',
    subject:      'XSS attempt',
    html_body:    '<p>Hello</p><script>alert("xss")</script><b>World</b>',
    received_at:  now,
  }]);
  assert.equal(r.body.inserted, 1);

  const msg = db.prepare("SELECT html_body FROM inbound_messages WHERE message_id = '<inbox-g-xss@test.com>'").get();
  assert.ok(!msg.html_body?.includes('<script'), 'script tag must be stripped');
  assert.ok(msg.html_body?.includes('<b>World</b>'), 'safe tags preserved');
});

test('INBOX-H: HTML sanitization strips onclick and event handler attributes', async () => {
  const r = await nodePost([{
    message_id:   '<inbox-h-event@test.com>',
    from_address: 'attacker@evil.com',
    to_address:   'support@calerion.org',
    mailbox:      'support@calerion.org',
    subject:      'Event handler',
    html_body:    '<div onclick="alert(1)">Click me</div><img onerror="alert(2)" src="ok.png">',
    received_at:  now,
  }]);
  assert.equal(r.body.inserted, 1);

  const msg = db.prepare("SELECT html_body FROM inbound_messages WHERE message_id = '<inbox-h-event@test.com>'").get();
  assert.ok(!msg.html_body?.includes('onclick'), 'onclick stripped');
  assert.ok(!msg.html_body?.includes('onerror'), 'onerror stripped');
});

test('INBOX-I: HTML sanitization: javascript: href replaced', async () => {
  const r = await nodePost([{
    message_id:   '<inbox-i-jshref@test.com>',
    from_address: 'attacker@evil.com',
    to_address:   'support@calerion.org',
    mailbox:      'support@calerion.org',
    subject:      'JS href',
    html_body:    '<a href="javascript:alert(1)">Click</a>',
    received_at:  now,
  }]);
  assert.equal(r.body.inserted, 1);

  const msg = db.prepare("SELECT html_body FROM inbound_messages WHERE message_id = '<inbox-i-jshref@test.com>'").get();
  assert.ok(!msg.html_body?.includes('javascript:'), 'javascript: href stripped');
});

test('INBOX-J: HTML sanitization: safe links get target=_blank rel=noopener', async () => {
  const r = await nodePost([{
    message_id:   '<inbox-j-link@test.com>',
    from_address: 'safe@example.com',
    to_address:   'support@calerion.org',
    mailbox:      'support@calerion.org',
    subject:      'Safe link',
    html_body:    '<a href="https://example.com">Visit us</a>',
    received_at:  now,
  }]);
  assert.equal(r.body.inserted, 1);

  const msg = db.prepare("SELECT html_body FROM inbound_messages WHERE message_id = '<inbox-j-link@test.com>'").get();
  assert.ok(msg.html_body?.includes('target="_blank"'), 'target=_blank added');
  assert.ok(msg.html_body?.includes('noopener'), 'rel=noopener added');
  assert.ok(msg.html_body?.includes('https://example.com'), 'href preserved');
});

test('INBOX-K: null html_body is stored as null (not empty string)', async () => {
  const r = await nodePost([{
    message_id:   '<inbox-k-nohtml@test.com>',
    from_address: 'plain@example.com',
    to_address:   'support@serawin.net',
    mailbox:      'support@serawin.net',
    subject:      'Plain only',
    text_body:    'Just text.',
    html_body:    null,
    received_at:  now,
  }]);
  assert.equal(r.body.inserted, 1);

  const msg = db.prepare("SELECT html_body FROM inbound_messages WHERE message_id = '<inbox-k-nohtml@test.com>'").get();
  assert.equal(msg.html_body, null);
});

// ── User-facing API: authorization ────────────────────────────────────────────

test('INBOX-L: GET /api/inbox without JWT → 401', async () => {
  const r = await req('GET', '/api/inbox');
  assert.equal(r.status, 401);
});

test('INBOX-M: GET /api/inbox/:id without JWT → 401', async () => {
  const r = await req('GET', '/api/inbox/1');
  assert.equal(r.status, 401);
});

test('INBOX-N: PATCH /api/inbox/:id/read without JWT → 401', async () => {
  const r = await req('PATCH', '/api/inbox/1/read');
  assert.equal(r.status, 401);
});

// ── User-facing API: listing and pagination ───────────────────────────────────

test('INBOX-O: GET /api/inbox returns messages with expected fields', async () => {
  const id = await insertOne({ subject: 'List test message', text_body: 'Body here.' });
  const r  = await req('GET', '/api/inbox?limit=50', undefined, AUTH);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.messages));
  assert.ok(typeof r.body.total === 'number');
  assert.ok(typeof r.body.page  === 'number');
  assert.ok(typeof r.body.limit === 'number');

  const found = r.body.messages.find(m => m.id === id);
  assert.ok(found, 'inserted message appears in list');
  assert.ok('subject'      in found);
  assert.ok('from_address' in found);
  assert.ok('to_address'   in found);
  assert.ok('received_at'  in found);
  assert.ok('is_read'      in found);
  assert.ok('snippet'      in found);
  // List view must NOT include the full body columns (privacy/performance)
  assert.ok(!('text_body' in found), 'text_body not in list response');
  assert.ok(!('html_body' in found), 'html_body not in list response');
});

test('INBOX-P: pagination — limit and page respected', async () => {
  // Insert 5 messages with unique IDs
  for (let i = 0; i < 5; i++) {
    await insertOne({
      message_id: `<inbox-p-${i}@test.com>`,
      subject: `Pagination ${i}`,
      received_at: new Date(Date.now() - i * 1000).toISOString(),
    });
  }

  const r1 = await req('GET', '/api/inbox?limit=2&page=1', undefined, AUTH);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.messages.length, 2);
  assert.equal(r1.body.page, 1);

  const r2 = await req('GET', '/api/inbox?limit=2&page=2', undefined, AUTH);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.messages.length, 2);
  assert.equal(r2.body.page, 2);

  // Ensure pages return different messages
  const ids1 = r1.body.messages.map(m => m.id);
  const ids2 = r2.body.messages.map(m => m.id);
  assert.ok(!ids1.some(id => ids2.includes(id)), 'pages must not overlap');
});

test('INBOX-Q: domain filter — only messages for that domain returned', async () => {
  await insertOne({ message_id: '<inbox-q-a@test.com>', to_address: 'support@calerion.org',  mailbox: 'support@calerion.org' });
  await insertOne({ message_id: '<inbox-q-b@test.com>', to_address: 'support@ardovia.co', mailbox: 'support@ardovia.co' });

  const r = await req('GET', '/api/inbox?domain=calerion.org&limit=100', undefined, AUTH);
  assert.equal(r.status, 200);
  const domains = r.body.messages.map(m => m.domain);
  assert.ok(domains.every(d => d === 'calerion.org'), `unexpected domains: ${[...new Set(domains)]}`);
});

test('INBOX-R: read=false filter — only unread messages returned', async () => {
  const id = await insertOne({ message_id: '<inbox-r-unread@test.com>' });
  // Mark it read so we have at least one read message too
  await req('PATCH', `/api/inbox/${id}/read`, undefined, AUTH);

  const r = await req('GET', '/api/inbox?read=false&limit=100', undefined, AUTH);
  assert.equal(r.status, 200);
  assert.ok(r.body.messages.every(m => m.is_read === 0), 'only unread returned');
});

test('INBOX-S: read=true filter — only read messages returned', async () => {
  const id = await insertOne({ message_id: '<inbox-s-read@test.com>' });
  await req('PATCH', `/api/inbox/${id}/read`, undefined, AUTH);

  const r = await req('GET', '/api/inbox?read=true&limit=100', undefined, AUTH);
  assert.equal(r.status, 200);
  assert.ok(r.body.messages.every(m => m.is_read === 1), 'only read returned');
});

test('INBOX-T: search — filters by subject', async () => {
  const needle = `UNIQUE_SUBJ_${Date.now()}`;
  await insertOne({ message_id: `<inbox-t@test.com>`, subject: needle });
  await insertOne({ message_id: `<inbox-t2@test.com>`, subject: 'unrelated' });

  const r = await req('GET', `/api/inbox?search=${encodeURIComponent(needle)}&limit=100`, undefined, AUTH);
  assert.equal(r.status, 200);
  assert.ok(r.body.messages.every(m => m.subject.includes(needle)), 'search by subject works');
  assert.ok(r.body.messages.length >= 1);
});

test('INBOX-U: search — filters by from_address', async () => {
  const unique = `uniquesender_${Date.now()}@example.com`;
  await insertOne({ message_id: `<inbox-u@test.com>`, from_address: unique });

  const r = await req('GET', `/api/inbox?search=${encodeURIComponent(unique)}&limit=100`, undefined, AUTH);
  assert.equal(r.status, 200);
  assert.ok(r.body.messages.some(m => m.from_address === unique));
});

// ── User-facing API: stats ────────────────────────────────────────────────────

test('INBOX-V: GET /api/inbox/stats returns numeric unread count', async () => {
  // Ensure at least one unread
  await insertOne({ message_id: '<inbox-v-stats@test.com>' });

  const r = await req('GET', '/api/inbox/stats', undefined, AUTH);
  assert.equal(r.status, 200);
  assert.ok(typeof r.body.unread === 'number');
  assert.ok(r.body.unread >= 1);
});

// ── User-facing API: GET /:id ─────────────────────────────────────────────────

test('INBOX-W: GET /api/inbox/:id returns full message including bodies', async () => {
  const id = await insertOne({
    message_id: '<inbox-w@test.com>',
    text_body:  'Full text body for detail view.',
    html_body:  '<p>Full HTML body.</p>',
  });

  const r = await req('GET', `/api/inbox/${id}`, undefined, AUTH);
  assert.equal(r.status, 200);
  assert.equal(r.body.id, id);
  assert.ok(r.body.text_body?.includes('Full text body'));
  assert.ok(r.body.html_body?.includes('Full HTML body'));
});

test('INBOX-X: GET /api/inbox/:id for nonexistent id → 404', async () => {
  const r = await req('GET', '/api/inbox/9999999', undefined, AUTH);
  assert.equal(r.status, 404);
});

// ── User-facing API: mark read/unread ────────────────────────────────────────

test('INBOX-Y: PATCH /:id/read marks message as read with timestamp', async () => {
  const id = await insertOne({ message_id: '<inbox-y@test.com>' });

  const before = db.prepare('SELECT is_read, read_at FROM inbound_messages WHERE id=?').get(id);
  assert.equal(before.is_read, 0);
  assert.equal(before.read_at, null);

  const r = await req('PATCH', `/api/inbox/${id}/read`, undefined, AUTH);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);

  const after = db.prepare('SELECT is_read, read_at FROM inbound_messages WHERE id=?').get(id);
  assert.equal(after.is_read, 1);
  assert.ok(after.read_at, 'read_at should be set');
});

test('INBOX-Z: PATCH /:id/unread marks message as unread and clears read_at', async () => {
  const id = await insertOne({ message_id: '<inbox-z@test.com>' });

  await req('PATCH', `/api/inbox/${id}/read`, undefined, AUTH);
  const r = await req('PATCH', `/api/inbox/${id}/unread`, undefined, AUTH);
  assert.equal(r.status, 200);

  const row = db.prepare('SELECT is_read, read_at FROM inbound_messages WHERE id=?').get(id);
  assert.equal(row.is_read, 0);
  assert.equal(row.read_at, null);
});

test('INBOX-Z2: PATCH /read for nonexistent id → 404', async () => {
  const r = await req('PATCH', '/api/inbox/9999999/read', undefined, AUTH);
  assert.equal(r.status, 404);
});

test('INBOX-Z3: PATCH /unread for nonexistent id → 404', async () => {
  const r = await req('PATCH', '/api/inbox/9999999/unread', undefined, AUTH);
  assert.equal(r.status, 404);
});

// ── Domain extraction ─────────────────────────────────────────────────────────

test('INBOX-Z4: domain is extracted from mailbox correctly', async () => {
  await nodePost([{
    message_id:   '<inbox-z4@test.com>',
    from_address: 'x@gmail.com',
    to_address:   'support@ardovia.co',
    mailbox:      'support@ardovia.co',
    subject:      'Domain test',
    received_at:  now,
  }]);

  const row = db.prepare("SELECT domain FROM inbound_messages WHERE message_id = '<inbox-z4@test.com>'").get();
  assert.equal(row.domain, 'ardovia.co');
});

// ── Message without message_id — can be inserted multiple times (no dedup key) ──

test('INBOX-Z5: message without message_id inserts (no DB dedup constraint applies)', async () => {
  const msg = {
    from_address: 'nomsgid@example.com',
    to_address:   'support@calerion.org',
    mailbox:      'support@calerion.org',
    subject:      'No message id',
    text_body:    'Body.',
    received_at:  now,
  };

  const r = await nodePost([msg]);
  assert.equal(r.body.inserted, 1);
  assert.equal(r.body.errors,   0);
});
