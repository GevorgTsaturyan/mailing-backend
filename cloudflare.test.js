// Unit tests for CloudflareService.js
// All Cloudflare API calls are intercepted via a mocked globalThis.fetch.
// No real network traffic; no real DNS changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CF_API_TOKEN = 'test-token-cloudflare';

// ─── Fetch mock ───────────────────────────────────────────────────────────────
// Each test calls setup(...responses) to queue exactly the responses it expects.
// Any unexpected fetch call throws so tests fail loudly on ordering mistakes.

const queue = [];
let calls  = [];

globalThis.fetch = async (url, init) => {
  calls.push({ url, method: (init?.method || 'GET').toUpperCase(), body: init?.body });
  const resp = queue.shift();
  if (!resp) throw new Error(`Unexpected fetch: ${url}`);
  return { json: async () => resp };
};

function setup(...responses) {
  queue.length = 0;
  calls = [];
  queue.push(...responses);
}

// CF response wrappers
function ok(result)    { return { success: true,  result }; }
function err(message)  { return { success: false, result: null, errors: [{ message }] }; }

const ZONE    = 'zone-id-test-123';
const DOMAIN  = 'example-cf-test.com';
const IP      = '10.0.0.1';
const SEL     = 'mail';
const PUBKEY  = 'MIGfMA0GCSqGSIb3DQEBA';
const CTLR_IP = '10.0.0.2';

// Convenience: zone-found response
const foundZone = ok([{ id: ZONE }]);
// Convenience: empty DNS record list
const noRecords = ok([]);

const { provisionDns, findZoneId, isConfigured } = await import('./services/CloudflareService.js');

// ─── isConfigured ─────────────────────────────────────────────────────────────

test('isConfigured: false when CF_API_TOKEN is empty', () => {
  const saved = process.env.CF_API_TOKEN;
  process.env.CF_API_TOKEN = '';
  assert.equal(isConfigured(), false);
  process.env.CF_API_TOKEN = saved;
});

test('isConfigured: true when CF_API_TOKEN is set', () => {
  assert.equal(isConfigured(), true);
});

// ─── findZoneId ───────────────────────────────────────────────────────────────

test('findZoneId: finds zone for exact domain', async () => {
  setup(ok([{ id: ZONE }]));
  const id = await findZoneId(DOMAIN);
  assert.equal(id, ZONE);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes(encodeURIComponent(DOMAIN)));
});

test('findZoneId: falls back to parent domain for subdomain', async () => {
  // click.example.com: first try click.example.com (empty), then example.com (found)
  setup(ok([]), ok([{ id: ZONE }]));
  const id = await findZoneId(`click.${DOMAIN}`);
  assert.equal(id, ZONE);
  assert.equal(calls.length, 2);
});

test('findZoneId: throws when no zone found for any ancestor', async () => {
  setup(ok([]), ok([]));
  await assert.rejects(
    () => findZoneId(DOMAIN),
    /No Cloudflare zone found/
  );
});

// ─── A record ─────────────────────────────────────────────────────────────────
// provisionDns call order per run (no controllerIp):
//   1. findZone
//   2. GET A mail.<domain>
//   3. GET MX <domain>
//   4. GET TXT <domain> (SPF)
//   5. GET TXT <sel>._domainkey.<domain> (DKIM)
//   6. GET TXT _dmarc.<domain> (DMARC)
// Additional calls for creates/patches.

// Helper: queue "all other records already OK" after mail-A responses
function queueRestOk() {
  // MX: already correct (mail.<domain> priority 10)
  queue.push(ok([{ id: 'mx-1', content: `mail.${DOMAIN}`, priority: 10 }]));
  // SPF: already has ip
  queue.push(ok([{ id: 'spf-1', content: `v=spf1 ip4:${IP} ~all` }]));
  // DKIM: already correct
  queue.push(ok([{ id: 'dkim-1', content: `v=DKIM1; k=rsa; p=${PUBKEY}` }]));
  // DMARC: exists
  queue.push(ok([{ id: 'dmarc-1', content: 'v=DMARC1; p=none' }]));
}

// Helper: queue a single already-correct MX response (after A mail, before SPF)
function queueMXOk() {
  queue.push(ok([{ id: 'mx-1', content: `mail.${DOMAIN}`, priority: 10 }]));
}

test('A record: creates mail.<domain> when absent', async () => {
  setup(
    foundZone,
    noRecords,                                      // A mail: absent → will create
    ok({ id: 'new-a' }),                            // POST create A
  );
  queueRestOk();
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: PUBKEY });
  assert.equal(r.phases.a_mail?.status, 'OK');
  const createCall = calls.find(c => c.method === 'POST');
  assert.ok(createCall, 'Expected a POST to create the A record');
});

test('A record: skips mail.<domain> when already correct', async () => {
  setup(foundZone, ok([{ id: 'a-1', content: IP }]));
  queueRestOk();
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: PUBKEY });
  assert.equal(r.phases.a_mail?.status, 'SKIPPED');
  assert.ok(!calls.find(c => c.method === 'POST'), 'No POST expected when record is correct');
});

test('A record: updates mail.<domain> when IP differs', async () => {
  setup(
    foundZone,
    ok([{ id: 'a-old', content: '9.9.9.9' }]),     // wrong IP → PATCH
    ok({ id: 'a-old' }),                            // PATCH response
  );
  queueRestOk();
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: PUBKEY });
  assert.equal(r.phases.a_mail?.status, 'OK');
  assert.ok(calls.find(c => c.method === 'PATCH'), 'Expected PATCH for wrong IP');
});

// ─── SPF ──────────────────────────────────────────────────────────────────────

function queueAMail() {
  queue.push(ok([{ id: 'a-1', content: IP }])); // A mail: correct
}
function queueDkimOk() {
  queue.push(ok([{ id: 'dkim-1', content: `v=DKIM1; k=rsa; p=${PUBKEY}` }]));
}
function queueDmarcOk() {
  queue.push(ok([{ id: 'dmarc-1', content: 'v=DMARC1; p=none' }]));
}

test('SPF: creates record when absent', async () => {
  setup(foundZone);
  queueAMail();
  queueMXOk();
  queue.push(ok([]));            // no TXT records on domain
  queue.push(ok({ id: 'ns' })); // POST create SPF
  queueDkimOk();
  queueDmarcOk();
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: PUBKEY });
  assert.equal(r.phases.spf?.status, 'OK');
  assert.ok(r.phases.spf.message.includes('created'));
});

test('SPF: skips when sending IP already in record', async () => {
  setup(foundZone);
  queueAMail();
  queueMXOk();
  queue.push(ok([{ id: 's-1', content: `v=spf1 ip4:${IP} ~all` }]));
  queueDkimOk();
  queueDmarcOk();
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: PUBKEY });
  assert.equal(r.phases.spf?.status, 'SKIPPED');
});

test('SPF: merges IP into existing record when not present', async () => {
  setup(foundZone);
  queueAMail();
  queueMXOk();
  // Existing SPF without the sending IP
  queue.push(ok([{ id: 's-1', content: 'v=spf1 include:_spf.google.com ~all' }]));
  queue.push(ok({ id: 's-1' })); // PATCH merge response
  queueDkimOk();
  queueDmarcOk();
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: PUBKEY });
  assert.equal(r.phases.spf?.status, 'OK');
  assert.ok(r.phases.spf.message.includes('merged') || r.phases.spf.message.includes(IP));
  const patchCall = calls.find(c => c.method === 'PATCH');
  assert.ok(patchCall, 'Expected PATCH for SPF merge');
});

test('SPF: FAILED when 2 SPF records exist (RFC violation)', async () => {
  setup(foundZone);
  queueAMail();
  queueMXOk();
  queue.push(ok([
    { id: 's-1', content: 'v=spf1 ip4:1.1.1.1 ~all' },
    { id: 's-2', content: 'v=spf1 ip4:2.2.2.2 ~all' },
  ]));
  queueDkimOk();
  queueDmarcOk();
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: PUBKEY });
  assert.equal(r.phases.spf?.status, 'FAILED');
  assert.ok(r.phases.spf.message.includes('RFC violation') || r.phases.spf.message.includes('2'));
  assert.equal(r.ok, false);
});

// ─── DKIM ─────────────────────────────────────────────────────────────────────

function queueSpfOk() {
  queue.push(ok([{ id: 's-1', content: `v=spf1 ip4:${IP} ~all` }]));
}

test('DKIM: creates TXT record when absent', async () => {
  setup(foundZone);
  queueAMail();
  queueMXOk();
  queueSpfOk();
  queue.push(ok([]));            // DKIM absent
  queue.push(ok({ id: 'dk' })); // POST create
  queueDmarcOk();
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: PUBKEY });
  assert.equal(r.phases.dkim?.status, 'OK');
  assert.ok(r.phases.dkim.message.includes('created'));
});

test('DKIM: skips when record is identical', async () => {
  setup(foundZone);
  queueAMail();
  queueMXOk();
  queueSpfOk();
  queue.push(ok([{ id: 'dk-1', content: `v=DKIM1; k=rsa; p=${PUBKEY}` }]));
  queueDmarcOk();
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: PUBKEY });
  assert.equal(r.phases.dkim?.status, 'SKIPPED');
});

test('DKIM: FAILED when existing record has a different key — never overwrites', async () => {
  setup(foundZone);
  queueAMail();
  queueMXOk();
  queueSpfOk();
  queue.push(ok([{ id: 'dk-1', content: 'v=DKIM1; k=rsa; p=DIFFERENTKEYABC' }]));
  queueDmarcOk();
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: PUBKEY });
  assert.equal(r.phases.dkim?.status, 'FAILED');
  assert.ok(r.phases.dkim.message.includes('mismatch') || r.phases.dkim.message.includes('Manual fix'));
  assert.equal(r.ok, false);
});

test('DKIM: PENDING when dkimPublicKey is not yet available', async () => {
  setup(foundZone);
  queueAMail();
  queueMXOk();
  queueSpfOk();
  // No fetch call needed for DKIM when key is null (returns PENDING before listing)
  queueDmarcOk();
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: null });
  assert.equal(r.phases.dkim?.status, 'PENDING');
  assert.equal(r.ok, false); // PENDING counts as not-ok
});

// ─── DMARC ────────────────────────────────────────────────────────────────────

test('DMARC: creates p=none record when absent', async () => {
  setup(foundZone);
  queueAMail();
  queueMXOk();
  queueSpfOk();
  queueDkimOk();
  queue.push(ok([]));              // DMARC absent
  queue.push(ok({ id: 'dm' }));   // POST create
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: PUBKEY });
  assert.equal(r.phases.dmarc?.status, 'OK');
  // All creates go to the same POST URL — find the POST and check its body content
  const postCalls = calls.filter(c => c.method === 'POST');
  assert.equal(postCalls.length, 1, 'Expected exactly one POST for DMARC creation');
  const createBody = JSON.parse(postCalls[0].body || '{}');
  assert.ok(createBody.content?.includes('p=none'), 'DMARC should be created with p=none');
});

test('DMARC: preserves existing record — never overwrites', async () => {
  setup(foundZone);
  queueAMail();
  queueMXOk();
  queueSpfOk();
  queueDkimOk();
  queue.push(ok([{ id: 'dm-1', content: 'v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com' }]));
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: PUBKEY });
  assert.equal(r.phases.dmarc?.status, 'SKIPPED');
  assert.ok(!calls.find(c => c.method === 'POST' && c.url.includes('_dmarc')), 'Existing DMARC must not be overwritten');
});

// ─── provisionDns general ─────────────────────────────────────────────────────

test('provisionDns: skipped when CF_API_TOKEN is not configured', async () => {
  setup(); // reset calls before this test
  const saved = process.env.CF_API_TOKEN;
  process.env.CF_API_TOKEN = '';
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: PUBKEY });
  process.env.CF_API_TOKEN = saved;
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true);
  assert.equal(calls.length, 0, 'No fetch calls when CF not configured');
});

test('provisionDns: a_unsubscribe and a_click SKIPPED when controllerIp not provided', async () => {
  setup(foundZone);
  queueAMail();
  queueMXOk();
  queueSpfOk();
  queueDkimOk();
  queueDmarcOk();
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: PUBKEY });
  assert.equal(r.phases.a_unsubscribe?.status, 'SKIPPED');
  assert.equal(r.phases.a_click?.status, 'SKIPPED');
});

test('provisionDns: creates A unsubscribe and click when controllerIp provided', async () => {
  setup(
    foundZone,
    ok([{ id: 'a-mail', content: IP }]),                              // A mail: correct
    ok([{ id: 'mx-1',   content: `mail.${DOMAIN}`, priority: 10 }]), // MX: correct
    ok([{ id: 's-1',    content: `v=spf1 ip4:${IP} ~all` }]),        // SPF
    ok([{ id: 'dk-1',   content: `v=DKIM1; k=rsa; p=${PUBKEY}` }]), // DKIM
    ok([{ id: 'dm-1',   content: 'v=DMARC1; p=none' }]),            // DMARC
    noRecords,                              // unsubscribe A: absent → create
    ok({ id: 'unsub-new' }),               // POST create unsub
    noRecords,                              // click A: absent → create
    ok({ id: 'click-new' }),               // POST create click
  );
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: PUBKEY, controllerIp: CTLR_IP });
  assert.equal(r.phases.a_unsubscribe?.status, 'OK');
  assert.equal(r.phases.a_click?.status, 'OK');
});

test('provisionDns: works for arbitrary domain — no hardcoded domain check', async () => {
  const arb = 'newbrand.io';
  setup(
    ok([{ id: 'zone-nb' }]),
    ok([{ id: 'a-1',  content: IP }]),
    ok([{ id: 'mx-1', content: `mail.${arb}`, priority: 10 }]),
    ok([{ id: 's-1',  content: `v=spf1 ip4:${IP} ~all` }]),
    ok([{ id: 'dk-1', content: `v=DKIM1; k=rsa; p=${PUBKEY}` }]),
    ok([{ id: 'dm-1', content: 'v=DMARC1; p=none' }]),
  );
  const r = await provisionDns({ domain: arb, ip: IP, selector: SEL, dkimPublicKey: PUBKEY });
  assert.equal(r.ok, true);
  assert.ok(calls[0].url.includes('newbrand.io'), 'Zone lookup must use the supplied domain');
});

test('provisionDns: ok=false when any phase is FAILED', async () => {
  setup(foundZone);
  queueAMail();
  queueMXOk();
  queueSpfOk();
  // DKIM mismatch → FAILED
  queue.push(ok([{ id: 'dk-1', content: 'v=DKIM1; k=rsa; p=WRONGKEY' }]));
  queueDmarcOk();
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: PUBKEY });
  assert.equal(r.ok, false);
  assert.equal(r.phases.dkim?.status, 'FAILED');
});

// ─── MX record ────────────────────────────────────────────────────────────────

test('MX: creates MX 10 mail.<domain> when absent', async () => {
  setup(foundZone);
  queueAMail();
  queue.push(noRecords);                    // MX absent → will create
  queue.push(ok({ id: 'mx-new' }));        // POST create MX
  queueSpfOk();
  queueDkimOk();
  queueDmarcOk();
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: PUBKEY });
  assert.equal(r.phases.mx?.status, 'OK', 'MX absent → create → OK');
  assert.ok(r.phases.mx.message.includes('created'));
  const postCalls = calls.filter(c => c.method === 'POST');
  assert.equal(postCalls.length, 1, 'Expected exactly one POST for MX creation');
  const body = JSON.parse(postCalls[0].body || '{}');
  assert.equal(body.type, 'MX');
  assert.equal(body.content, `mail.${DOMAIN}`);
  assert.equal(body.priority, 10);
});

test('MX: skips when already correct (idempotent)', async () => {
  setup(foundZone);
  queueAMail();
  queue.push(ok([{ id: 'mx-1', content: `mail.${DOMAIN}`, priority: 10 }])); // already correct
  queueSpfOk();
  queueDkimOk();
  queueDmarcOk();
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: PUBKEY });
  assert.equal(r.phases.mx?.status, 'SKIPPED', 'correct MX must be skipped (idempotent)');
  assert.ok(!calls.find(c => c.method === 'POST'), 'No POST when MX is already correct');
});

test('MX: reconciles wrong host (updates to mail.<domain>)', async () => {
  setup(foundZone);
  queueAMail();
  queue.push(ok([{ id: 'mx-old', content: 'mail.other-host.com', priority: 10 }])); // wrong host
  queue.push(ok({ id: 'mx-old' }));  // PATCH response
  queueSpfOk();
  queueDkimOk();
  queueDmarcOk();
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: PUBKEY });
  assert.equal(r.phases.mx?.status, 'OK', 'wrong MX host → reconcile → OK');
  assert.ok(r.phases.mx.message.includes('updated'));
  const patchCall = calls.find(c => c.method === 'PATCH');
  assert.ok(patchCall, 'Expected PATCH to reconcile wrong MX');
  const body = JSON.parse(patchCall.body || '{}');
  assert.equal(body.content, `mail.${DOMAIN}`);
  assert.equal(body.priority, 10);
});

test('MX: reconciles wrong priority (updates to priority 10)', async () => {
  setup(foundZone);
  queueAMail();
  queue.push(ok([{ id: 'mx-p20', content: `mail.${DOMAIN}`, priority: 20 }])); // wrong priority
  queue.push(ok({ id: 'mx-p20' }));  // PATCH response
  queueSpfOk();
  queueDkimOk();
  queueDmarcOk();
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: PUBKEY });
  assert.equal(r.phases.mx?.status, 'OK', 'wrong MX priority → reconcile → OK');
  const patchCall = calls.find(c => c.method === 'PATCH');
  assert.ok(patchCall, 'Expected PATCH to reconcile wrong MX priority');
  const body = JSON.parse(patchCall.body || '{}');
  assert.equal(body.priority, 10);
});

test('MX: readiness fails when MX phase FAILED (ok=false gates provisioning)', async () => {
  // Simulate a CF API error during MX creation
  setup(foundZone);
  queueAMail();
  queue.push({ success: false, result: null, errors: [{ message: 'CF API error creating MX' }] }); // MX create fails
  queueSpfOk();
  queueDkimOk();
  queueDmarcOk();
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: PUBKEY });
  assert.equal(r.phases.mx?.status, 'FAILED', 'CF error on MX create → FAILED');
  assert.equal(r.ok, false, 'readiness fails when MX phase is FAILED');
});

test('MX: readiness passes when MX is correct (ok=true)', async () => {
  setup(foundZone);
  queueAMail();
  queue.push(ok([{ id: 'mx-1', content: `mail.${DOMAIN}`, priority: 10 }])); // MX correct
  queueSpfOk();
  queueDkimOk();
  queueDmarcOk();
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: PUBKEY });
  assert.equal(r.phases.mx?.status, 'SKIPPED');
  assert.equal(r.ok, true, 'readiness passes when MX is correct');
});

test('new identity creates both A and MX records in one provisionDns call', async () => {
  setup(foundZone);
  queue.push(noRecords);                    // A mail: absent → create
  queue.push(ok({ id: 'a-new' }));         // POST A
  queue.push(noRecords);                    // MX: absent → create
  queue.push(ok({ id: 'mx-new' }));        // POST MX
  queueSpfOk();
  queueDkimOk();
  queueDmarcOk();
  const r = await provisionDns({ domain: DOMAIN, ip: IP, selector: SEL, dkimPublicKey: PUBKEY });
  assert.equal(r.phases.a_mail?.status, 'OK', 'A mail created');
  assert.equal(r.phases.mx?.status, 'OK', 'MX created in same provisioning run');
  const posts = calls.filter(c => c.method === 'POST');
  assert.equal(posts.length, 2, 'Two POSTs: one for A mail, one for MX');
  const mxPost = posts.find(p => JSON.parse(p.body || '{}').type === 'MX');
  assert.ok(mxPost, 'One POST must be for MX type');
});
