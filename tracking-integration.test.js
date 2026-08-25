// Integration tests for the Campaign Engagement feature: button library, campaign
// snapshot immutability, click redirect + open pixel routes, open-redirect
// refusal, event recording, and end-to-end body compilation. Runs against an
// in-memory DB and bare Express apps — no full server boot.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.TRACKING_SECRET   ||= 'test-tracking-secret';
process.env.TRACKING_IP_SALT  ||= 'test-ip-salt';
process.env.DB_PATH           ||= ':memory:';
// Disable rapid-duplicate collapse here so the "multiple clicks recordable" test
// records each rapid click. Dedup behaviour is covered in tracking-hardening.test.js.
process.env.TRACKING_DEDUP_WINDOW_SECONDS ||= '0';

const db = (await import('./db.js')).default;
const ButtonRepository = await import('./services/ButtonRepository.js');
const CampaignButtonRepository = await import('./services/CampaignButtonRepository.js');
const { buildClickUrl, buildOpenPixelUrl } = await import('./services/trackingToken.js');
const { compileForContact } = await import('./services/CampaignBodyCompiler.js');
const Readiness = await import('./services/TrackingHostReadiness.js');
const Engagement = await import('./services/EngagementRepository.js');
const trackRouter = (await import('./routes/track.js')).default;

const app = express();
app.use(express.json());
app.use(trackRouter);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

let seq = 0;
function mkCampaign() {
  const now = new Date().toISOString();
  const r = db.prepare("INSERT INTO campaigns (type, status, date, created_at) VALUES ('manual','running',?,?)").run(now.slice(0,10), now);
  return Number(r.lastInsertRowid);
}
function mkContact() {
  const r = db.prepare("INSERT INTO contacts (firstName,lastName,email,status) VALUES ('J','D',?, 'pending')")
    .run(`c-${Date.now()}-${seq++}@example.com`);
  return Number(r.lastInsertRowid);
}
const tokenOf = (url) => url.split('/c/')[1] ?? url.split('/o/')[1].replace(/\.gif$/, '');

// ── Button library validation ────────────────────────────────────────────────

test('button create validates url + style; rejects bad values', () => {
  const b = ButtonRepository.create({ internal_name: 'Gaming - Play Now', text: 'PLAY NOW', destination_url: 'https://example.com/game-a', style: { background_color: '#2563eb', align: 'center' } });
  assert.equal(b.internal_name, 'Gaming - Play Now');
  assert.equal(b.style.align, 'center');
  assert.throws(() => ButtonRepository.create({ internal_name: 'x', text: 'y', destination_url: 'ftp://nope' }), /http/);
  assert.throws(() => ButtonRepository.create({ internal_name: 'x', text: 'y', destination_url: 'https://ok', style: { background_color: 'red' } }), /hex/);
  assert.throws(() => ButtonRepository.create({ internal_name: '', text: 'y', destination_url: 'https://ok' }), /internal_name/);
});

// ── Campaign snapshot immutability ───────────────────────────────────────────

test('snapshot freezes destination; editing the button does not change it', () => {
  const button = ButtonRepository.create({ internal_name: 'Snap', text: 'GO', destination_url: 'https://example.com/game-a' });
  const campaign = mkCampaign();
  const snap = CampaignButtonRepository.findOrCreate(campaign, button.id);
  assert.equal(snap.destination_url, 'https://example.com/game-a');

  ButtonRepository.update(button.id, { destination_url: 'https://example.com/game-b' });
  const again = CampaignButtonRepository.findOrCreate(campaign, button.id); // idempotent
  assert.equal(again.id, snap.id);
  assert.equal(again.destination_url, 'https://example.com/game-a'); // frozen
});

test('missing / inactive button hard-fails snapshot', () => {
  const campaign = mkCampaign();
  assert.throws(() => CampaignButtonRepository.findOrCreate(campaign, 999999), /no longer exists/);
  const inactive = ButtonRepository.create({ internal_name: 'Off', text: 'X', destination_url: 'https://e.com' });
  ButtonRepository.remove(inactive.id); // soft-delete → inactive
  assert.throws(() => CampaignButtonRepository.findOrCreate(campaign, inactive.id), /inactive/);
});

// ── Click redirect ────────────────────────────────────────────────────────────

test('valid click → 302 to frozen destination + records one event; repeat clicks = multiple events', async () => {
  const button = ButtonRepository.create({ internal_name: 'Clicky', text: 'GO', destination_url: 'https://example.com/dest' });
  const campaign = mkCampaign();
  const contact = mkContact();
  const snap = CampaignButtonRepository.findOrCreate(campaign, button.id);
  const url = buildClickUrl('example.com', { campaignId: campaign, contactId: contact, campaignButtonId: snap.id });
  const token = tokenOf(url);

  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${BASE}/c/${token}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://example.com/dest');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  }
  const count = db.prepare('SELECT COUNT(*) n FROM click_events WHERE campaign_button_id=?').get(snap.id).n;
  assert.equal(count, 3);
});

test('invalid / tampered click token → 404, no event, no redirect', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM click_events').get().n;
  const res = await fetch(`${BASE}/c/not.a.valid.token`, { redirect: 'manual' });
  assert.equal(res.status, 404);
  const after = db.prepare('SELECT COUNT(*) n FROM click_events').get().n;
  assert.equal(after, before);
});

test('destination comes only from the snapshot — no open redirect via query', async () => {
  const button = ButtonRepository.create({ internal_name: 'NoOpen', text: 'GO', destination_url: 'https://trusted.example/ok' });
  const campaign = mkCampaign();
  const snap = CampaignButtonRepository.findOrCreate(campaign, button.id);
  const url = buildClickUrl('example.com', { campaignId: campaign, contactId: mkContact(), campaignButtonId: snap.id });
  const res = await fetch(`${BASE}/c/${tokenOf(url)}?url=https://evil.example`, { redirect: 'manual' });
  assert.equal(res.headers.get('location'), 'https://trusted.example/ok'); // ignores ?url
});

// ── Open pixel ────────────────────────────────────────────────────────────────

test('valid open → 1x1 gif + records event; invalid → gif but no event', async () => {
  const campaign = mkCampaign();
  const contact = mkContact();
  const url = buildOpenPixelUrl('example.com', { campaignId: campaign, contactId: contact });
  const token = tokenOf(url);

  const res = await fetch(`${BASE}/o/${token}.gif`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/gif');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM open_events WHERE campaign_id=?').get(campaign).n, 1);

  const before = db.prepare('SELECT COUNT(*) n FROM open_events').get().n;
  const bad = await fetch(`${BASE}/o/garbage.gif`);
  assert.equal(bad.status, 200); // still a pixel (no broken image)
  assert.equal(bad.headers.get('content-type'), 'image/gif');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM open_events').get().n, before); // no event
});

// ── End-to-end compile ────────────────────────────────────────────────────────

test('compileForContact expands buttons with a resolvable tracking URL (+ text CTA)', async () => {
  // sender identity provides the domain used to build click.<domain> URLs
  const now = new Date().toISOString();
  const srv = db.prepare("INSERT INTO servers (label, apiKey, createdAt) VALUES ('s', ?, ?)").run(`k-${seq++}`, now).lastInsertRowid;
  const idn = db.prepare("INSERT INTO sender_identities (serverId, domain, ip, createdAt) VALUES (?, 'serawin.net', '1.2.3.4', ?)").run(srv, now).lastInsertRowid;
  const button = ButtonRepository.create({ internal_name: 'E2E', text: 'PLAY NOW', destination_url: 'https://example.com/e2e' });
  const campaignId = mkCampaign();
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaignId);
  const contact = { id: mkContact() };

  const out = compileForContact({
    campaign, contact, identityId: Number(idn),
    tmpl: { html: `<p>hi</p>{{button:${button.id}}}`, txt: `hi {{button:${button.id}}}`, content_type: 'html' },
  });
  assert.ok(out.body.includes('<table'));
  assert.ok(out.body.includes('https://click.serawin.net/c/'));
  assert.ok(out.bodyText.includes('PLAY NOW: https://click.serawin.net/c/'));

  // the generated click URL actually resolves to the frozen destination
  const clickUrl = out.body.match(/href="(https:\/\/click\.serawin\.net\/c\/[^"]+)"/)[1];
  const res = await fetch(`${BASE}/c/${clickUrl.split('/c/')[1]}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://example.com/e2e');
});

// ── Open-tracking readiness gate (default ON) ─────────────────────────────────

test('pixel injected only when the tracking host is ready; ON is the default', () => {
  const now = new Date().toISOString();
  const srv = db.prepare("INSERT INTO servers (label, apiKey, createdAt) VALUES ('s', ?, ?)").run(`rk-${seq++}`, now).lastInsertRowid;
  const idn = db.prepare("INSERT INTO sender_identities (serverId, domain, ip, createdAt) VALUES (?, 'ready.example', '9.9.9.9', ?)").run(srv, now).lastInsertRowid;
  const button = ButtonRepository.create({ internal_name: 'Ready', text: 'GO', destination_url: 'https://example.com/r' });
  const campaignId = mkCampaign();                       // override NULL → inherits global default (ON)
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaignId);
  const tmpl = { html: `<p>x</p>{{button:${button.id}}}`, txt: `x {{button:${button.id}}}`, content_type: 'html' };

  // Global default is ON, but host not ready → button still expands, NO pixel.
  Readiness._setReady('ready.example', false);
  const notReady = compileForContact({ campaign, contact: { id: mkContact() }, identityId: Number(idn), tmpl });
  assert.ok(notReady.body.includes('/c/'));      // button tracked
  assert.ok(!notReady.body.includes('/o/'));     // NO broken pixel

  // Host ready → pixel injected.
  Readiness._setReady('ready.example', true);
  const ready = compileForContact({ campaign, contact: { id: mkContact() }, identityId: Number(idn), tmpl });
  assert.ok(ready.body.includes('<img src="https://click.ready.example/o/'));
});

// ── Engagement aggregation ────────────────────────────────────────────────────

test('engagement summary aggregates raw vs human clicks and unique clickers', () => {
  const button = ButtonRepository.create({ internal_name: 'Agg', text: 'GO', destination_url: 'https://example.com/agg' });
  const campaign = mkCampaign();
  const snap = CampaignButtonRepository.findOrCreate(campaign, button.id);
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO click_events (campaign_button_id,campaign_id,contact_id,clicked_at,classification) VALUES (?,?,?,?,?)`);
  ins.run(snap.id, campaign, 1, now, 'human');
  ins.run(snap.id, campaign, 1, now, 'human');   // same clicker
  ins.run(snap.id, campaign, 2, now, 'human');
  ins.run(snap.id, campaign, 3, now, 'scanner');
  ins.run(snap.id, campaign, 4, now, 'unknown');

  const s = Engagement.campaignSummary(campaign);
  assert.equal(s.raw_clicks, 5);
  assert.equal(s.human_clicks, 3);
  assert.equal(s.bot_scanner_clicks, 1);
  assert.equal(s.unknown_clicks, 1);
  assert.equal(s.unique_human_clickers, 2);
});
