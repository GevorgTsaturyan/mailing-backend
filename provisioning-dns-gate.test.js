// Tests for the DNS-resolution gate in ControllerProvisioningService.
//
// These verify the race-condition fix: certbot/nginx (provision-identity-hosts.sh)
// must run ONLY after unsubscribe.<domain> and click.<domain> actually resolve.
// All external dependencies (Cloudflare API, DNS resolver, sudo/certbot) are
// injected so no network / no sudo is touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH    = ':memory:';
process.env.JWT_SECRET = 'test-jwt-dns-gate';
process.env.CONTROLLER_PUBLIC_IP = '45.32.235.159';

const db = (await import('./db.js')).default;
const { runControllerProvisioning } = await import('./services/ControllerProvisioningService.js');
const { getPhases } = await import('./services/ProvisioningPhaseStore.js');

const now = new Date().toISOString();
const serverId = Number(
  db.prepare("INSERT INTO servers (label, apiKey, status, createdAt) VALUES ('gate-srv','GATE-KEY','online',?)")
    .run(now).lastInsertRowid
);

let seq = 0;
function mkIdentity(domain) {
  return {
    id: Number(db.prepare(`
      INSERT INTO sender_identities
        (serverId, domain, ip, fromAddr, fromName, dkimSelector,
         status, verificationStatus, provisioningStatus, dailyLimit, dailySentCount, createdAt)
      VALUES (?, ?, '1.2.3.4', ?, 'T', 'mail', 'active', 'NOT_READY', 'DONE', 50, 0, ?)
    `).run(serverId, domain, `s@${domain}`, now).lastInsertRowid),
    domain, ip: '1.2.3.4', dkimSelector: 'mail', dkimPublicKey: 'TESTKEY',
  };
}

// Dependency builders --------------------------------------------------------
const cfConfiguredTrue  = () => true;
const cfConfiguredFalse = () => false;
const cfOk   = async () => ({ ok: true,  phases: { a_mail:{status:'OK'}, mx:{status:'OK'}, spf:{status:'OK'}, dkim:{status:'OK'}, dmarc:{status:'OK'}, a_unsubscribe:{status:'OK'}, a_click:{status:'OK'} } });
const cfThrow = async () => { throw new Error('Cloudflare API 500'); };

const dnsResolves    = async () => ({ ok: true,  hosts: { unsubscribe:{resolves:true, matches:true,  addresses:['45.32.235.159']}, click:{resolves:true, matches:true, addresses:['45.32.235.159']} } });
const dnsNotResolved = async () => ({ ok: false, hosts: { unsubscribe:{resolves:false,matches:false, addresses:[]},               click:{resolves:false,matches:false, addresses:[]} } });

const nginxStdoutOk =
  '── unsubscribe.x ──\n  [cert]  Certificate issued; nginx HTTPS block added\n' +
  '── click.x ──\n  [cert]  Certificate issued; nginx HTTPS block added\n' +
  'Health probes\n  https://unsubscribe.x ✓\n  https://click.x ✓\n';

// ── Tests ───────────────────────────────────────────────────────────────────

test('CF succeeds + DNS resolves → nginx/TLS runs AFTER the DNS gate', async () => {
  const id = mkIdentity(`cf-dns-ok-${seq++}.example`);
  let nginxCalled = false;
  const r = await runControllerProvisioning(id, {
    deps: {
      cfConfigured: cfConfiguredTrue,
      provisionDns: cfOk,
      checkControllerHostsResolve: dnsResolves,
      runNginxScript: async () => { nginxCalled = true; return { err: null, stdout: nginxStdoutOk }; },
    },
  });
  assert.equal(nginxCalled, true, 'nginx must run when DNS resolves');
  assert.equal(r.dnsReady, true);
  assert.equal(r.ranNginx, true);

  const p = getPhases(id.id);
  assert.equal(p.cloudflare.status, 'OK');
  assert.equal(p.dns.status, 'OK');
  assert.equal(p.nginx.status, 'DONE');
  assert.equal(p.ptr.status, 'MANUAL');
});

test('CF succeeds but DNS NOT resolved yet → nginx/certbot is DEFERRED', async () => {
  const id = mkIdentity(`cf-ok-dns-wait-${seq++}.example`);
  let nginxCalled = false;
  const r = await runControllerProvisioning(id, {
    deps: {
      cfConfigured: cfConfiguredTrue,
      provisionDns: cfOk,
      checkControllerHostsResolve: dnsNotResolved,
      runNginxScript: async () => { nginxCalled = true; return { err: null, stdout: nginxStdoutOk }; },
    },
  });
  assert.equal(nginxCalled, false, 'certbot/nginx must NOT run while DNS is unresolved');
  assert.equal(r.dnsReady, false);
  assert.equal(r.ranNginx, false);

  const p = getPhases(id.id);
  assert.equal(p.cloudflare.status, 'OK');
  assert.equal(p.dns.status, 'PENDING');
  assert.equal(p.nginx.status, 'PENDING');       // deferred, not FAILED
  assert.ok(/resolve/i.test(p.nginx.message || p.dns.message));
  assert.equal(p.ptr.status, 'MANUAL');
});

test('retry eventually sees DNS resolve → nginx/TLS then proceeds', async () => {
  const id = mkIdentity(`retry-dns-${seq++}.example`);
  let dnsReady = false;
  let nginxCalls = 0;
  const deps = {
    cfConfigured: cfConfiguredTrue,
    provisionDns: cfOk,
    checkControllerHostsResolve: async () => (dnsReady ? dnsResolves() : dnsNotResolved()),
    runNginxScript: async () => { nginxCalls++; return { err: null, stdout: nginxStdoutOk }; },
  };

  // 1st pass: DNS not ready → deferred
  await runControllerProvisioning(id, { deps });
  assert.equal(nginxCalls, 0, 'first pass must defer nginx');
  assert.equal(getPhases(id.id).nginx.status, 'PENDING');

  // DNS propagates, retry pass runs nginx
  dnsReady = true;
  await runControllerProvisioning(id, { deps });
  assert.equal(nginxCalls, 1, 'retry must run nginx once DNS resolves');
  assert.equal(getPhases(id.id).dns.status, 'OK');
  assert.equal(getPhases(id.id).nginx.status, 'DONE');
});

test('CF failure → nginx/TLS does NOT run prematurely', async () => {
  const id = mkIdentity(`cf-fail-${seq++}.example`);
  let nginxCalled = false;
  const r = await runControllerProvisioning(id, {
    deps: {
      cfConfigured: cfConfiguredTrue,
      provisionDns: cfThrow,
      // With CF failed, records aren't created → DNS does not resolve.
      checkControllerHostsResolve: dnsNotResolved,
      runNginxScript: async () => { nginxCalled = true; return { err: null, stdout: nginxStdoutOk }; },
    },
  });
  assert.equal(nginxCalled, false, 'nginx must not run when CF failed and DNS unresolved');
  assert.equal(r.ranNginx, false);

  const p = getPhases(id.id);
  assert.equal(p.cloudflare.status, 'FAILED');
  assert.equal(p.nginx.status, 'PENDING');        // still pending, never FAILED
  assert.equal(p.ptr.status, 'MANUAL');
});

test('PTR is always MANUAL and never mentions OVH', async () => {
  const id = mkIdentity(`ptr-manual-${seq++}.example`);
  await runControllerProvisioning(id, {
    deps: {
      cfConfigured: cfConfiguredTrue,
      provisionDns: cfOk,
      checkControllerHostsResolve: dnsResolves,
      runNginxScript: async () => ({ err: null, stdout: nginxStdoutOk }),
    },
  });
  const p = getPhases(id.id);
  assert.equal(p.ptr.status, 'MANUAL');
  assert.ok(!/ovh/i.test(p.ptr.message || ''), 'PTR message must not mention OVH');
  assert.ok(p.ptr.message.includes('1.2.3.4'), 'PTR message includes the sending IP');
});

test('CF not configured + DNS resolves (manual DNS) → nginx still runs via gate', async () => {
  const id = mkIdentity(`cf-off-dns-ok-${seq++}.example`);
  let nginxCalled = false;
  await runControllerProvisioning(id, {
    deps: {
      cfConfigured: cfConfiguredFalse,
      checkControllerHostsResolve: dnsResolves,
      runNginxScript: async () => { nginxCalled = true; return { err: null, stdout: nginxStdoutOk }; },
    },
  });
  assert.equal(nginxCalled, true, 'if DNS resolves (even without CF automation), nginx proceeds');
  const p = getPhases(id.id);
  assert.equal(p.cloudflare.status, 'NOT_RUN');
  assert.equal(p.dns.status, 'OK');
  assert.equal(p.nginx.status, 'DONE');
});

// ── DnsResolutionService unit tests (injected resolver, no network) ──────────

const dnsMod = await import('./services/DnsResolutionService.js');

test('DnsResolutionService: ok when both hosts resolve to the expected IP', async () => {
  dnsMod.__setResolver(async () => ['45.32.235.159']);
  const r = await dnsMod.checkControllerHostsResolve({ domain: 'x.example', expectedIp: '45.32.235.159' });
  dnsMod.__resetResolver();
  assert.equal(r.ok, true);
  assert.equal(r.hosts.unsubscribe.matches, true);
  assert.equal(r.hosts.click.matches, true);
});

test('DnsResolutionService: NOT ok when resolved IP differs from expected', async () => {
  dnsMod.__setResolver(async () => ['1.2.3.4']);
  const r = await dnsMod.checkControllerHostsResolve({ domain: 'x.example', expectedIp: '45.32.235.159' });
  dnsMod.__resetResolver();
  assert.equal(r.ok, false, 'wrong A record must not satisfy the gate');
});

test('DnsResolutionService: NOT ok on NXDOMAIN (resolver throws)', async () => {
  dnsMod.__setResolver(async () => { const e = new Error('nope'); e.code = 'ENOTFOUND'; throw e; });
  const r = await dnsMod.checkControllerHostsResolve({ domain: 'x.example', expectedIp: '45.32.235.159' });
  dnsMod.__resetResolver();
  assert.equal(r.ok, false);
  assert.equal(r.hosts.unsubscribe.resolves, false);
  assert.equal(r.hosts.unsubscribe.error, 'ENOTFOUND');
});

test('DnsResolutionService: without expectedIp, any A record counts as resolvable', async () => {
  dnsMod.__setResolver(async () => ['9.9.9.9']);
  const r = await dnsMod.checkControllerHostsResolve({ domain: 'x.example', expectedIp: null });
  dnsMod.__resetResolver();
  assert.equal(r.ok, true);
});

// ── Fix B: public resolver vs. local negative cache ────────────────────────────

test('Fix B: when the (public) resolver sees the record, the gate considers it available', async () => {
  // The dedicated public resolver returns the correct IP even though a LOCAL stub
  // resolver would still be serving a cached NXDOMAIN. The gate must pass.
  dnsMod.__setResolver(async () => ['45.32.235.159']);
  const r = await dnsMod.checkControllerHostsResolve({ domain: 'ardovia.co', expectedIp: '45.32.235.159' });
  dnsMod.__resetResolver();
  assert.equal(r.ok, true, 'gate must trust the public-resolver answer, not a stale local NXDOMAIN');
});

test('Fix B: when even the public resolver cannot resolve, the gate stays NOT ok (defer certbot)', async () => {
  dnsMod.__setResolver(async () => { const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e; });
  const r = await dnsMod.checkControllerHostsResolve({ domain: 'notyet.example', expectedIp: '45.32.235.159' });
  dnsMod.__resetResolver();
  assert.equal(r.ok, false, 'if public DNS also has no record, do not run nginx/certbot');
});
