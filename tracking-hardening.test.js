// Hardening tests for the audit fixes: trusted client IP (W1), dedup/rate-limit
// (W5), burst + HEAD scanner classification (W3), secondsSinceSend, readiness
// hairpin fallback (#8), event retention (#5), and legacy-pipeline hard-fail.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.TRACKING_SECRET   ||= 'test-tracking-secret';
process.env.TRACKING_IP_SALT  ||= 'test-ip-salt';
process.env.DB_PATH           ||= ':memory:';
process.env.TRACKING_BURST_WINDOW_SECONDS ||= '5';
// Dedup off by default here (the W1 tests fire rapid same-client requests that
// must all record); the dedicated W5 test enables it explicitly.
process.env.TRACKING_DEDUP_WINDOW_SECONDS = '0';

const db = (await import('./db.js')).default;
const ButtonRepository = await import('./services/ButtonRepository.js');
const CampaignButtonRepository = await import('./services/CampaignButtonRepository.js');
const { buildClickUrl, hashIp } = await import('./services/trackingToken.js');
const trackRouter = (await import('./routes/track.js')).default;
const Readiness = await import('./services/TrackingHostReadiness.js');
const { purgeOldEvents } = await import('./services/EventRetention.js');
const { assertTemplateButtonsValid } = await import('./services/CampaignBodyCompiler.js');
const sendRouter = (await import('./routes/send.js')).default;

// Two Express SUB-apps on ONE server (Node 18's test runner deadlocks on two
// top-level listen+awaits): /u = no trust proxy (raw XFF must be ignored),
// /t = 'loopback' trust (controller behind local nginx → appended XFF honoured).
// req.ip resolves 'trust proxy' from the mounted sub-app, so this mirrors the
// two production configurations faithfully.
function mkSubApp(trustProxy) {
  const app = express();
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  app.use(trackRouter);
  return app;
}
const parent = express();
parent.use('/u', mkSubApp(undefined));
parent.use('/t', mkSubApp('loopback'));
const server = parent.listen(0);
await new Promise(r => server.once('listening', r));
const U = `http://127.0.0.1:${server.address().port}/u`;
const T = `http://127.0.0.1:${server.address().port}/t`;
after(() => server.close());

let seq = 0;
function mkCampaign() {
  const now = new Date().toISOString();
  return Number(db.prepare("INSERT INTO campaigns (type,status,date,created_at) VALUES ('manual','running',?,?)").run(now.slice(0,10), now).lastInsertRowid);
}
function mkContact() {
  return Number(db.prepare("INSERT INTO contacts (firstName,lastName,email,status) VALUES ('J','D',?, 'pending')").run(`h-${Date.now()}-${seq++}@e.com`).lastInsertRowid);
}
function mkSnapshot(campaignId, dest = 'https://example.com/x') {
  const b = ButtonRepository.create({ internal_name: `B${seq++}`, text: 'GO', destination_url: dest });
  return CampaignButtonRepository.findOrCreate(campaignId, b.id);
}
const tok = (url) => url.split('/c/')[1];

// ── W1: X-Forwarded-For must not be blindly trusted ───────────────────────────

test('W1: without a trusted proxy, a client X-Forwarded-For is ignored (no spoof)', async () => {
  const cid = mkCampaign(); const snap = mkSnapshot(cid);
  const url = buildClickUrl('example.com', { campaignId: cid, contactId: mkContact(), campaignButtonId: snap.id });
  await fetch(`${U}/c/${tok(url)}`, { redirect: 'manual', headers: { 'X-Forwarded-For': '9.9.9.9' } });
  await fetch(`${U}/c/${tok(url)}`, { redirect: 'manual' });
  const hashes = db.prepare('SELECT ip_hash FROM click_events WHERE campaign_button_id=? ORDER BY id').all(snap.id).map(r => r.ip_hash);
  assert.equal(hashes.length, 2);
  assert.equal(hashes[0], hashes[1]); // spoofed XFF had no effect → same (socket) hash
  assert.notEqual(hashes[0], hashIp('9.9.9.9'));
});

test('W1: with trust proxy = loopback, the appended XFF hop is used (nginx case)', async () => {
  const cid = mkCampaign(); const snap = mkSnapshot(cid);
  const url = buildClickUrl('example.com', { campaignId: cid, contactId: mkContact(), campaignButtonId: snap.id });
  await fetch(`${T}/c/${tok(url)}`, { redirect: 'manual', headers: { 'X-Forwarded-For': '9.9.9.9' } });
  const row = db.prepare('SELECT ip_hash FROM click_events WHERE campaign_button_id=? ORDER BY id DESC LIMIT 1').get(snap.id);
  assert.equal(row.ip_hash, hashIp('9.9.9.9'));
});

// ── W5: dedup collapses rapid duplicates but not distinct clients ─────────────

test('W5: rapid duplicate clicks from same client collapse; distinct clients do not', async () => {
  process.env.TRACKING_DEDUP_WINDOW_SECONDS = '60';
  const cid = mkCampaign(); const snap = mkSnapshot(cid);
  const url = buildClickUrl('example.com', { campaignId: cid, contactId: mkContact(), campaignButtonId: snap.id });
  const path = `${T}/c/${tok(url)}`;
  await fetch(path, { redirect: 'manual', headers: { 'X-Forwarded-For': '1.1.1.1' } });
  await fetch(path, { redirect: 'manual', headers: { 'X-Forwarded-For': '1.1.1.1' } }); // rapid dup → collapsed
  await fetch(path, { redirect: 'manual', headers: { 'X-Forwarded-For': '2.2.2.2' } }); // distinct client → recorded
  const n = db.prepare('SELECT COUNT(*) n FROM click_events WHERE campaign_button_id=?').get(snap.id).n;
  assert.equal(n, 2);
  process.env.TRACKING_DEDUP_WINDOW_SECONDS = '0';
});

// ── W3: burst + HEAD scanner classification ───────────────────────────────────

test('W3: fetching a second button of the same email quickly → scanner (burst)', async () => {
  const cid = mkCampaign(); const contact = mkContact();
  const a = mkSnapshot(cid); const b = mkSnapshot(cid);
  const urlA = buildClickUrl('example.com', { campaignId: cid, contactId: contact, campaignButtonId: a.id });
  const urlB = buildClickUrl('example.com', { campaignId: cid, contactId: contact, campaignButtonId: b.id });
  await fetch(`${T}/c/${tok(urlA)}`, { redirect: 'manual', headers: { 'X-Forwarded-For': '3.3.3.3' } });
  await fetch(`${T}/c/${tok(urlB)}`, { redirect: 'manual', headers: { 'X-Forwarded-For': '3.3.3.3' } });
  const clsB = db.prepare('SELECT classification FROM click_events WHERE campaign_button_id=?').get(b.id).classification;
  assert.equal(clsB, 'scanner');
});

test('W3: HEAD request → scanner', async () => {
  const cid = mkCampaign(); const snap = mkSnapshot(cid);
  const url = buildClickUrl('example.com', { campaignId: cid, contactId: mkContact(), campaignButtonId: snap.id });
  await fetch(`${T}/c/${tok(url)}`, { method: 'HEAD', redirect: 'manual', headers: { 'X-Forwarded-For': '4.4.4.4' } });
  const cls = db.prepare('SELECT classification, classified_reason FROM click_events WHERE campaign_button_id=?').get(snap.id);
  assert.equal(cls.classification, 'scanner');
  assert.equal(cls.classified_reason, 'head-request');
});

test('secondsSinceSend: a click right after send is classified fast (scanner)', async () => {
  const cid = mkCampaign(); const contact = mkContact(); const snap = mkSnapshot(cid);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO jobs (status, recipient, subject, campaign_id, contact_id, finished_at, created_at) VALUES ('SENT','x@e.com','s',?,?,?,?)")
    .run(cid, contact, now, now);
  const url = buildClickUrl('example.com', { campaignId: cid, contactId: contact, campaignButtonId: snap.id });
  await fetch(`${T}/c/${tok(url)}`, { redirect: 'manual', headers: { 'X-Forwarded-For': '5.5.5.5' } });
  const row = db.prepare('SELECT classification, seconds_since_send FROM click_events WHERE campaign_button_id=?').get(snap.id);
  assert.equal(row.classification, 'scanner');
  assert.ok(row.seconds_since_send != null && row.seconds_since_send < 10);
});

// ── #8: readiness hairpin fallback ────────────────────────────────────────────

test('#8: readiness falls back to a local probe when the public probe fails (hairpin)', async () => {
  // public throws (simulates NAT hairpin); local returns 200.
  const stub = async (url) => {
    if (url.startsWith('https://')) throw new Error('hairpin: cannot reach public IP');
    return { status: 200 };
  };
  const r = await Readiness.verify('example.com', stub);
  assert.equal(r.ready, true);
  assert.equal(r.via, 'local-fallback');

  const bothFail = await Readiness.verify('example.com', async (u) => {
    if (u.startsWith('https://')) throw new Error('down');
    throw new Error('local down');
  });
  assert.equal(bothFail.ready, false);
});

// ── #5: event retention ───────────────────────────────────────────────────────

test('#5: purgeOldEvents deletes rows past the window, keeps recent ones', () => {
  const cid = mkCampaign(); const snap = mkSnapshot(cid);
  const old = new Date(Date.now() - 100 * 864e5).toISOString();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO click_events (campaign_button_id,campaign_id,clicked_at,classification) VALUES (?,?,?,'human')").run(snap.id, cid, old);
  db.prepare("INSERT INTO click_events (campaign_button_id,campaign_id,clicked_at,classification) VALUES (?,?,?,'human')").run(snap.id, cid, now);
  db.prepare("INSERT INTO open_events (campaign_id,opened_at,classification) VALUES (?,?,'open')").run(cid, old);
  const r = purgeOldEvents(90);
  assert.ok(r.clicksDeleted >= 1);
  assert.ok(r.opensDeleted >= 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM click_events WHERE campaign_button_id=? AND clicked_at=?').get(snap.id, now).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM click_events WHERE campaign_button_id=? AND clicked_at=?').get(snap.id, old).n, 0);
});

// ── Scheduler button validation + legacy-pipeline hard-fail ────────────────────

test('assertTemplateButtonsValid throws on a missing button', () => {
  assert.throws(() => assertTemplateButtonsValid({ html: '{{button:999999}}' }), /no longer exists/);
});

test('legacy pipeline hard-fails a tracked-button template (no silent untracked link)', async () => {
  const app = express();
  app.use(express.json());
  app.use('/send', sendRouter);
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const prev = process.env.USE_CANONICAL_QUEUE;
  delete process.env.USE_CANONICAL_QUEUE; // legacy pipeline
  const res = await fetch(`${base}/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contactIds: [1], subject: 'Hi', html: '<p>{{button:1}}</p>' }),
  });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.match(body.error, /canonical queue/i);
  if (prev !== undefined) process.env.USE_CANONICAL_QUEUE = prev;
  srv.close();
});
