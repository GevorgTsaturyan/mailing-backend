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
// Ordered by priority DESC then created_at ASC so oldest high-priority jobs go first.
export function findNextPending() {
  return db.prepare(`
    SELECT * FROM jobs
    WHERE  status = 'PENDING'
    ORDER  BY priority DESC, created_at ASC
    LIMIT  1
  `).get() ?? null;
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
export function markSent(id, nodeId) {
  const now = new Date().toISOString();
  const { changes } = db.prepare(`
    UPDATE jobs
    SET    status = 'SENT', finished_at = ?
    WHERE  id = ? AND status = 'PROCESSING' AND node_id = ?
  `).run(now, id, nodeId);
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
