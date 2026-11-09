// Pure unit tests: bounce classification, warm-up schedule, provider mapping, content lint.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH ||= ':memory:';
const { classifyBounce } = await import('./services/ListHygieneService.js');
const { warmupLimitFor, effectiveDailyLimit, providerOf, providerHourlyCap } = await import('./services/WarmupService.js');
const { lintTemplate } = await import('./services/ContentLint.js');

test('classifyBounce', () => {
  assert.equal(classifyBounce({ dsnCode: '5.1.1' }), 'hard');
  assert.equal(classifyBounce({ dsnCode: '5.0.0', response: '550 User unknown' }), 'hard');
  assert.equal(classifyBounce({ dsnCode: '5.2.2', reasonCategory: 'mailbox_full' }), 'soft');
  assert.equal(classifyBounce({ dsnCode: '4.4.1' }), 'soft');
  assert.equal(classifyBounce({ dsnCode: '5.7.1', reasonCategory: 'blocklist' }), 'sender');
  assert.equal(classifyBounce({ dsnCode: '5.7.26', reasonCategory: 'auth_failure' }), 'sender');
});

test('warm-up schedule', () => {
  const d = (days) => new Date(Date.UTC(2026, 0, 1) + days * 86_400_000);
  const start = d(0).toISOString();
  assert.equal(warmupLimitFor(null), null);
  assert.equal(warmupLimitFor(start, d(0)), 50);
  assert.equal(warmupLimitFor(start, d(7)), 100);
  assert.equal(warmupLimitFor(start, d(21)), 500);
  assert.equal(warmupLimitFor(start, d(42)), 4000);
  assert.equal(effectiveDailyLimit({ dailyLimit: 300, warmupStartedAt: start }, d(14)), 200);
  assert.equal(effectiveDailyLimit({ dailyLimit: 300, warmupStartedAt: start }, d(70)), 300);
  assert.equal(effectiveDailyLimit({ dailyLimit: 300, warmupStartedAt: null }), 300);
});

test('provider mapping + hourly cap', () => {
  assert.equal(providerOf('a@Gmail.com'), 'google');
  assert.equal(providerOf('a@hotmail.com'), 'microsoft');
  assert.equal(providerOf('a@example.org'), null);
  assert.equal(providerHourlyCap({ dailyLimit: 50, warmupStartedAt: null }), 7); // ceil(50/8)
  assert.equal(providerHourlyCap({ dailyLimit: 10, warmupStartedAt: null }), 3); // floor of 3
});

test('content lint', () => {
  assert.deepEqual(lintTemplate({ subject: 'Hello', html: '<p><a href="https://x.com">x</a></p>', txt: 'x' }), []);
  const w = lintTemplate({
    subject: 'Your account is ready to activate',
    html: '<a href="https://bit.ly/x">1</a>' + '<a href="https://a.com">a</a>'.repeat(5) + '<img src="a">'.repeat(4),
  });
  assert.equal(w.length, 5);
});

test('provider throttle counts jobs started in the last hour per provider', async () => {
  const db = (await import('./db.js')).default;
  const { providerAllows } = await import('./services/WarmupService.js');
  const ts = new Date().toISOString();
  const sid = db.prepare("INSERT INTO servers (label, apiKey, status, createdAt) VALUES ('t','KEY-THROTTLE','online',?)").run(ts).lastInsertRowid;
  const iid = Number(db.prepare(`INSERT INTO sender_identities (serverId, domain, ip, fromAddr, status, verificationStatus, dailyLimit, createdAt)
    VALUES (?, 't.net', '1.1.1.1', 'a@t.net', 'active', 'READY', 40, ?)`).run(sid, ts).lastInsertRowid);
  const identity = { id: iid, dailyLimit: 40, warmupStartedAt: null }; // cap = 5/h
  const recent = new Date(Date.now() - 50 * 60_000).toISOString(); // within the hour, but older than the pacing gap
  for (let i = 0; i < 5; i++) {
    db.prepare(`INSERT INTO jobs (status, identity_id, recipient, subject, body, created_at, started_at)
                VALUES ('SENT', ?, ?, 's', 'b', ?, ?)`).run(iid, `u${i}@gmail.com`, recent, recent);
  }
  assert.equal(providerAllows({ identity_id: iid, recipient: 'x@googlemail.com' }, identity), false);
  assert.equal(providerAllows({ identity_id: iid, recipient: 'x@outlook.com' }, identity), true);
  assert.equal(providerAllows({ identity_id: iid, recipient: 'x@example.org' }, identity), true);
});

test('inactivity sunset excludes long-inactive contacts from selection', async () => {
  const db = (await import('./db.js')).default;
  const { suppressionExclusionSql } = await import('./services/SuppressionService.js');
  const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
  const a = db.prepare("INSERT INTO contacts (firstName,lastName,email,last_activity_at) VALUES ('a','a','sunset-old@x.com',?)").run(old).lastInsertRowid;
  const b = db.prepare("INSERT INTO contacts (firstName,lastName,email,last_activity_at) VALUES ('b','b','sunset-new@x.com',?)").run(new Date().toISOString()).lastInsertRowid;
  const ids = db.prepare(`SELECT id FROM contacts c WHERE ${suppressionExclusionSql('c')} AND id IN (?,?)`).all(a, b).map((r) => r.id);
  assert.deepEqual(ids, [Number(b)]);
});

test('provider throttle paces evenly: no second start within 3600/cap seconds', async () => {
  const db = (await import('./db.js')).default;
  const { providerAllows } = await import('./services/WarmupService.js');
  const ts = new Date().toISOString();
  const sid = db.prepare("INSERT INTO servers (label, apiKey, status, createdAt) VALUES ('p','KEY-PACE','online',?)").run(ts).lastInsertRowid;
  const iid = Number(db.prepare(`INSERT INTO sender_identities (serverId, domain, ip, fromAddr, status, verificationStatus, dailyLimit, createdAt)
    VALUES (?, 'p.net', '1.1.1.2', 'a@p.net', 'active', 'READY', 100, ?)`).run(sid, ts).lastInsertRowid);
  const identity = { id: iid, dailyLimit: 100, warmupStartedAt: null };   // cap 13/h → gap ~276 s
  const start = (agoMs) => db.prepare(`INSERT INTO jobs (status, identity_id, recipient, subject, body, created_at, started_at)
    VALUES ('SENT', ?, 'x@gmail.com', 's', 'b', ?, ?)`).run(iid, ts, new Date(Date.now() - agoMs).toISOString());
  start(60_000);   // 1 min ago
  assert.equal(providerAllows({ identity_id: iid, recipient: 'y@gmail.com' }, identity), false, 'too soon after previous Gmail start');
  assert.equal(providerAllows({ identity_id: iid, recipient: 'y@outlook.com' }, identity), true, 'other provider unaffected');
  db.prepare('UPDATE jobs SET started_at=? WHERE identity_id=?').run(new Date(Date.now() - 300_000).toISOString(), iid); // 5 min ago
  assert.equal(providerAllows({ identity_id: iid, recipient: 'y@gmail.com' }, identity), true, 'gap elapsed');
});
