import db from '../db.js';

// ─── TrackingConfigRepository ─────────────────────────────────────────────────
// Open-tracking enablement. Global default is OFF (approved decision Z-1). A
// per-campaign override may force it on or off; NULL inherits the global setting.
//
//   effective(campaign) = campaign.open_tracking_override ?? global
//
// When the result is false, NO pixel is injected and NO open request is ever
// generated — the compiled body is byte-identical to the no-tracking body.

export function getGlobalOpenTracking() {
  const row = db.prepare('SELECT open_tracking_enabled FROM tracking_config WHERE id = 1').get();
  return !!(row && row.open_tracking_enabled);
}

export function setGlobalOpenTracking(enabled) {
  db.prepare('UPDATE tracking_config SET open_tracking_enabled = ? WHERE id = 1')
    .run(enabled ? 1 : 0);
  return getGlobalOpenTracking();
}

// isOpenTrackingEnabled(campaignRow) — campaignRow must include open_tracking_override.
export function isOpenTrackingEnabled(campaign) {
  const override = campaign?.open_tracking_override;
  if (override === 0 || override === 1) return override === 1;
  return getGlobalOpenTracking();
}
