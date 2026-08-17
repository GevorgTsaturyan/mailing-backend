import * as JobRepository from './JobRepository.js';
import { isSignerHealthy } from './NodeRepository.js';

// Returns the next PENDING job OWNED BY the given server, or null if that server
// has no eligible jobs. Read-only look-ahead — state does not change here. The
// caller must follow up with JobService.startJob() (which re-checks ownership and
// claims atomically) before doing any work on the returned job.
export function poll(serverId) {
  // Early-prevention: don't hand jobs to a node whose DKIM signer is reported down
  // (they'd only tempfail locally). Temporary and auto-recovering. The Postfix
  // milter fail-closed remains the final guarantee against unsigned mail.
  if (!isSignerHealthy(serverId)) return null;
  return JobRepository.findNextPending(serverId);
}
