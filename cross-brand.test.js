import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH ||= ':memory:';
const db = (await import('./db.js')).default;
const { check } = await import('./services/CrossBrandService.js');

const now = new Date().toISOString();
const sid = db.prepare("INSERT INTO servers (label, apiKey, status, createdAt) VALUES ('n','KEY-XB','online',?)").run(now).lastInsertRowid;
const mkId = (d) => Number(db.prepare(`INSERT INTO sender_identities (serverId, domain, ip, fromAddr, status, verificationStatus, createdAt)
  VALUES (?, ?, '1.1.1.1', ?, 'active', 'READY', ?)`).run(sid, d, `support@${d}`, now).lastInsertRowid);
const A = mkId('alpha.test'), B = mkId('beta.test'), C = mkId('gamma.test');
const mkC = (e) => Number(db.prepare("INSERT INTO contacts (firstName,lastName,email) VALUES ('a','b',?)").run(e).lastInsertRowid);
const fresh = mkC('fresh@x.com'), onlyA = mkC('onlya@x.com'), aAndB = mkC('ab@x.com'), pendingB = mkC('pendingb@x.com');
const job = (cid, iid, status) => db.prepare(`INSERT INTO jobs (status, identity_id, recipient, subject, body, contact_id, created_at)
  VALUES (?, ?, 'r', 's', 'b', ?, ?)`).run(status, iid, cid, now);
job(onlyA, A, 'SENT'); job(aAndB, A, 'SENT'); job(aAndB, B, 'SENT'); job(pendingB, B, 'PENDING');

test('sending from A: only contacts emailed by OTHER brands are flagged', () => {
  const r = check({ identityId: A, contactIds: [fresh, onlyA, aAndB, pendingB] });
  assert.equal(r.identity.domain, 'alpha.test');
  assert.equal(r.total, 4);
  assert.deepEqual(r.conflicts.map(c => [c.email, c.brands]), [['ab@x.com', ['beta.test']]]);
});

test('sending from C: everyone emailed by A or B is flagged with all brands', () => {
  const r = check({ identityId: C, contactIds: [fresh, onlyA, aAndB] });
  assert.deepEqual(r.conflicts.map(c => [c.email, c.brands]), [['ab@x.com', ['alpha.test', 'beta.test']], ['onlya@x.com', ['alpha.test']]]);
});

test('legacy send_log rows count; unsent/pending jobs do not', () => {
  db.prepare("INSERT INTO send_log (date, contactId, email, status, senderIdentityId) VALUES (?, ?, 'fresh@x.com', 'delivered', ?)").run(now, fresh, B);
  const r = check({ identityId: C, contactIds: [fresh, pendingB] });
  assert.deepEqual(r.conflicts.map(c => c.email), ['fresh@x.com']);
});

test('no identity given → resolves to the first active READY identity (same as send)', () => {
  assert.equal(check({ contactIds: [onlyA] }).identity.id, A);
});
