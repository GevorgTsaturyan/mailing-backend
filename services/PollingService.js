import * as JobRepository from './JobRepository.js';
import { isSignerHealthy } from './NodeRepository.js';
import { getReadyDomains } from './UnsubscribeHostReadiness.js';

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
  return JobRepository.findNextPending(serverId, { readyDomains });
}
