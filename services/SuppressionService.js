import db from '../db.js';
import { checkAndCompleteCampaign } from './CampaignRepository.js';

// ─── SuppressionService — single source of truth for "may we send to X?" ──────
//
// Defense-in-depth suppression enforcement. Every send path (manual, scheduled,
// recurring, legacy, canonical, job creation, job claim) routes eligibility
// decisions through this module so the rule cannot drift between routes.
//
// ── What counts as suppressed (current data model) ────────────────────────────
// The only authoritative, compliance-grade "never send again" signal in the
// existing contacts model is status = 'unsubscribed'. Complaints are already
// mapped to 'unsubscribed' by DeliveryEventService, so they are covered here too.
//
// 'failed' is intentionally NOT treated as suppression. The current schema uses
// 'failed' for BOTH hard bounces (permanent) and transient send failures (which
// should be retryable). Treating every 'failed' as permanent suppression would
// re-introduce the exact bug the audit flagged (transient failure → permanent
// removal). Cleanly distinguishing hard vs soft bounce requires the future
// suppression_list redesign — see the task's "Remaining limitations".
//
// The daily/recurring batch selects contacts WHERE status='pending', which already
// excludes 'unsubscribed'/'failed'/'sent'/'queued'; the guards here are the
// centralized, always-on safety net that also covers the paths that do NOT use
// that batch query (manual + scheduled sends, and any job queued before the
// recipient unsubscribed).

const SUPPRESSED_STATUSES = new Set(['unsubscribed']);

// ── Point checks ──────────────────────────────────────────────────────────────

export function isContactSuppressed(contactId) {
  if (contactId == null) return false;
  const row = db.prepare('SELECT status FROM contacts WHERE id = ?').get(contactId);
  return !!row && SUPPRESSED_STATUSES.has(row.status);
}

export function isEmailSuppressed(email) {
  if (!email) return false;
  const row = db.prepare('SELECT status FROM contacts WHERE email = ?').get(String(email).toLowerCase());
  return !!row && SUPPRESSED_STATUSES.has(row.status);
}

// Works for job-shaped rows from either pipeline:
//   canonical jobs → contact_id / recipient
//   legacy send_jobs → contactId / email
// Prefers the contact_id (authoritative), falls back to the recipient address.
export function isJobRecipientSuppressed(job) {
  const contactId = job.contact_id ?? job.contactId ?? null;
  if (contactId != null) return isContactSuppressed(contactId);
  return isEmailSuppressed(job.recipient ?? job.email ?? null);
}

// ── Bulk check (avoids N+1 when planning a batch) ─────────────────────────────
// Returns a Set of the suppressed contact ids from the given list — one query.
export function suppressedContactIdSet(contactIds) {
  const ids = [...new Set(contactIds.filter((id) => id != null))];
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id FROM contacts WHERE id IN (${placeholders}) AND status = 'unsubscribed'`
  ).all(...ids);
  return new Set(rows.map((r) => r.id));
}

// ── Proactive cancellation ────────────────────────────────────────────────────
// Called the moment a contact becomes suppressed (unsubscribe / complaint) so a
// job queued BEFORE the suppression can never be claimed and sent.
//
// Only touches PRE-CLAIM states (canonical PENDING, legacy queued). Jobs already
// PROCESSING/claimed are in-flight at a node; the claim-time gate already prevented
// suppressed jobs from reaching PROCESSING, and we do not race an in-flight SMTP
// submission by mutating its row underneath the node (see task §6).
//
// Idempotent. Must NOT be called from inside another db.transaction() (it opens
// its own) — callers already in a transaction should invoke it after commit.
export function cancelOutstandingJobsForContact(contactId, reason = 'recipient unsubscribed') {
  if (contactId == null) return { canonical: 0, legacy: 0, campaignIds: [] };
  const now = new Date().toISOString();

  const result = db.transaction(() => {
    // Capture campaigns whose PENDING jobs we're about to cancel, so we can
    // re-check completion afterwards (a cancelled job is terminal for completion).
    const campaignIds = db.prepare(
      "SELECT DISTINCT campaign_id FROM jobs WHERE contact_id = ? AND status = 'PENDING' AND campaign_id IS NOT NULL"
    ).all(contactId).map((r) => r.campaign_id);

    const canonical = db.prepare(`
      UPDATE jobs
      SET status = 'CANCELLED', finished_at = ?, error_message = ?
      WHERE contact_id = ? AND status = 'PENDING'
    `).run(now, `suppressed: ${reason}`, contactId).changes;

    const legacy = db.prepare(`
      UPDATE send_jobs
      SET status = 'cancelled', reasonCategory = 'suppressed', reasonDetail = ?
      WHERE contactId = ? AND status = 'queued'
    `).run(reason, contactId).changes;

    return { canonical, legacy, campaignIds };
  })();

  // Outside the transaction: a cancelled job may have been the last outstanding
  // job of its campaign — let the campaign complete instead of hanging "running".
  for (const cid of result.campaignIds) checkAndCompleteCampaign(cid);
  return result;
}
