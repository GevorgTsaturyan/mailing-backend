import db from '../db.js';

// ─── FailedMailRepository — contacts whose latest delivery failed ─────────────
//
// One row per contact (contact_id is the PK). `record` upserts: the first failure
// inserts a row; subsequent failures bump fail_count and refresh reason/source/
// failed_at. `clear` removes the row when the contact later succeeds or is reset.
// `list` joins the live contact so the UI always shows current name/status, and
// skips rows whose contact was deleted (defensive — the FK also cascades).

export function record(contactId, { email = '', reason = null, source = 'send' } = {}) {
  if (contactId == null) return;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO failed_mails (contact_id, email, reason, source, fail_count, first_failed_at, failed_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(contact_id) DO UPDATE SET
      email      = excluded.email,
      reason     = excluded.reason,
      source     = excluded.source,
      fail_count = failed_mails.fail_count + 1,
      failed_at  = excluded.failed_at
  `).run(contactId, email ?? '', reason ?? null, source, now, now);
}

export function clear(contactId) {
  if (contactId == null) return 0;
  return db.prepare('DELETE FROM failed_mails WHERE contact_id = ?').run(contactId).changes;
}

// Every failed mail joined to its live contact, newest failure first.
export function list() {
  return db.prepare(`
    SELECT f.contact_id            AS id,
           c.firstName, c.lastName,
           COALESCE(c.email, f.email) AS email,
           c.status,
           c.sentAt,
           f.reason, f.source, f.fail_count AS failCount,
           f.first_failed_at AS firstFailedAt,
           f.failed_at       AS failedAt
    FROM failed_mails f
    JOIN contacts c ON c.id = f.contact_id
    ORDER BY f.failed_at DESC
  `).all();
}

export function count() {
  return db.prepare('SELECT COUNT(*) AS n FROM failed_mails').get().n;
}
