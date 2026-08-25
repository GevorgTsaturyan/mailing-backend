import db from '../db.js';

// ─── EventRetention ───────────────────────────────────────────────────────────
// Bounds growth (and privacy exposure) of the raw tracking-event tables. These
// rows hold ip_hash + User-Agent + per-event metadata, so we don't keep them
// forever. Mirrors the 90-day delivery_events retention convention: the permanent
// historical record lives in campaign_stats counters, not the raw event rows.
//
// Aggregate report figures (campaign_stats) are unaffected. Recipient-level
// first/last open/click detail is derived from the raw rows, so it is only
// available within the retention window — an intentional privacy trade-off.

export function retentionDays() {
  const n = Number(process.env.TRACKING_EVENT_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 90;
}

// Deletes click_events / open_events older than `days`. Returns rows removed.
// Idempotent and safe to run repeatedly (e.g. daily cron).
export function purgeOldEvents(days = retentionDays()) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const clicks = db.prepare('DELETE FROM click_events WHERE clicked_at < ?').run(cutoff);
  const opens  = db.prepare('DELETE FROM open_events  WHERE opened_at  < ?').run(cutoff);
  return { cutoff, clicksDeleted: clicks.changes, opensDeleted: opens.changes };
}
