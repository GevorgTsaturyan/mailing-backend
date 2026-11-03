import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH ||= ':memory:';
const S = await import('./services/OffersBrandService.js');
const Buttons = await import('./services/ButtonRepository.js');

test('brandName: uses fromName unless generic, else capitalised domain label', () => {
  assert.equal(S.brandName({ fromName: 'Serawin', domain: 'serawin.net' }), 'Serawin');
  assert.equal(S.brandName({ fromName: 'Support', domain: 'ardovia.co' }), 'Ardovia');
  assert.equal(S.brandName({ fromName: '', domain: 'merovia.org' }), 'Merovia');
});

test('provisionBrandSite: SKIPPED when not configured (no network)', async () => {
  delete process.env.OFFERS_SITE_PORT;
  const r = await S.provisionBrandSite({ domain: 'x.org' }, { fetchImpl: () => { throw new Error('must not call'); } });
  assert.equal(r.status, 'SKIPPED');
});

test('provisionBrandSite: registers brand and creates ONE accent-coloured button (idempotent)', async () => {
  process.env.OFFERS_SITE_PORT = '3010'; process.env.OFFERS_SITE_INTERNAL_KEY = 'k';
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body), key: opts.headers['X-Internal-Key'] });
    return { ok: true, json: async () => ({ site_name: 'Ardovia', created: calls.length === 1, theme: { accent: '#34d399', accent_text: '#06261a', button_radius: 8 } }) }; };
  const id = { domain: 'ardovia.co', fromName: 'Ardovia', fromAddr: 'support@ardovia.co' };
  const r1 = await S.provisionBrandSite(id, { fetchImpl });
  const r2 = await S.provisionBrandSite(id, { fetchImpl });
  assert.equal(r1.status, 'OK'); assert.equal(r2.buttonId, r1.buttonId);
  assert.equal(calls[0].url, 'http://127.0.0.1:3010/api/internal/brands');
  assert.equal(calls[0].key, 'k');
  const b = Buttons.findById(r1.buttonId);
  assert.equal(b.destination_url, 'https://offers.ardovia.co/');
  assert.equal(b.style.background_color, '#34d399');
});

test('provisionBrandSite: offers-site error → FAILED, never throws', async () => {
  const r = await S.provisionBrandSite({ domain: 'y.org' }, { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }) });
  assert.equal(r.status, 'FAILED');
});

test('pill radius (999) from the site theme is clamped for the email button', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ site_name: 'Pill', created: true, theme: { accent: '#2563eb', button_radius: 999 } }) });
  const r = await S.provisionBrandSite({ domain: 'pill.org', fromName: 'Pill' }, { fetchImpl });
  assert.equal(r.status, 'OK');
  assert.equal(Buttons.findById(r.buttonId).style.border_radius, 40);
});
