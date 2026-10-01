// ─── ProvisioningRetryService ─────────────────────────────────────────────────
// Background service that automatically completes provisioning for identities
// that have finished local mail-node config (provisioningStatus = 'DONE') but
// have not yet achieved verificationStatus = 'READY'.
//
// Two retry strategies run every RETRY_INTERVAL_MS (5 min):
//
// 1. Controller-side pipeline (no mail-node involvement):
//    Re-runs runControllerProvisioning() — CF DNS → DNS-resolution gate →
//    nginx/TLS. Because the gate is inside the shared pipeline, certbot is only
//    ever attempted once DNS actually resolves, so it is never hammered while
//    unsubscribe/click are still NXDOMAIN. This is the retry that eventually
//    completes nginx/TLS after Cloudflare DNS propagates.
//
// 2. Mail-node reverification:
//    Creates a 'reverify' provisioning_task so the mail-node picks it up on its
//    next 30-second poll and calls verifyAndReport().  Only one such task is
//    queued at a time per identity; cooldown prevents rapid hammering.

import db from '../db.js';
import { isConfigured as cfConfigured } from './CloudflareService.js';
import { runControllerProvisioning } from './ControllerProvisioningService.js';

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

async function retryIdentity(identity, provision) {
  const phases = parsePhases(identity);

  // Re-run the shared controller pipeline if anything upstream of READY is
  // incomplete. The DNS-resolution gate inside the pipeline guarantees certbot
  // is deferred (not hammered) while DNS is still NXDOMAIN.
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
  // provisioner is injectable for tests; production uses the real pipeline.
  const provision = opts.provisioner || runControllerProvisioning;

  const candidates = db.prepare(`
    SELECT id, domain, ip, dkimSelector, serverId, provisioningPhases,
           dkimPublicKey, nextReverifyAt
    FROM sender_identities
    WHERE provisioningStatus = 'DONE' AND verificationStatus != 'READY'
  `).all();

  if (candidates.length === 0) return;
  log(`checking ${candidates.length} DONE-but-not-READY identity(ies)`);

  for (const identity of candidates) {
    try { await retryIdentity(identity, provision); }
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
