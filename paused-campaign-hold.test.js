// Pausing a recurring campaign must also hold the jobs it already queued today:
// they stay PENDING, are never polled or claimed, and flow again after resume.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

const db = (await import('./db.js')).default;
const JobRepository = await import('./services/JobRepository.js');

const now = new Date().toISOString();
const past = new Date(Date.now() - 60_000).toISOString();

const serverId = Number(db.prepare(
  "INSERT INTO servers (label, apiKey, status, createdAt) VALUES ('n','KEY-PAUSE-HOLD','online',?)").run(now).lastInsertRowid);
const identityId = Number(db.prepare(`
  INSERT INTO sender_identities (serverId, domain, ip, fromAddr, fromName, status, verificationStatus, dailyLimit, dailySentCount, createdAt)
  VALUES (?, 'hold.example', '1.2.3.4', 's@hold.example', 'S', 'active', 'READY', 1000, 0, ?)`).run(serverId, now).lastInsertRowid);

function campaignWithJob(rcStatus) {
  const rc = Number(db.prepare(`
    INSERT INTO recurring_campaigns (name, subject, html, txt, content_type, startTime, endTime, initialCount, increasePercent, status, currentDay, createdAt)
    VALUES (?, 'S', '<p>x</p>', 'x', 'html', '00:00', '23:59', 1, 0, ?, 1, ?)`).run(`rc-${rcStatus}-${Math.random()}`, rcStatus, now).lastInsertRowid);
  const camp = Number(db.prepare(
    "INSERT INTO campaigns (type, recurring_campaign_id, identity_id, label, status, date, created_at) VALUES ('recurring', ?, ?, 'L', 'running', ?, ?)"
  ).run(rc, identityId, now.slice(0, 10), now).lastInsertRowid);
  const job = Number(db.prepare(
    "INSERT INTO jobs (status, identity_id, recipient, subject, body, priority, attempts, created_at, scheduled_for, campaign_id, content_type) VALUES ('PENDING', ?, 'r@example.com', 'S', 'b', 0, 0, ?, ?, ?, 'html')"
  ).run(identityId, now, past, camp).lastInsertRowid);
  return { rc, job };
}

test('job of a paused campaign is neither polled nor claimable', () => {
  db.prepare("UPDATE jobs SET status='CANCELLED' WHERE status='PENDING'").run();
  const { job } = campaignWithJob('paused');
  assert.equal(JobRepository.findNextPending(serverId), null);
  assert.equal(JobRepository.claimJob(job, String(serverId), serverId), false);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(job).status, 'PENDING', 'held, not cancelled');
});

test('resuming the campaign releases its queued job', () => {
  db.prepare("UPDATE jobs SET status='CANCELLED' WHERE status='PENDING'").run();
  const { rc, job } = campaignWithJob('paused');
  db.prepare("UPDATE recurring_campaigns SET status='active' WHERE id=?").run(rc);
  assert.equal(JobRepository.findNextPending(serverId)?.id, job);
  assert.equal(JobRepository.claimJob(job, String(serverId), serverId), true);
});

test('active campaigns and raw jobs are unaffected', () => {
  db.prepare("UPDATE jobs SET status='CANCELLED' WHERE status='PENDING'").run();
  const { job } = campaignWithJob('active');
  assert.equal(JobRepository.findNextPending(serverId)?.id, job);
  db.prepare("UPDATE jobs SET status='CANCELLED' WHERE id=?").run(job);
  const raw = Number(db.prepare(
    "INSERT INTO jobs (status, identity_id, recipient, subject, body, priority, attempts, created_at, content_type) VALUES ('PENDING', ?, 'x@example.com', 'S', 'b', 0, 0, ?, 'html')"
  ).run(identityId, now).lastInsertRowid);
  assert.equal(JobRepository.findNextPending(serverId)?.id, raw);
});
