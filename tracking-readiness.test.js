// Regression test for the verifyAll() → Array.prototype.map callback bug.
//
// verify(domain, _fetch = fetch) is injectable for tests, so verifyAll() must call
// it as verify(domain) — NEVER hand it straight to Array.prototype.map. map invokes
// its callback as (element, index, array); passing `verify` directly forwards the
// numeric index as `_fetch`. `0` is not callable, so every probe threw
// "_fetch is not a function", the public probe AND the local fallback both failed,
// and the readiness cache was permanently ready:false — silently suppressing every
// open-tracking pixel while all infra (DNS/TLS/nginx/endpoint) was actually healthy.
//
// The production wiring under test is exactly:
//   activeDomains().map(domain => verify(domain))
// This test pins that behaviour so the map-index bug cannot come back.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH            ||= ':memory:';
process.env.TRACKING_SUBDOMAIN ||= 'click';

const db        = (await import('./db.js')).default;
const Readiness = await import('./services/TrackingHostReadiness.js');

// ── Fixtures: two ACTIVE domains (⇒ map indexes 0 and 1) + one inactive ─────────
const now = new Date().toISOString();
const serverId = Number(db.prepare(
  "INSERT INTO servers (label, apiKey, status, createdAt) VALUES ('track-gate', 'TRACK-GATE-KEY', 'online', ?)"
).run(now).lastInsertRowid);

function mkIdentity(domain, status = 'active') {
  db.prepare(
    `INSERT INTO sender_identities (serverId, domain, ip, fromAddr, fromName, dkimSelector, status, dailyLimit, dailySentCount, createdAt)
     VALUES (?, ?, '1.2.3.4', ?, 'S', 'mail', ?, 1000, 0, ?)`
  ).run(serverId, domain, `s@${domain}`, status, now);
}
mkIdentity('serawin.net');
mkIdentity('example.org');
mkIdentity('inactive.example', 'paused'); // must be excluded by activeDomains()

// verifyAll() uses the default `= fetch`, i.e. the GLOBAL fetch — not an injected
// one — so we stub globalThis.fetch (restored afterwards).
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

test('verifyAll() calls verify(domain) — global fetch is used, not the map index', async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), redirect: opts?.redirect });
    return { status: 200 }; // public probe succeeds
  };

  const results = await Readiness.verifyAll();

  // Only the two ACTIVE domains are probed (inactive.example excluded).
  assert.deepEqual(results.map(r => r.domain).sort(), ['example.org', 'serawin.net']);

  for (const r of results) {
    // The exact fingerprint of the regression — must never reappear.
    assert.notEqual(r.error, '_fetch is not a function',
      'verify() must not receive the array index as _fetch');
    assert.equal(r.ready, true);
    assert.equal(r.via, 'public');
    assert.equal(r.error, null);
  }

  // Prove the stub was actually invoked AS fetch, hitting the public
  // click.<domain>/tracking-health URL with redirect:'manual' preserved. With the
  // bug, _fetch was `0`, so it threw before ever calling fetch and `calls` is empty.
  assert.deepEqual(calls.map(c => c.url).sort(), [
    'https://click.example.org/tracking-health',
    'https://click.serawin.net/tracking-health',
  ]);
  assert.ok(calls.every(c => c.redirect === 'manual'), "redirect:'manual' preserved");
});

test('isReady() is true for the active domains after verifyAll()', () => {
  assert.equal(Readiness.isReady('serawin.net'), true);
  assert.equal(Readiness.isReady('example.org'), true);
});
