// ─── ProvisioningRetryService ─────────────────────────────────────────────────
// Background service that automatically retries pending provisioning phases
// for identities that have finished local mail-node config (provisioningStatus =
// 'DONE') but have not yet achieved verificationStatus = 'READY'.
//
// Two retry strategies run every RETRY_INTERVAL_MS (5 min):
//
// 1. Controller-side retries (no mail-node involvement):
//    • Cloudflare DNS — re-runs provisionDns() for phases still PENDING/FAILED
//    • nginx/TLS      — re-runs provision-identity-hosts.sh for pending TLS
//
// 2. Mail-node reverification:
//    Creates a 'reverify' provisioning_task so the mail-node picks it up on its
//    next 30-second poll and calls verifyAndReport().  Only one such task is
//    queued at a time per identity; cooldown prevents rapid hammering.

import { execFile as _execFile } from 'node:child_process';
import db from '../db.js';
import { provisionDns, isConfigured as cfConfigured } from './CloudflareService.js';
import { PROVISION_SCRIPT } from '../routes/admin.js';
import { mergePhases, parseNginxOutput } from './ProvisioningPhaseStore.js';

const RETRY_INTERVAL_MS  = 5 * 60 * 1000;  // 5 minutes between retry cycles
const REVERIFY_COOLDOWN  = 5 * 60 * 1000;  // minimum gap between reverify tasks
const CONTROLLER_PUBLIC_IP = process.env.CONTROLLER_PUBLIC_IP || '';

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

function nginxNeedsRetry(phases) {
  const ng = phases.nginx?.phases || {};
  return Object.values(ng).some(v => v?.status === 'PENDING');
}

// ─── Per-identity retry ───────────────────────────────────────────────────────

async function retryIdentity(identity) {
  const phases = parsePhases(identity);
  let updated = false;

  // 1. Cloudflare DNS retry
  if (cfNeedsRetry(phases)) {
    log(`CF DNS retry for ${identity.domain}`);
    try {
      const cfResult = await provisionDns({
        domain:       identity.domain,
        ip:           identity.ip,
        selector:     identity.dkimSelector,
        dkimPublicKey: identity.dkimPublicKey || null,
        controllerIp: CONTROLLER_PUBLIC_IP,
      });
      phases.cloudflare = {
        status: cfResult.ok ? 'OK' : (cfResult.skipped ? 'NOT_RUN' : 'PARTIAL'),
        phases: cfResult.phases,
        ...(cfResult.skipped ? { message: cfResult.message } : {}),
      };
      updated = true;
    } catch (err) {
      warn(`CF DNS retry failed for ${identity.domain}: ${err.message}`);
    }
  }

  // 2. nginx/TLS retry
  if (nginxNeedsRetry(phases)) {
    log(`nginx/TLS retry for ${identity.domain}`);
    await new Promise(resolve => {
      _execFile(
        'sudo', [PROVISION_SCRIPT, identity.domain],
        { timeout: 300_000, maxBuffer: 512 * 1024 },
        (err, stdout) => {
          const nginxPhases = parseNginxOutput(stdout || '');
          phases.nginx = { status: 'DONE', phases: nginxPhases };
          updated = true;
          if (err) warn(`nginx retry for ${identity.domain}: ${err.message}`);
          resolve();
        }
      );
    });
  }

  if (updated) {
    phases.updatedAt = new Date().toISOString();
    mergePhases(identity.id, phases);
  }

  // 4. Schedule mail-node reverification task (only if no active task exists)
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

async function runRetries() {
  const candidates = db.prepare(`
    SELECT id, domain, ip, dkimSelector, serverId, provisioningPhases,
           dkimPublicKey, nextReverifyAt
    FROM sender_identities
    WHERE provisioningStatus = 'DONE' AND verificationStatus != 'READY'
  `).all();

  if (candidates.length === 0) return;
  log(`checking ${candidates.length} DONE-but-not-READY identity(ies)`);

  for (const identity of candidates) {
    try { await retryIdentity(identity); }
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
