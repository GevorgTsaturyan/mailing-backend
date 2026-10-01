// Tests for ControllerHostHealth — the STRICT public-HTTPS probe used to detect
// whether an identity's controller-side tracking/unsubscribe hosts are actually
// serving correctly (the Calerion "wrong TLS cert" case). fetch is injected; no
// network. Critically, there is NO local/hairpin fallback here, so a TLS/cert
// error must surface as unhealthy (not be masked).

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TRACKING_SUBDOMAIN ||= 'click';

const { checkControllerHostsHealthy } = await import('./services/ControllerHostHealth.js');

function fakeFetch(map) {
  // map: { urlSubstring: () => ({status}) | throws }
  return async (url) => {
    for (const [needle, handler] of Object.entries(map)) {
      if (url.includes(needle)) return handler(url);
    }
    throw new Error(`unexpected url ${url}`);
  };
}

test('both hosts answer 200 over valid HTTPS → ok', async () => {
  const seen = [];
  const _fetch = async (url) => { seen.push(url); return { status: 200 }; };
  const r = await checkControllerHostsHealthy({ domain: 'example.test', deps: { fetch: _fetch } });
  assert.equal(r.ok, true);
  assert.equal(r.hosts.click.ok, true);
  assert.equal(r.hosts.unsubscribe.ok, true);
  // Reuses the existing health endpoints on the per-domain hosts.
  assert.ok(seen.some(u => u === 'https://click.example.test/tracking-health'));
  assert.ok(seen.some(u => u === 'https://unsubscribe.example.test/unsubscribe-health'));
});

test('click host serving WRONG cert (fetch throws) → NOT ok, not masked by fallback', async () => {
  const _fetch = fakeFetch({
    'click.example.test': () => { const e = new Error('no alternative certificate subject name'); e.code = 'ERR_TLS_CERT_ALTNAME_INVALID'; throw e; },
    'unsubscribe.example.test': () => ({ status: 200 }),
  });
  const r = await checkControllerHostsHealthy({ domain: 'example.test', deps: { fetch: _fetch } });
  assert.equal(r.ok, false, 'a TLS cert mismatch on click must make the host unhealthy');
  assert.equal(r.hosts.click.ok, false);
  assert.equal(r.hosts.unsubscribe.ok, true);
});

test('unsubscribe host missing/non-200 → NOT ok', async () => {
  const _fetch = fakeFetch({
    'click.example.test': () => ({ status: 200 }),
    'unsubscribe.example.test': () => ({ status: 404 }),
  });
  const r = await checkControllerHostsHealthy({ domain: 'example.test', deps: { fetch: _fetch } });
  assert.equal(r.ok, false);
  assert.equal(r.hosts.unsubscribe.ok, false);
});

test('DNS failure (fetch throws ENOTFOUND) → NOT ok', async () => {
  const _fetch = async () => { const e = new Error('getaddrinfo ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; };
  const r = await checkControllerHostsHealthy({ domain: 'nope.test', deps: { fetch: _fetch } });
  assert.equal(r.ok, false);
  assert.equal(r.hosts.click.ok, false);
  assert.equal(r.hosts.unsubscribe.ok, false);
});
