import * as JobRepository from './JobRepository.js';
import { isSignerHealthy } from './NodeRepository.js';
import { allowDispatch as unsubscribeHostAllowsDispatch } from './UnsubscribeHostReadiness.js';

// Returns the next PENDING job OWNED BY the given server, or null if that server
// has no eligible jobs. Read-only look-ahead — state does not change here. The
// caller must follow up with JobService.startJob() (which re-checks ownership and
// claims atomically) before doing any work on the returned job.
export function poll(serverId) {
  // Early-prevention: don't hand jobs to a node whose DKIM signer is reported down
  // (they'd only tempfail locally). Temporary and auto-recovering. The Postfix
  // milter fail-closed remains the final guarantee against unsigned mail.
  if (!isSignerHealthy(serverId)) return null;
  // Unsubscribe-host gate: campaign (contact-bound) jobs advertise the
  // List-Unsubscribe URL — withhold them while that host is unverified, so mail
  // never ships a dead unsubscribe endpoint. Raw jobs (no contact, no
  // List-Unsubscribe) remain dispatchable. Jobs stay PENDING; dispatch resumes
  // automatically once the host verifies.
  const campaignJobs = unsubscribeHostAllowsDispatch();
  return JobRepository.findNextPending(serverId, { campaignJobs });
}
