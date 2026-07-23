import db from '../db.js';

// ─── CampaignStatsRepository ──────────────────────────────────────────────────
// DB layer for the campaign_stats table.
//
// IMPORTANT: findOrCreate and applyDeliveryEvent are designed to be called
// inside the caller's db.transaction() callback.  They use raw db.prepare()
// calls without their own transaction wrapper so they participate atomically
// in the enclosing transaction.
//
// incrementJobs may be called inside or outside a transaction; it is used when
// the scheduler creates jobs for a campaign.

// findOrCreate(campaignId) — call inside caller's transaction
// Returns the existing stats row, or inserts and returns a fresh zeroed row.
export function findOrCreate(campaignId) {
  const existing = db.prepare('SELECT * FROM campaign_stats WHERE campaign_id = ?').get(campaignId);
  if (existing) return existing;
  const now = new Date().toISOString();
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO campaign_stats (campaign_id, created_at) VALUES (?, ?)'
  ).run(campaignId, now);
  return db.prepare('SELECT * FROM campaign_stats WHERE id = ?').get(lastInsertRowid);
}

// incrementJobs(campaignId, count) — call after creating jobs for a campaign
export function incrementJobs(campaignId, count = 1) {
  db.prepare(`
    UPDATE campaign_stats
    SET total_jobs = total_jobs + ?, last_updated = ?
    WHERE campaign_id = ?
  `).run(count, new Date().toISOString(), campaignId);
}

// incrementSent(campaignId) — call inside caller's transaction (from CampaignResultService)
export function incrementSent(campaignId) {
  db.prepare(`
    UPDATE campaign_stats
    SET total_sent = total_sent + 1, last_updated = ?
    WHERE campaign_id = ?
  `).run(new Date().toISOString(), campaignId);
}

// incrementSendFailed(campaignId) — call inside caller's transaction (from CampaignResultService)
export function incrementSendFailed(campaignId) {
  db.prepare(`
    UPDATE campaign_stats
    SET total_send_failed = total_send_failed + 1, last_updated = ?
    WHERE campaign_id = ?
  `).run(new Date().toISOString(), campaignId);
}

// applyDeliveryEvent(campaignId, priorStatus, newStatus) — call inside caller's transaction
//
// Updates the appropriate counters based on the FSM transition.
// priorStatus is jobs.delivery_status BEFORE this event was applied.
// newStatus   is the delivery_status being applied now.
//
// total_currently_deferred tracks jobs currently stuck in retry:
//   incremented on first deferral (SMTP_ACCEPTED → DEFERRED),
//   decremented when a deferred job is eventually delivered or bounced.
export function applyDeliveryEvent(campaignId, priorStatus, newStatus) {
  const now = new Date().toISOString();

  switch (newStatus) {
    case 'DELIVERED':
      if (priorStatus === 'DEFERRED') {
        db.prepare(`
          UPDATE campaign_stats
          SET total_currently_deferred = total_currently_deferred - 1,
              total_delivered = total_delivered + 1,
              last_updated = ?
          WHERE campaign_id = ?
        `).run(now, campaignId);
      } else {
        db.prepare(`
          UPDATE campaign_stats
          SET total_delivered = total_delivered + 1, last_updated = ?
          WHERE campaign_id = ?
        `).run(now, campaignId);
      }
      break;

    case 'BOUNCED':
      if (priorStatus === 'DEFERRED') {
        db.prepare(`
          UPDATE campaign_stats
          SET total_currently_deferred = total_currently_deferred - 1,
              total_bounced = total_bounced + 1,
              last_updated = ?
          WHERE campaign_id = ?
        `).run(now, campaignId);
      } else {
        db.prepare(`
          UPDATE campaign_stats
          SET total_bounced = total_bounced + 1, last_updated = ?
          WHERE campaign_id = ?
        `).run(now, campaignId);
      }
      break;

    case 'DEFERRED':
      // Only count on first entry into deferred state; repeated retries don't increment again
      if (priorStatus !== 'DEFERRED') {
        db.prepare(`
          UPDATE campaign_stats
          SET total_currently_deferred = total_currently_deferred + 1, last_updated = ?
          WHERE campaign_id = ?
        `).run(now, campaignId);
      }
      break;

    case 'COMPLAINED':
      db.prepare(`
        UPDATE campaign_stats
        SET total_complained = total_complained + 1, last_updated = ?
        WHERE campaign_id = ?
      `).run(now, campaignId);
      break;
  }
}
