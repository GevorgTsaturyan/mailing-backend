import * as JobRepository from './JobRepository.js';

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
export function startJob(id, nodeId) {
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

  const claimed = JobRepository.claimJob(id, nodeId);
  if (!claimed) {
    // Between the SELECT above and this UPDATE, another node claimed the job.
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
