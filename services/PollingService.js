import * as JobRepository from './JobRepository.js';

// Returns the next PENDING job available for a node to claim, or null if the
// queue is empty.  This is a read-only look-ahead — state does not change here.
// The caller must follow up with JobService.startJob() to atomically claim the
// returned job before doing any work on it.
export function poll() {
  return JobRepository.findNextPending();
}
