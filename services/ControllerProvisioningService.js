// ─── ControllerProvisioningService ────────────────────────────────────────────
// The single, idempotent controller-side provisioning pipeline for one sender
// identity. Called by BOTH the task-result handler (routes/nodes.js, initial run)
// and ProvisioningRetryService (background retry) so the sequencing is identical
// everywhere and there is no duplicated logic.
//
// Pipeline (state machine):
//   CLOUDFLARE  → create/verify all DNS records via the Cloudflare API
//   PTR         → always MANUAL; never blocks the automated pipeline
//   DNS gate    → wait until unsubscribe.<domain> + click.<domain> actually
//                 RESOLVE in public DNS (CF API success ≠ propagation)
//   NGINX/TLS   → run provision-identity-hosts.sh (certbot) ONLY after the gate
//
// If the DNS gate is not satisfied yet, nginx/TLS is left PENDING (never FAILED)
// and the retry service re-runs this pipeline on its cooldown — so certbot is
// never hammered while DNS is NXDOMAIN, and the user never has to add DNS by hand.
//
// All external dependencies are injectable via `deps` so tests never touch the
// network, the Cloudflare API, or sudo/certbot.

import { execFile as _execFile } from 'node:child_process';
import { provisionDns as _provisionDns, isConfigured as _cfConfigured } from './CloudflareService.js';
import { checkControllerHostsResolve as _checkControllerHostsResolve } from './DnsResolutionService.js';
import { mergePhases, parseNginxOutput } from './ProvisioningPhaseStore.js';
import { PROVISION_SCRIPT } from '../routes/admin.js';

function defaultRunNginxScript(domain, execFileImpl) {
  return new Promise((resolve) => {
    execFileImpl(
      'sudo', [PROVISION_SCRIPT, domain],
      { timeout: 300_000, maxBuffer: 512 * 1024 },
      (err, stdout) => resolve({ err, stdout: stdout || '' })
    );
  });
}

function ptrMessage(identity) {
  return `Set PTR record: ${identity.ip} → mail.${identity.domain} (in your hosting provider's control panel under Reverse DNS)`;
}

// Run the full controller-side pipeline for one identity.
// Returns { cfStatus, dnsReady, ranNginx, nginxError }.
export async function runControllerProvisioning(identity, opts = {}) {
  const { dkimPublicKey = null, deps = {} } = opts;

  const provisionDns  = deps.provisionDns  || _provisionDns;
  const cfConfigured  = deps.cfConfigured  || _cfConfigured;
  const checkDns      = deps.checkControllerHostsResolve || _checkControllerHostsResolve;
  const execFileImpl  = deps.execFile      || _execFile;
  const runNginx      = deps.runNginxScript || ((domain) => defaultRunNginxScript(domain, execFileImpl));

  // Read at call time (not module load) so tests and runtime config both work.
  const controllerIp = process.env.CONTROLLER_PUBLIC_IP || '';
  const dkimKey      = dkimPublicKey || identity.dkimPublicKey || null;

  // ── 1. Cloudflare DNS ─────────────────────────────────────────────────────
  let cfStatus = 'NOT_RUN';
  if (cfConfigured()) {
    try {
      const cf = await provisionDns({
        domain:       identity.domain,
        ip:           identity.ip,
        selector:     identity.dkimSelector,
        dkimPublicKey: dkimKey,
        controllerIp,
      });
      cfStatus = cf.ok ? 'OK' : (cf.skipped ? 'NOT_RUN' : 'PARTIAL');
      mergePhases(identity.id, {
        cloudflare: {
          status: cfStatus,
          phases: cf.phases,
          ...(cf.skipped ? { message: cf.message } : {}),
        },
      });
    } catch (err) {
      cfStatus = 'FAILED';
      console.error(`[controller-provision] CF DNS failed for ${identity.domain}:`, err.message);
      mergePhases(identity.id, { cloudflare: { status: 'FAILED', error: err.message, phases: {} } });
    }
  } else {
    mergePhases(identity.id, {
      cloudflare: {
        status:  'NOT_RUN',
        message: 'CF_API_TOKEN not configured — DNS records must be created manually',
        phases:  {},
      },
    });
  }

  // ── 2. PTR — always MANUAL, independent, never blocks the pipeline ─────────
  mergePhases(identity.id, { ptr: { status: 'MANUAL', message: ptrMessage(identity) } });

  // ── 3. DNS-resolution gate ────────────────────────────────────────────────
  // Certbot must NOT run until unsubscribe.<domain> and click.<domain> actually
  // resolve, otherwise Let's Encrypt gets NXDOMAIN.
  const dns = await checkDns({ domain: identity.domain, expectedIp: controllerIp || null });
  if (!dns.ok) {
    mergePhases(identity.id, {
      dns: {
        status:  'PENDING',
        message: `Waiting for unsubscribe.${identity.domain} and click.${identity.domain} to resolve${controllerIp ? ` to ${controllerIp}` : ''} (certbot deferred to avoid NXDOMAIN)`,
        hosts:   dns.hosts,
      },
      nginx: {
        status:  'PENDING',
        message: 'Deferred until DNS resolves — will retry automatically',
        phases:  {},
      },
    });
    return { cfStatus, dnsReady: false, ranNginx: false, nginxError: null };
  }

  mergePhases(identity.id, {
    dns: { status: 'OK', message: 'unsubscribe + click resolve', hosts: dns.hosts },
  });

  // ── 4. nginx + TLS (certbot) — only now that DNS resolves ──────────────────
  const { err, stdout } = await runNginx(identity.domain);
  mergePhases(identity.id, { nginx: { status: 'DONE', phases: parseNginxOutput(stdout) } });
  if (err) {
    console.error(`[controller-provision] nginx/TLS error for ${identity.domain}:`, err.message);
  } else {
    console.log(`[controller-provision] nginx/TLS provisioned for ${identity.domain}`);
  }
  return { cfStatus, dnsReady: true, ranNginx: true, nginxError: err || null };
}
