import { test } from 'node:test';
import assert from 'node:assert/strict';

// Secrets must be set BEFORE importing the token module (read lazily, but set here
// so every test in the file has them).
process.env.TRACKING_SECRET = 'test-tracking-secret-0123456789abcdef';
process.env.TRACKING_IP_SALT = 'test-ip-salt-abcdef';

const {
  signToken, verifyToken, buildClickUrl, buildOpenPixelUrl, trackingBaseUrl, hashIp,
} = await import('./services/trackingToken.js');
const { classifyClick, classifyOpen } = await import('./services/trackingClassifier.js');
const {
  compile, renderButtonHtml, renderButtonText, injectPixel,
  hasButtonPlaceholder, referencedButtonIds,
} = await import('./services/BodyCompiler.js');
const { ipInCidr, ipInAnyCidr, matchesUa } = await import('./services/trackingScanners.js');

// ── Token ──────────────────────────────────────────────────────────────────────

test('token round-trips and verifies', () => {
  const payload = { t: 'c', ca: 12, c: 345, cb: 6, v: 1 };
  const tok = signToken(payload);
  assert.deepEqual(verifyToken(tok), payload);
});

test('tampered payload fails verification', () => {
  const tok = signToken({ t: 'c', ca: 1, c: 2, cb: 3, v: 1 });
  const [p, s] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ t: 'c', ca: 1, c: 999, cb: 3, v: 1 })).toString('base64url');
  assert.equal(verifyToken(`${forged}.${s}`), null);
  assert.equal(verifyToken('garbage'), null);
  assert.equal(verifyToken(`${p}.`), null);
});

test('click/open URLs use the sending-domain subdomain and carry no PII', () => {
  const click = buildClickUrl('serawin.net', { campaignId: 5, contactId: 9, campaignButtonId: 2 });
  const open  = buildOpenPixelUrl('serawin.net', { campaignId: 5, contactId: 9 });
  assert.ok(click.startsWith('https://click.serawin.net/c/'));
  assert.ok(open.startsWith('https://click.serawin.net/o/'));
  assert.ok(open.endsWith('.gif'));
  // no email/PII anywhere in the URL
  assert.ok(!/@|serawin\.net\/c\/.*=.*/.test(click.replace('click.serawin.net', '')));
  assert.equal(trackingBaseUrl('a.com'), 'https://click.a.com');
});

test('destination URL never appears in the token', () => {
  const click = buildClickUrl('serawin.net', { campaignId: 5, contactId: 9, campaignButtonId: 2 });
  const token = click.split('/c/')[1];
  assert.equal(verifyToken(token).t, 'c');
  assert.ok(!JSON.stringify(verifyToken(token)).includes('http'));
});

test('hashIp is stable and never returns the raw ip', () => {
  const h = hashIp('203.0.113.7');
  assert.equal(hashIp('203.0.113.7'), h);
  assert.notEqual(h, '203.0.113.7');
  assert.equal(hashIp(null), null);
});

// ── CIDR / UA matching ──────────────────────────────────────────────────────────

test('ipv4 CIDR matching', () => {
  assert.ok(ipInCidr('10.0.5.9', '10.0.0.0/16'));
  assert.ok(!ipInCidr('10.1.5.9', '10.0.0.0/16'));
  assert.ok(ipInAnyCidr('148.163.130.1', ['148.163.128.0/17']));
  assert.ok(!ipInCidr('not-an-ip', '10.0.0.0/8'));      // IPv6/garbage never matches
  assert.ok(!ipInCidr('2001:db8::1', '10.0.0.0/8'));
});

test('UA matching is case-insensitive substring', () => {
  assert.ok(matchesUa('Mozilla Proofpoint/1', ['proofpoint']));
  assert.ok(!matchesUa('Mozilla/5.0', ['proofpoint']));
});

// ── Click classification (conservative) ──────────────────────────────────────────

test('HEAD → scanner', () => {
  assert.equal(classifyClick({ http_method: 'HEAD' }).classification, 'scanner');
});
test('prefetch header → scanner (bot bucket collapsed into scanner)', () => {
  assert.equal(classifyClick({ http_method: 'GET', is_prefetch: true }).classification, 'scanner');
});
test('burst (another button already clicked) → scanner', () => {
  assert.equal(classifyClick({ http_method: 'GET', burst: true, seconds_since_send: 500 }).classification, 'scanner');
});
test('faster-than-human → scanner (configurable threshold)', () => {
  assert.equal(classifyClick({ http_method: 'GET', seconds_since_send: 3 }).classification, 'scanner');
  assert.equal(classifyClick({ http_method: 'GET', seconds_since_send: 3 }, { fastThresholdSeconds: 2 }).classification, 'human');
});
test('scanner network → scanner', () => {
  assert.equal(classifyClick({ http_method: 'GET', ip_scanner: true, seconds_since_send: 500 }).classification, 'scanner');
});
test('datacenter alone → unknown (never bot on weak signal)', () => {
  assert.equal(classifyClick({ http_method: 'GET', ip_datacenter: true, seconds_since_send: 500 }).classification, 'unknown');
});
test('scanner UA alone is unconfirmed → unknown', () => {
  assert.equal(classifyClick({ http_method: 'GET', ua_scanner: true, seconds_since_send: 500 }).classification, 'unknown');
});
test('ordinary request → human', () => {
  assert.equal(classifyClick({ http_method: 'GET', seconds_since_send: 500 }).classification, 'human');
});

// ── Open classification ──────────────────────────────────────────────────────────

// Opens: honest 'open' | 'prefetch'. We must NOT misclassify Gmail (image proxy /
// Google datacenter IP) or Apple Mail human opens as automated.
test('fast/HEAD/prefetch-header/scanner open → prefetch; ordinary → open', () => {
  assert.equal(classifyOpen({ seconds_since_send: 2 }).classification, 'prefetch');
  assert.equal(classifyOpen({ http_method: 'HEAD' }).classification, 'prefetch');
  assert.equal(classifyOpen({ is_prefetch: true }).classification, 'prefetch');
  assert.equal(classifyOpen({ ip_scanner: true, seconds_since_send: 500 }).classification, 'prefetch');
  assert.equal(classifyOpen({ seconds_since_send: 500 }).classification, 'open');
});
test('Gmail-style opens are NOT misclassified as automated (datacenter IP / proxy UA)', () => {
  // A real Gmail open arrives via Google's proxy (datacenter IP) well after send;
  // it must count as an 'open', never 'prefetch'.
  assert.equal(classifyOpen({ ip_datacenter: true, seconds_since_send: 500 }).classification, 'open');
});

// ── BodyCompiler ─────────────────────────────────────────────────────────────────

const resolveSnapshot = (id) => {
  if (id === 7) return { id: 700, text: 'PLAY NOW', destination_url: 'https://x/game-a', style: {} };
  throw new Error(`Button #${id} not found`);
};
const clickUrl = (cbId) => `https://click.serawin.net/c/TOK${cbId}`;

test('HTML button expands to a table anchor with the tracking URL', () => {
  const { html, txt } = compile(
    { html: '<p>hi</p>{{button:7}}', txt: 'hi {{button:7}}' },
    { resolveSnapshot, clickUrl, pixelUrl: null },
  );
  assert.ok(html.includes('<table'));
  assert.ok(html.includes('href="https://click.serawin.net/c/TOK700"'));
  assert.ok(html.includes('PLAY NOW'));
  // plain text stays usable
  assert.ok(txt.includes('PLAY NOW: https://click.serawin.net/c/TOK700'));
});

test('pixel injected only when pixelUrl provided, and before </body>', () => {
  const withPixel = compile(
    { html: '<html><body><p>hi</p></body></html>', txt: 'hi' },
    { resolveSnapshot, clickUrl, pixelUrl: 'https://click.serawin.net/o/TOK.gif' },
  ).html;
  assert.ok(withPixel.includes('<img src="https://click.serawin.net/o/TOK.gif"'));
  assert.ok(withPixel.indexOf('<img') < withPixel.indexOf('</body>'));

  const noPixel = compile(
    { html: '<html><body><p>hi</p></body></html>', txt: 'hi' },
    { resolveSnapshot, clickUrl, pixelUrl: null },
  ).html;
  assert.ok(!noPixel.includes('<img'));
});

test('no placeholders → body unchanged and never pixel when disabled', () => {
  const src = { html: '<p>plain</p>', txt: 'plain' };
  const out = compile(src, { resolveSnapshot, clickUrl, pixelUrl: null });
  assert.equal(out.html, '<p>plain</p>');
  assert.equal(out.txt, 'plain');
});

test('missing button hard-fails compilation (no broken CTA emitted)', () => {
  assert.throws(
    () => compile({ html: '{{button:99}}', txt: '' }, { resolveSnapshot, clickUrl, pixelUrl: null }),
    /Button #99 not found/,
  );
});

test('helpers detect and list referenced buttons', () => {
  assert.ok(hasButtonPlaceholder('a {{button:3}} b'));
  assert.ok(!hasButtonPlaceholder('no buttons here'));
  assert.deepEqual(referencedButtonIds({ html: '{{button:3}}{{button:5}}', txt: '{{button:3}}' }).sort(), [3, 5]);
});

test('injectPixel appends at end when no body tag', () => {
  assert.equal(injectPixel('<p>x</p>', null), '<p>x</p>');
  assert.ok(injectPixel('<p>x</p>', 'https://u/o.gif').endsWith('/></p>') === false); // pixel appended after
  assert.ok(injectPixel('<p>x</p>', 'https://u/o.gif').includes('<img src="https://u/o.gif"'));
});
