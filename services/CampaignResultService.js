import db from '../db.js';
import * as JobRepository from './JobRepository.js';
import { incrementSent, incrementSendFailed } from './CampaignStatsRepository.js';

// ─── Campaign completion handlers for the canonical jobs queue ────────────────
//
// These functions are called after a canonical job transitions to SENT or FAILED.
// They mirror the side-effects that POST /api/nodes/results produces for the legacy
// send_jobs pipeline: update send_log, update the contact's status, and keep
// dailySentCount accurate so creation-time capacity checks stay correct.
//
// Each function is a no-op when the job has no campaign fields (contact_id /
// send_log_id are NULL), so it is safe to call for any jobs-table row.

export function onJobCompleted(jobId, queueId) {
  const job = JobRepository.findById(jobId);
  if (!job) return;

  const now = new Date().toISOString();

  if (job.send_log_id) {
    db.prepare("UPDATE send_log SET status='sent', queueId=? WHERE id=?")
      .run(queueId ?? null, job.send_log_id);
  }

  if (job.contact_id) {
    db.prepare("UPDATE contacts SET status='sent', sentAt=? WHERE id=?")
      .run(now, job.contact_id);
  }

  if (job.identity_id) {
    db.prepare('UPDATE sender_identities SET dailySentCount = dailySentCount + 1 WHERE id=?')
      .run(job.identity_id);
  }

  // Delivery tracking: mark Postfix accepted the message and update campaign stats
  db.transaction(() => {
    db.prepare("UPDATE jobs SET delivery_status = 'SMTP_ACCEPTED' WHERE id=?").run(jobId);
    if (job.campaign_id) incrementSent(job.campaign_id);
  })();
}

export function onJobFailed(jobId, errorMessage) {
  const job = JobRepository.findById(jobId);
  if (!job) return;

  if (job.send_log_id) {
    db.prepare("UPDATE send_log SET status='failed', error=? WHERE id=?")
      .run(errorMessage ?? 'Send failed', job.send_log_id);
  }

  if (job.contact_id) {
    db.prepare("UPDATE contacts SET status='failed' WHERE id=?")
      .run(job.contact_id);
  }

  // Delivery tracking: mark Postfix rejected the submission and update campaign stats
  db.transaction(() => {
    db.prepare("UPDATE jobs SET delivery_status = 'SEND_FAILED' WHERE id=?").run(jobId);
    if (job.campaign_id) incrementSendFailed(job.campaign_id);
  })();
}
