// Unit tests for PublicSubscribeService (offers-site double opt-in).
// Real in-memory DB; job creation is injected so no identity/queue is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH                    = ':memory:';
process.env.OFFERS_SITE_URL            = 'https://offers.example/';
process.env.OFFERS_SITE_NAME           = 'Example Offers';
process.env.OFFERS_CONFIRM_IDENTITY_ID = '7';

const db = (await import('./db.js')).default;
const { requestSubscription, confirmSubscription } = await import('./services/PublicSubscribeService.js');

let jobs = [];
const createJob = (j) => { jobs.push(j); return { id: jobs.length }; };
const pending   = (email) => db.prepare('SELECT * FROM pending_subscriptions WHERE email=?').get(email);
const contact   = (email) => db.prepare('SELECT * FROM contacts WHERE email=?').get(email);
const inGroup   = (email) => db.prepare(`
  SELECT 1 FROM contact_group_members m JOIN contact_groups g ON g.id=m.group_id
  JOIN contacts c ON c.id=m.contact_id WHERE g.name='Website subscribers' AND c.email=?`).get(email);

test('subscribe: queues one confirmation email and adds NO contact yet', () => {
  jobs = [];
  const r = requestSubscription({ email: ' New@Example.com ', firstName: 'Ann' }, { createJob });
  assert.equal(r.status, 'sent');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].identity_id, 7);
  assert.equal(jobs[0].recipient, 'new@example.com');
  const row = pending('new@example.com');
  assert.ok(jobs[0].body.includes(`https://offers.example/confirm?token=${row.token}`));
  assert.equal(contact('new@example.com'), undefined, 'contact only after confirmation');
});

test('subscribe: rejects invalid email', () => {
  assert.throws(() => requestSubscription({ email: 'nope' }, { createJob }), e => e.code === 'invalid_email');
});

test('subscribe: cooldown — no second email within 10 minutes', () => {
  jobs = [];
  requestSubscription({ email: 'cool@example.com' }, { createJob });
  const r = requestSubscription({ email: 'cool@example.com' }, { createJob });
  assert.equal(r.status, 'cooldown');
  assert.equal(jobs.length, 1);
});

test('subscribe: unsubscribed address gets no email (suppression respected)', () => {
  jobs = [];
  db.prepare("INSERT INTO contacts (firstName,lastName,email,status) VALUES ('U','','gone@example.com','unsubscribed')").run();
  const r = requestSubscription({ email: 'gone@example.com' }, { createJob });
  assert.equal(r.status, 'suppressed');
  assert.equal(jobs.length, 0);
});

test('confirm: creates contact (pending) and adds it to Website subscribers', () => {
  requestSubscription({ email: 'conf@example.com', firstName: 'Bo' }, { createJob });
  const r = confirmSubscription(pending('conf@example.com').token);
  assert.equal(r.status, 'confirmed');
  const c = contact('conf@example.com');
  assert.equal(c.status, 'pending');
  assert.equal(c.firstName, 'Bo');
  assert.ok(inGroup('conf@example.com'));
  assert.equal(pending('conf@example.com'), undefined);
  // Re-subscribing a confirmed member does not send another email.
  jobs = [];
  assert.equal(requestSubscription({ email: 'conf@example.com' }, { createJob }).status, 'already_subscribed');
  assert.equal(jobs.length, 0);
});

test('confirm: existing contact keeps its row and is added to the group', () => {
  db.prepare("INSERT INTO contacts (firstName,lastName,email,status) VALUES ('Old','','old@example.com','sent')").run();
  requestSubscription({ email: 'old@example.com' }, { createJob });
  confirmSubscription(pending('old@example.com').token);
  assert.equal(contact('old@example.com').status, 'sent');
  assert.ok(inGroup('old@example.com'));
});

test('confirm: invalid and expired tokens', () => {
  assert.equal(confirmSubscription('bogus').status, 'invalid');
  requestSubscription({ email: 'exp@example.com' }, { createJob });
  const token = pending('exp@example.com').token;
  const r = confirmSubscription(token, { now: () => new Date(Date.now() + 49 * 3600_000) });
  assert.equal(r.status, 'expired');
  assert.equal(contact('exp@example.com'), undefined);
});

test('confirm: unsubscribed between request and confirm → never re-added', () => {
  requestSubscription({ email: 'late@example.com' }, { createJob });
  const token = pending('late@example.com').token;
  db.prepare("INSERT INTO contacts (firstName,lastName,email,status) VALUES ('L','','late@example.com','unsubscribed')").run();
  assert.equal(confirmSubscription(token).status, 'suppressed');
  assert.equal(contact('late@example.com').status, 'unsubscribed');
  assert.ok(!inGroup('late@example.com'));
});
