import * as JobRepository from './JobRepository.js';
import { isSignerHealthy } from './NodeRepository.js';
import { getReadyDomains } from './UnsubscribeHostReadiness.js';
import db from '../db.js';
import { providerAllows } from './WarmupService.js';

// How many ordered candidates to inspect when the head of the queue is blocked
// by the per-provider hourly throttle (e.g. Gmail cap reached → send Outlook next).
const THROTTLE_LOOKAHEAD = 50;

// Returns the next PENDING job OWNED BY the given server, or null if that server
// has no eligible jobs. Read-only look-ahead — state does not change here. The
// caller must follow up with JobService.startJob() (which re-checks ownership and
// claims atomically) before doing any work on the returned job.
export function poll(serverId) {
  // Early-prevention: don't hand jobs to a node whose DKIM signer is reported down
  // (they'd only tempfail locally). Temporary and auto-recovering. The Postfix
  // milter fail-closed remains the final guarantee against unsigned mail.
  if (!isSignerHealthy(serverId)) return null;

  // Unsubscribe-host gate (per-domain): contact-bound jobs are withheld for any
  // domain whose unsubscribe host is not yet verified. getReadyDomains() returns:
  //   null    — gating disabled (UNSUBSCRIBE_REQUIRE_READY=false); all jobs allowed
  //   Set<domain> — only jobs for these domains (or raw jobs) are returned
  // Raw jobs (no contact_id) carry no List-Unsubscribe URL and are never gated.
  const readyDomains = getReadyDomains();
  const candidates = JobRepository.findPendingCandidates(serverId, { readyDomains, limit: THROTTLE_LOOKAHEAD });
  const identityStmt = db.prepare('SELECT id, dailyLimit, warmupStartedAt FROM sender_identities WHERE id = ?');
  const cache = new Map();
  const now = new Date();
  for (const job of candidates) {
    if (!cache.has(job.identity_id)) cache.set(job.identity_id, identityStmt.get(job.identity_id));
    if (providerAllows(job, cache.get(job.identity_id), now)) return job;
  }
  return null;
}
