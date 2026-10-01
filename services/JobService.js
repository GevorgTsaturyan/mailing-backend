import * as JobRepository from './JobRepository.js';
import { isEmailSuppressed, isJobRecipientSuppressed } from './SuppressionService.js';
import { checkAndCompleteCampaign } from './CampaignRepository.js';
import { isSignerHealthy } from './NodeRepository.js';
import { allowDispatch as unsubscribeHostAllowsDispatch } from './UnsubscribeHostReadiness.js';

const MAX_SEND_ATTEMPTS = parseInt(process.env.MAX_SEND_ATTEMPTS || '10');

// ── Validation ────────────────────────────────────────────────────────────────

const VALID_CONTENT_TYPES = new Set(['html', 'text']);

function validate({ recipient, subject, content_type }) {
  if (!recipient?.trim())    throw new Error('recipient is required');
  if (!subject?.trim())      throw new Error('subject is required');
  if (content_type != null && !VALID_CONTENT_TYPES.has(content_type))
    throw new Error(`content_type must be 'html' or 'text'`);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function createJob({ identity_id, recipient, subject, body, priority, content_type }) {
  validate({ recipient, subject, content_type });
  // Ownership + provisioning gate — a job MUST resolve to a real, active, and
  // provisioning-verified (READY) sending identity. Refuse to create a job for a
  // missing/unknown/paused OR unverified identity rather than let it fall through
  // to the wrong IP/HELO or unsigned DKIM at send time.
  if (identity_id == null || !JobRepository.identitySendable(identity_id)) {
    throw new Error('identity_id must reference an active, provisioning-verified (READY) sending identity — job not created');
  }
  // Suppression gate — a raw job for an unsubscribed recipient must not be created.
  if (isEmailSuppressed(recipient.trim())) {
    throw new Error('recipient is suppressed (unsubscribed) — job not created');
  }
  return JobRepository.create({
    identity_id:  identity_id ?? null,
    recipient:    recipient.trim(),
    subject:      subject.trim(),
    body:         body ?? '',
    priority:     Number(priority ?? 0),
    content_type: content_type ?? 'html',
  });
}

// Atomically claims a PENDING job for the given node.
//
// Two-step design: the node first receives the job ID from GET /api/jobs/poll
// (read-only), then calls startJob to claim it.  If another node wins the race,
// claimJob() returns false and we surface a 409 so the caller can re-poll.
//
// The WHERE status='PENDING' guard in the UPDATE is the lock — SQLite serialises
// concurrent writes so only one node's UPDATE will find changes=1.
export function startJob(id, serverId) {
  const nodeId = String(serverId);
  const job = JobRepository.findById(id);
  if (!job) {
    return { error: 'Job not found', status: 404 };
  }
  if (job.status !== 'PENDING') {
    return {
      error: `Job ${id} has status ${job.status} — only PENDING jobs can be started`,
      status: 409,
    };
  }

  // ── Ownership gate (multi-node boundary) ──────────────────────────────────────
  // A node may only claim jobs whose sending identity it owns (and that identity
  // must be active). This is the security boundary: even if a node requests an
  // arbitrary job id, it cannot claim one it does not own. Enforced here AND again
  // inside the atomic claimJob() UPDATE (defense-in-depth).
  if (!JobRepository.identityOwnedByServer(job.identity_id, serverId)) {
    return { error: 'job is not owned by this node', status: 403 };
  }

  // Signer-health gate — refuse to claim if this node's DKIM signer is reported
  // down (the send would only tempfail). 409 → node re-polls once healthy again.
  if (!isSignerHealthy(serverId)) {
    return { error: 'DKIM signer (OpenDKIM) is unavailable on this node', status: 409 };
  }

  // Unsubscribe-host gate (per-domain) — a contact-bound job advertises the
  // List-Unsubscribe URL for the sending identity's domain; refuse to claim it
  // while that domain's unsubscribe host is unverified (mail must never ship a
  // dead unsubscribe endpoint). 409 → job stays PENDING and is re-polled once the
  // host verifies. Raw jobs (no contact) carry no List-Unsubscribe and are not gated.
  if (job.contact_id != null) {
    const domain = JobRepository.getIdentityDomain(job.identity_id);
    if (!unsubscribeHostAllowsDispatch(domain)) {
      return { error: 'unsubscribe host is not ready — campaign dispatch withheld', status: 409 };
    }
  }

  // ── Claim-time suppression gate (the authoritative last DB gate before send) ──
  // The recipient may have unsubscribed AFTER the job was created. If so, cancel
  // the job instead of claiming it, so the node never receives (and never sends)
  // it. A 409 makes the node treat this like a lost claim and simply re-poll.
  if (isJobRecipientSuppressed(job)) {
    JobRepository.cancelSuppressed(id, 'unsubscribed');
    if (job.campaign_id) checkAndCompleteCampaign(job.campaign_id);
    return { error: 'recipient is suppressed — job cancelled', status: 409, suppressed: true };
  }

  const claimed = JobRepository.claimJob(id, nodeId, serverId);
  if (!claimed) {
    // Between the SELECT above and this UPDATE, another node claimed the job (or
    // its ownership/active state changed). Either way, this node must re-poll.
    return { error: 'Job was already claimed by another node', status: 409 };
  }

  return { ok: true, job: JobRepository.findById(id) };
}

// Marks a PROCESSING job as SENT.  Only the owning node may complete its own job.
// queueId is the Postfix queue ID — stored for future delivery event correlation.
export function completeJob(id, nodeId, queueId = null) {
  const job = JobRepository.findById(id);
  if (!job) return { error: 'Job not found', status: 404 };

  if (job.node_id !== nodeId) {
    return { error: 'Job belongs to a different node', status: 403 };
  }
  if (job.status !== 'PROCESSING') {
    return { error: `Cannot complete job with status ${job.status}`, status: 409 };
  }

  const updated = JobRepository.markSent(id, nodeId, queueId);
  return updated ? { ok: true } : { error: 'Concurrent state change — please retry', status: 409 };
}

// Requeues a PROCESSING job for a LATER retry instead of failing it. Used for
// TEMPORARY submission failures (e.g. OpenDKIM milter tempfail / 4xx / connection),
// so an infrastructure/signing outage never marks the job or its contact permanently
// failed. Applies a linear backoff and caps total attempts; on exceeding the cap the
// job is FAILED (operationally) but the CONTACT is left untouched (not a bad recipient).
export function retryJob(id, serverId, { maxAttempts = MAX_SEND_ATTEMPTS } = {}) {
  const nodeId = String(serverId);
  const job = JobRepository.findById(id);
  if (!job) return { error: 'Job not found', status: 404 };
  if (job.node_id !== nodeId) return { error: 'Job belongs to a different node', status: 403 };
  if (job.status !== 'PROCESSING') return { error: `Cannot retry job with status ${job.status}`, status: 409 };

  if (job.attempts >= maxAttempts) {
    // Give up after repeated infra failures. Mark the job FAILED but do NOT mark
    // the contact failed — this is a signing/infrastructure outage, not a bad address.
    JobRepository.markFailed(id, nodeId, `signing unavailable after ${job.attempts} attempts`);
    return { ok: true, gaveUp: true, status: 'FAILED' };
  }

  const delaySeconds = Math.min(job.attempts * 60, 900); // linear backoff, cap 15 min
  const requeued = JobRepository.requeueForRetry(id, nodeId, delaySeconds);
  return requeued
    ? { ok: true, requeued: true, status: 'PENDING', retryInSeconds: delaySeconds }
    : { error: 'Concurrent state change — please retry', status: 409 };
}

// Marks a PROCESSING job as FAILED.  Only the owning node may fail its own job.
export function failJob(id, nodeId, errorMessage) {
  const job = JobRepository.findById(id);
  if (!job) return { error: 'Job not found', status: 404 };

  if (job.node_id !== nodeId) {
    return { error: 'Job belongs to a different node', status: 403 };
  }
  if (job.status !== 'PROCESSING') {
    return { error: `Cannot fail job with status ${job.status}`, status: 409 };
  }

  const updated = JobRepository.markFailed(id, nodeId, errorMessage);
  return updated ? { ok: true } : { error: 'Concurrent state change — please retry', status: 409 };
}
