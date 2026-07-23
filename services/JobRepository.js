import db from '../db.js';

export function create({ identity_id, recipient, subject, body, priority }) {
  const now = new Date().toISOString();
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO jobs (status, node_id, identity_id, recipient, subject, body, priority, attempts, created_at)
    VALUES ('PENDING', NULL, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    identity_id ?? null,
    recipient,
    subject,
    body ?? '',
    priority ?? 0,
    now,
  );
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(lastInsertRowid);
}

export function findById(id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) ?? null;
}

// Returns the single highest-priority PENDING job (for poll endpoint).
// LEFT JOINs sender_identities so the node receives fromAddr/fromName without
// a separate round-trip — mirrors the pattern used by GET /api/nodes/jobs.
// Respects scheduled_for: jobs with a future scheduled_for are withheld until
// their time comes (NULL scheduled_for = immediately dispatchable).
export function findNextPending() {
  const now = new Date().toISOString();
  return db.prepare(`
    SELECT j.*, si.fromAddr, si.fromName, si.domain
    FROM   jobs j
    LEFT   JOIN sender_identities si ON si.id = j.identity_id
    WHERE  j.status = 'PENDING'
      AND  (j.scheduled_for IS NULL OR j.scheduled_for <= ?)
    ORDER  BY j.priority DESC, j.created_at ASC
    LIMIT  1
  `).get(now) ?? null;
}

// Atomic claim: transitions PENDING → PROCESSING for the given node.
// Returns true if the row was updated, false if another node got there first.
export function claimJob(id, nodeId) {
  const now = new Date().toISOString();
  const { changes } = db.prepare(`
    UPDATE jobs
    SET    status = 'PROCESSING', node_id = ?, started_at = ?, attempts = attempts + 1
    WHERE  id = ? AND status = 'PENDING'
  `).run(nodeId, now, id);
  return changes === 1;
}

// Transitions PROCESSING → SENT. Enforces node ownership.
// queueId is the Postfix queue ID returned by Nodemailer; stored for future delivery tracking.
export function markSent(id, nodeId, queueId = null) {
  const now = new Date().toISOString();
  const { changes } = db.prepare(`
    UPDATE jobs
    SET    status = 'SENT', finished_at = ?, queue_id = ?
    WHERE  id = ? AND status = 'PROCESSING' AND node_id = ?
  `).run(now, queueId, id, nodeId);
  return changes === 1;
}

// Transitions PROCESSING → FAILED. Enforces node ownership.
export function markFailed(id, nodeId, errorMessage) {
  const now = new Date().toISOString();
  const { changes } = db.prepare(`
    UPDATE jobs
    SET    status = 'FAILED', finished_at = ?, error_message = ?
    WHERE  id = ? AND status = 'PROCESSING' AND node_id = ?
  `).run(now, errorMessage ?? null, id, nodeId);
  return changes === 1;
}

// Cancels a PENDING or PROCESSING job. Returns true if cancelled.
export function markCancelled(id) {
  const { changes } = db.prepare(`
    UPDATE jobs SET status = 'CANCELLED'
    WHERE  id = ? AND status IN ('PENDING', 'PROCESSING')
  `).run(id);
  return changes === 1;
}
