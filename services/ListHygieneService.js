import db from '../db.js';

// ─── ListHygieneService — bounce / activity rules (deliverability) ────────────
//
// Decides what a bounce means for the RECIPIENT, and tracks engagement for the
// inactivity sunset. Suppression itself is enforced by SuppressionService
// (contacts.suppression_reason IS NOT NULL ⇒ never mailed again).
//
// Bounce classes:
//   hard   — the address does not exist / is disabled → suppress immediately.
//   soft   — recipient-side temporary problem (mailbox full, expired deferral)
//            → count; suppress after SOFT_BOUNCE_LIMIT consecutive soft bounces.
//   sender — the receiver rejected US (spam / blocklist / auth / reputation /
//            rate limit). Says nothing about the address → no recipient penalty.
//            Suppressing here would wipe a good list during a reputation dip.

export const SOFT_BOUNCE_LIMIT = Math.max(1, parseInt(process.env.SOFT_BOUNCE_LIMIT || '3', 10) || 3);

// 0 disables the inactivity sunset.
export function inactiveSunsetDays() {
  const n = parseInt(process.env.INACTIVE_SUNSET_DAYS ?? '180', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const SENDER_SIDE = new Set(['spam_blocked', 'blocklist', 'auth_failure', 'reputation', 'rate_limited', 'signing_unavailable']);

// Pure. event: { dsnCode, reasonCategory, response }
export function classifyBounce(event = {}) {
  const dsn = String(event.dsnCode || '');
  const cat = event.reasonCategory || '';
  if (SENDER_SIDE.has(cat)) return 'sender';
  if (cat === 'invalid_recipient') return 'hard';
  // 5.1.x = bad mailbox/address/domain, 5.2.1 = mailbox disabled
  if (/^5\.1\.\d+$/.test(dsn) || dsn === '5.2.1') return 'hard';
  if (cat === 'mailbox_full' || /^5\.2\.2$/.test(dsn)) return 'soft';
  if (/^4\./.test(dsn)) return 'soft'; // deferral expired → Postfix "bounced" with 4.x.x
  const txt = String(event.response || '').toLowerCase();
  if (/user unknown|no such user|does not exist|mailbox not found|unknown user|address rejected|invalid recipient|recipient not found/.test(txt)) return 'hard';
  if (/^5\./.test(dsn)) return 'soft'; // other permanent errors: be conservative, count them
  return 'soft';
}

const stmts = {
  hard: db.prepare("UPDATE contacts SET suppression_reason = 'hard_bounce' WHERE id = ? AND suppression_reason IS NULL"),
  softInc: db.prepare('UPDATE contacts SET soft_bounce_count = soft_bounce_count + 1 WHERE id = ?'),
  softSuppress: db.prepare(
    "UPDATE contacts SET suppression_reason = 'soft_bounce_limit' WHERE id = ? AND suppression_reason IS NULL AND soft_bounce_count >= ?"
  ),
  delivered: db.prepare('UPDATE contacts SET soft_bounce_count = 0 WHERE id = ? AND soft_bounce_count <> 0'),
  complaint: db.prepare("UPDATE contacts SET suppression_reason = 'complaint' WHERE id = ? AND (suppression_reason IS NULL OR suppression_reason = 'unsubscribe')"),
  activity: db.prepare('UPDATE contacts SET last_activity_at = ? WHERE id = ? AND (last_activity_at IS NULL OR last_activity_at < ?)'),
};

// Applies a bounce to a contact. Must be callable inside an open transaction.
// Returns { kind, suppressed }.
export function applyBounce(contactId, event) {
  const kind = classifyBounce(event);
  if (contactId == null) return { kind, suppressed: false };
  if (kind === 'hard') {
    return { kind, suppressed: stmts.hard.run(contactId).changes > 0 };
  }
  if (kind === 'soft') {
    stmts.softInc.run(contactId);
    return { kind, suppressed: stmts.softSuppress.run(contactId, SOFT_BOUNCE_LIMIT).changes > 0 };
  }
  return { kind, suppressed: false };
}

export function applyDelivered(contactId) {
  if (contactId != null) stmts.delivered.run(contactId);
}

export function applyComplaint(contactId) {
  if (contactId != null) stmts.complaint.run(contactId);
}

// Real engagement (human click / non-prefetch open) keeps a contact active.
export function recordActivity(contactId, at = new Date().toISOString()) {
  if (contactId != null) stmts.activity.run(at, contactId, at);
}

// One-time-safe startup backfill: last_activity_at = latest real engagement,
// otherwise "now" for contacts with no baseline (grace period starts today, so
// the sunset never instantly drops an existing list).
export function backfillActivity() {
  const now = new Date().toISOString();
  db.exec(`
    UPDATE contacts SET last_activity_at = (
      SELECT MAX(t) FROM (
        SELECT MAX(opened_at)  t FROM open_events  WHERE contact_id = contacts.id AND classification = 'open'
        UNION ALL
        SELECT MAX(clicked_at) t FROM click_events WHERE contact_id = contacts.id AND classification <> 'scanner'
      )
    ) WHERE last_activity_at IS NULL
  `);
  db.prepare('UPDATE contacts SET last_activity_at = ? WHERE last_activity_at IS NULL').run(now);
}
