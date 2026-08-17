import db from '../db.js';

export function create({ identity_id, recipient, subject, body, priority, content_type }) {
  const now = new Date().toISOString();
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO jobs (status, node_id, identity_id, recipient, subject, body, content_type, priority, attempts, created_at)
    VALUES ('PENDING', NULL, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    identity_id ?? null,
    recipient,
    subject,
    body ?? '',
    content_type ?? 'html',
    priority ?? 0,
    now,
  );
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(lastInsertRowid);
}

export function findById(id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) ?? null;
}

// Returns the single highest-priority PENDING job OWNED BY the polling server.
//
// Ownership boundary (multi-node safety): a job belongs to a mail node iff its
// sending identity's serverId matches the polling server. The INNER JOIN with the
// serverId + status='active' predicate is the enforcement — a job whose identity
// belongs to another node, is disabled, or does not exist is never returned here.
//
// JOINs sender_identities so the node receives the authoritative sender config
// (fromAddr/fromName/domain/dkimSelector/ip) without a second round-trip, and
// LEFT JOINs contacts for firstName/lastName template variables.
// Respects scheduled_for (future → withheld; NULL → immediately dispatchable).
export function findNextPending(serverId) {
  const now = new Date().toISOString();
  return db.prepare(`
    SELECT j.*, si.fromAddr, si.fromName, si.domain, si.dkimSelector, si.ip,
           c.firstName, c.lastName
    FROM   jobs j
    JOIN   sender_identities si
             ON si.id = j.identity_id AND si.serverId = ?
            AND si.status = 'active' AND si.verificationStatus = 'READY'
    LEFT   JOIN contacts c ON c.id = j.contact_id
    WHERE  j.status = 'PENDING'
      AND  (j.scheduled_for IS NULL OR j.scheduled_for <= ?)
    ORDER  BY j.priority DESC, j.created_at ASC
    LIMIT  1
  `).get(serverId, now) ?? null;
}

// True iff the identity exists, is active, provisioning-verified (READY), and is
// owned by serverId. Used for defense-in-depth ownership validation in startJob:
// a node may only claim jobs for identities it owns AND has proven it can send.
export function identityOwnedByServer(identityId, serverId) {
  if (identityId == null) return false;
  return !!db.prepare(
    "SELECT 1 FROM sender_identities WHERE id = ? AND serverId = ? AND status = 'active' AND verificationStatus = 'READY'"
  ).get(identityId, serverId);
}

// True iff the identity exists and is active (owner-agnostic).
export function identityIsActive(identityId) {
  if (identityId == null) return false;
  return !!db.prepare(
    "SELECT 1 FROM sender_identities WHERE id = ? AND status = 'active'"
  ).get(identityId);
}

// True iff the identity is SENDABLE for production: active AND provisioning-verified
// (READY). This is the single authoritative readiness predicate used at job
// creation. Dispatch paths enforce the same `verificationStatus='READY'` inline.
export function identitySendable(identityId) {
  if (identityId == null) return false;
  return !!db.prepare(
    "SELECT 1 FROM sender_identities WHERE id = ? AND status = 'active' AND verificationStatus = 'READY'"
  ).get(identityId);
}

// Atomic claim: transitions PENDING → PROCESSING for the given node, but ONLY if
// the job's sending identity is owned by (and active on) that server. Ownership is
// part of the same atomic UPDATE, so it cannot race with a concurrent poll/claim
// or an identity-ownership change. Returns true iff this call won the claim.
export function claimJob(id, nodeId, serverId) {
  const now = new Date().toISOString();
  const { changes } = db.prepare(`
    UPDATE jobs
    SET    status = 'PROCESSING', node_id = ?, started_at = ?, attempts = attempts + 1
    WHERE  id = ? AND status = 'PENDING'
      AND  identity_id IN (SELECT id FROM sender_identities WHERE serverId = ? AND status = 'active' AND verificationStatus = 'READY')
  `).run(nodeId, now, id, serverId);
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

// Returns a PROCESSING job to PENDING for a later retry (temporary failure path).
// Clears node ownership and applies a scheduled_for delay so it isn't re-claimed
// immediately. attempts is preserved (it keeps climbing on each claim, enforcing
// the retry cap). Returns true if this node's PROCESSING job was requeued.
export function requeueForRetry(id, nodeId, delaySeconds = 0) {
  const scheduledFor = new Date(Date.now() + delaySeconds * 1000).toISOString();
  const { changes } = db.prepare(`
    UPDATE jobs
    SET    status = 'PENDING', node_id = NULL, started_at = NULL, scheduled_for = ?
    WHERE  id = ? AND status = 'PROCESSING' AND node_id = ?
  `).run(scheduledFor, id, nodeId);
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

// Cancels a still-PENDING job because its recipient is suppressed, recording the
// reason. Guarded on status='PENDING' so it never overrides an in-flight claim.
// Returns true if cancelled.
export function cancelSuppressed(id, reason = 'recipient unsubscribed') {
  const now = new Date().toISOString();
  const { changes } = db.prepare(`
    UPDATE jobs
    SET    status = 'CANCELLED', finished_at = ?, error_message = ?
    WHERE  id = ? AND status = 'PENDING'
  `).run(now, `suppressed: ${reason}`, id);
  return changes === 1;
}
