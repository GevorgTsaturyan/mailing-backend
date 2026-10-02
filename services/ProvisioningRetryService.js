// ─── ProvisioningRetryService ─────────────────────────────────────────────────
// Background service that automatically completes AND heals the controller-side
// provisioning for every identity whose mail-node config is done
// (provisioningStatus = 'DONE'), AND for identities that were manually
// provisioned (provisioningStatus = 'unprovisioned') but have already been
// verified by the mail-node (verificationStatus = 'READY').
//
// It runs every RETRY_INTERVAL_MS (5 min) and handles two distinct situations:
//
// A. In-flight identities (verificationStatus != 'READY'):
//    - Re-runs runControllerProvisioning() when the recorded pipeline phases show
//      Cloudflare / DNS-gate / nginx-TLS work still to do. The DNS-resolution gate
//      inside the pipeline guarantees certbot is only attempted once DNS actually
//      resolves, so it is never hammered while unsubscribe/click are NXDOMAIN.
//    - Schedules a mail-node 'reverify' task (cooldown-guarded) so READY can be
//      reached once DNS/DKIM/FCrDNS propagate and (manual) PTR is set.
//
// B. Already-READY identities (Fix A — heal the controller side):
//    The mail-node can report READY (DKIM/SPF/FCrDNS all fine) while the
//    CONTROLLER-side tracking/unsubscribe hosts are broken or never finished —
//    e.g. click.<domain> serving the wrong/default TLS cert. Previously READY
//    identities were excluded from retry entirely, so that state was permanent.
//    Now we STRICTLY probe https://click.<domain>/tracking-health and
//    https://unsubscribe.<domain>/unsubscribe-health; if either is not serving
//    correctly, we re-run the (idempotent) controller pipeline to repair it. We
//    NEVER schedule a mail-node reverify for an already-READY identity, and we
//    never touch PTR (manual).
//
//    This case also covers manually provisioned identities (provisioningStatus =
//    'unprovisioned') that are already READY — e.g. serawin.net, set up before
//    the controller pipeline existed. Those identities were previously excluded
//    from the loop entirely, causing a permanent false NEEDS_ATTENTION warning in
//    the UI even when their tracking/unsubscribe hosts are fully operational.

import db from '../db.js';
import { isConfigured as cfConfigured } from './CloudflareService.js';
import { runControllerProvisioning } from './ControllerProvisioningService.js';
import { checkControllerHostsHealthy } from './ControllerHostHealth.js';
import { mergePhases } from './ProvisioningPhaseStore.js';

const RETRY_INTERVAL_MS  = 5 * 60 * 1000;  // 5 minutes between retry cycles
const REVERIFY_COOLDOWN  = 5 * 60 * 1000;  // minimum gap between reverify tasks

function log(msg)  { console.log(`[prov-retry] ${msg}`); }
function warn(msg) { console.warn(`[prov-retry] WARN: ${msg}`); }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parsePhases(identity) {
  if (!identity.provisioningPhases) return {};
  try { return JSON.parse(identity.provisioningPhases); } catch { return {}; }
}

function cfNeedsRetry(phases) {
  if (!cfConfigured()) return false;
  const cf = phases.cloudflare;
  if (!cf) return true;  // never ran CF DNS
  const { phases: p = {} } = cf;
  return Object.values(p).some(v => v?.status === 'PENDING' || v?.status === 'FAILED');
}

// Does the controller-side pipeline still have work to do for this identity?
// True when Cloudflare, the DNS-resolution gate, or nginx/TLS is incomplete.
export function controllerNeedsRetry(phases) {
  // Cloudflare records not fully in place
  if (cfNeedsRetry(phases)) return true;

  // DNS-resolution gate not yet satisfied (missing, pending, or failed)
  const dns = phases.dns;
  if (!dns || dns.status === 'PENDING' || dns.status === 'FAILED') return true;

  // nginx/TLS incomplete (deferred, never ran, or a sub-phase still pending)
  const ng = phases.nginx;
  if (!ng) return true;
  if (ng.status === 'PENDING') return true;
  const sub = ng.phases || {};
  if (Object.values(sub).some(v => v?.status === 'PENDING')) return true;

  return false;
}

// ─── Per-identity retry ───────────────────────────────────────────────────────

async function retryIdentity(identity, provision, hostsHealthy) {
  const phases  = parsePhases(identity);
  const isReady = identity.verificationStatus === 'READY';

  if (isReady) {
    // ── Case B: mail-node is satisfied — only heal the CONTROLLER side ────────
    // Strict public probe (no hairpin fallback) so a wrong/default TLS cert is
    // detected rather than masked. Avoids churn: a healthy identity does not run
    // the pipeline.
    let health;
    try {
      health = await hostsHealthy(identity.domain);
    } catch (err) {
      warn(`controller host health probe failed for ${identity.domain}: ${err.message}`);
      health = { ok: false, hosts: {} };
    }

    // Record ground-truth controller health so the UI can reflect it even for
    // legacy identities that have no pipeline phase blob.
    mergePhases(identity.id, {
      controllerHealth: {
        status:    health.ok ? 'OK' : 'FAILED',
        hosts:     health.hosts || {},
        checkedAt: new Date().toISOString(),
      },
    });

    if (!health.ok) {
      log(`healing controller hosts for READY ${identity.domain} ` +
          `(click=${health.hosts?.click?.ok} unsubscribe=${health.hosts?.unsubscribe?.ok})`);
      try {
        await provision(identity, { dkimPublicKey: identity.dkimPublicKey || null });
      } catch (err) {
        warn(`controller healing failed for ${identity.domain}: ${err.message}`);
      }
    }

    // Never schedule a mail-node reverify for an already-READY identity.
    return;
  }

  // ── Case A: in-flight — drive the pipeline forward from recorded phases ─────
  // The DNS-resolution gate inside the pipeline guarantees certbot is deferred
  // (not hammered) while DNS is still NXDOMAIN.
  if (controllerNeedsRetry(phases)) {
    log(`controller pipeline retry for ${identity.domain}`);
    try {
      await provision(identity, { dkimPublicKey: identity.dkimPublicKey || null });
    } catch (err) {
      warn(`controller pipeline retry failed for ${identity.domain}: ${err.message}`);
    }
  }

  // Schedule mail-node reverification task (only if no active task exists)
  scheduleReverifyTask(identity);
}

// Create a 'reverify' task for the mail-node to pick up within ~30 seconds.
// Skips if a PENDING or IN_PROGRESS task already exists (any type).
// Enforces REVERIFY_COOLDOWN via nextReverifyAt.
function scheduleReverifyTask(identity) {
  const now = new Date();

  // Cooldown: don't queue if nextReverifyAt is in the future
  if (identity.nextReverifyAt && new Date(identity.nextReverifyAt) > now) return;

  // Don't queue if there's already an active task
  const existing = db.prepare(
    "SELECT id FROM provisioning_tasks WHERE identityId=? AND status IN ('PENDING','IN_PROGRESS') LIMIT 1"
  ).get(identity.id);
  if (existing) return;

  db.prepare(
    "INSERT INTO provisioning_tasks (identityId, serverId, status, taskType, requestedAt) VALUES (?,?,'PENDING','reverify',?)"
  ).run(identity.id, identity.serverId, now.toISOString());

  // Set cooldown so we don't queue another immediately after this one is claimed
  const cooldownAt = new Date(now.getTime() + REVERIFY_COOLDOWN).toISOString();
  db.prepare("UPDATE sender_identities SET nextReverifyAt=? WHERE id=?").run(cooldownAt, identity.id);
}

// ─── Main retry loop ──────────────────────────────────────────────────────────

async function runRetries(opts = {}) {
  // Injectable for tests; production uses the real pipeline + strict health probe.
  const provision     = opts.provisioner  || runControllerProvisioning;
  const hostsHealthy  = opts.hostsHealthy  || ((domain) => checkControllerHostsHealthy({ domain }));

  // Include two sets of identities:
  //  • DONE: went through the full pipeline; both in-flight (Case A) and
  //    already-READY (Case B) variants need periodic checks.
  //  • unprovisioned + READY: manually configured before the controller pipeline
  //    existed (e.g. serawin.net). Their verificationStatus is READY (mail-node
  //    confirmed) but controllerHealth was never written, causing a false
  //    NEEDS_ATTENTION warning. Case B writes controllerHealth without touching
  //    any infrastructure — no nginx/DNS/Postfix changes are made when healthy.
  const candidates = db.prepare(`
    SELECT id, domain, ip, dkimSelector, serverId, provisioningPhases,
           dkimPublicKey, nextReverifyAt, verificationStatus
    FROM sender_identities
    WHERE provisioningStatus = 'DONE'
       OR (provisioningStatus = 'unprovisioned' AND verificationStatus = 'READY')
  `).all();

  if (candidates.length === 0) return;
  log(`checking ${candidates.length} identity(ies)`);

  for (const identity of candidates) {
    try { await retryIdentity(identity, provision, hostsHealthy); }
    catch (err) { warn(`retry cycle error for ${identity.domain}: ${err.message}`); }
  }
}

// Exported for testing. In production, always accessed via startProvisioningRetryService.
export { runRetries };

export function startProvisioningRetryService() {
  // 15-second delay after startup before first run (let the server fully initialize)
  setTimeout(() => {
    runRetries().catch(err => warn(`initial run error: ${err.message}`));
  }, 15_000);

  setInterval(() => {
    runRetries().catch(err => warn(`interval run error: ${err.message}`));
  }, RETRY_INTERVAL_MS);

  log(`started — retry interval ${RETRY_INTERVAL_MS / 60_000} min`);
}
