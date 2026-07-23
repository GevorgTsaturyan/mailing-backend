import db from '../db.js';

// ─── CampaignRepository ───────────────────────────────────────────────────────
// DB layer for the campaigns table.
//
// One campaigns row represents a single dispatch run (e.g. one firing of a
// scheduled send, one day's run of a recurring campaign, or all manual sends
// grouped within a calendar day + identity pair).
//
// Typed nullable FKs (scheduled_send_id, recurring_campaign_id) replace the
// earlier polymorphic ref_id approach.  At most one FK is non-NULL per row.

// create({ type, date, identity_id?, label?, scheduled_send_id?, recurring_campaign_id? })
// → inserted campaigns row
export function create({ type, date, identity_id = null, label = null, scheduled_send_id = null, recurring_campaign_id = null }) {
  const now = new Date().toISOString();
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO campaigns
      (type, scheduled_send_id, recurring_campaign_id, identity_id, label, status, date, created_at)
    VALUES (?, ?, ?, ?, ?, 'running', ?, ?)
  `).run(type, scheduled_send_id, recurring_campaign_id, identity_id, label, date, now);
  return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(lastInsertRowid);
}

// findOrCreateManual(date, identityId)
// All manual sends on the same calendar day and sender identity share one
// campaigns row.  This keeps the campaigns table clean at high manual-send volume.
export function findOrCreateManual(date, identityId = null) {
  const existing = db.prepare(
    "SELECT * FROM campaigns WHERE type='manual' AND date=? AND identity_id IS ? LIMIT 1"
  ).get(date, identityId);
  if (existing) return existing;
  return create({ type: 'manual', date, identity_id: identityId, label: `Manual – ${date}` });
}

export function findById(id) {
  return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) ?? null;
}

// WHERE status='running' guard makes this idempotent: a second call is a safe no-op.
export function markCompleted(id) {
  db.prepare("UPDATE campaigns SET status='completed', completed_at=? WHERE id=? AND status='running'")
    .run(new Date().toISOString(), id);
}

// checkAndCompleteCampaign(campaignId)
// Called after any terminal delivery_status is written to a job.
// Reads the actual jobs table (not derived counters) to avoid completing prematurely.
// Terminal states: DELIVERED, BOUNCED, SEND_FAILED, COMPLAINED.
// Non-terminal: SMTP_PENDING, SMTP_ACCEPTED, DEFERRED.
// No-op if the campaign is already completed or has no jobs.
export function checkAndCompleteCampaign(campaignId) {
  const campaign = db.prepare("SELECT status FROM campaigns WHERE id = ?").get(campaignId);
  if (!campaign || campaign.status !== 'running') return;

  const { total, terminal_count } = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN delivery_status IN ('DELIVERED','BOUNCED','SEND_FAILED','COMPLAINED')
               THEN 1 ELSE 0 END) AS terminal_count
    FROM jobs WHERE campaign_id = ?
  `).get(campaignId);

  if (total > 0 && total === terminal_count) {
    markCompleted(campaignId);
  }
}
