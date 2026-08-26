import express from 'express';
import db from '../db.js';
import { register } from '../services/NodeRegistrationService.js';
import { recordHeartbeat } from '../services/HeartbeatService.js';
import { processEvents } from '../services/DeliveryEventService.js';
import { buildUnsubscribeUrl } from '../services/unsubscribeToken.js';
import { suppressedContactIdSet } from '../services/SuppressionService.js';
import { applyReports } from '../services/ProvisioningService.js';
import { isSignerHealthy } from '../services/NodeRepository.js';
import { allowDispatch as unsubscribeHostAllowsDispatch } from '../services/UnsubscribeHostReadiness.js';

const router = express.Router();

// ─── Helpers used by jobs / results / delivery-events ─────────────────────────

function getServer(apiKey) {
  return db.prepare('SELECT * FROM servers WHERE apiKey = ?').get(apiKey);
}

function touch(serverId) {
  db.prepare("UPDATE servers SET status='online', lastSeenAt=? WHERE id=?")
    .run(new Date().toISOString(), serverId);
}

// ─── POST /api/nodes/register ─────────────────────────────────────────────────
// Called by a node on startup. Stores full system info and returns active identities.
router.post('/register', (req, res) => {
  const result = register(req.body);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

// ─── POST /api/nodes/heartbeat ────────────────────────────────────────────────
// Called every 30 s. Stores health metrics; offline watcher marks OFFLINE after 90 s silence.
router.post('/heartbeat', (req, res) => {
  const result = recordHeartbeat(req.body.apiKey, req.body);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

// ─── GET /api/nodes/jobs ──────────────────────────────────────────────────────
// Returns queued jobs for this server's identities, respecting scheduledFor and daily limits.
router.get('/jobs', (req, res) => {
  const { apiKey, limit = 10 } = req.query;
  const server = getServer(apiKey);
  if (!server) return res.status(401).json({ error: 'Invalid apiKey' });
  touch(server.id);

  // Signer-health gate (legacy pipeline): withhold jobs when this node's DKIM
  // signer is reported down. Postfix tempfail is still the final guarantee.
  if (!isSignerHealthy(server.id)) return res.json({ jobs: [] });

  // Unsubscribe-host gate (legacy pipeline): every send_jobs row is contact-bound
  // and advertises the List-Unsubscribe URL — withhold the whole batch while the
  // unsubscribe host is unverified. Jobs stay queued; dispatch resumes once the
  // host verifies (see services/UnsubscribeHostReadiness.js).
  if (!unsubscribeHostAllowsDispatch()) return res.json({ jobs: [] });

  const today = new Date().toISOString().slice(0, 10);

  db.prepare(`
    UPDATE sender_identities SET dailySentCount=0, lastResetDate=?
    WHERE serverId=? AND (lastResetDate IS NULL OR lastResetDate != ?)
  `).run(today, server.id, today);

  // Legacy dispatch gate: only hand out jobs for identities the node has proven it
  // can send (active + provisioning-verified READY).
  const identities = db.prepare("SELECT * FROM sender_identities WHERE serverId=? AND status='active' AND verificationStatus='READY'").all(server.id);
  if (identities.length === 0) return res.json({ jobs: [] });

  const now  = new Date().toISOString();
  const jobs = [];
  const cap  = Math.min(Number(limit), 50);

  for (const identity of identities) {
    const remaining = identity.dailyLimit - identity.dailySentCount;
    if (remaining <= 0) continue;

    const batch = db.prepare(`
      SELECT j.*, si.domain, si.ip, si.fromAddr, si.fromName, si.dkimSelector
      FROM send_jobs j
      JOIN sender_identities si ON si.id = j.senderIdentityId
      WHERE j.senderIdentityId=? AND j.status='queued'
        AND (j.scheduledFor IS NULL OR j.scheduledFor <= ?)
      ORDER BY j.id ASC
      LIMIT ?
    `).all(identity.id, now, Math.min(remaining, cap - jobs.length));

    jobs.push(...batch);
    if (jobs.length >= cap) break;
  }

  // ── Claim-time suppression gate (legacy pipeline) ─────────────────────────────
  // A recipient may have unsubscribed after the job was queued. Cancel suppressed
  // candidates instead of claiming them, and never hand them to the node.
  if (jobs.length > 0) {
    const suppressed = suppressedContactIdSet(jobs.map((j) => j.contactId));
    if (suppressed.size > 0) {
      const cancel = db.prepare(
        "UPDATE send_jobs SET status='cancelled', reasonCategory='suppressed', reasonDetail='recipient unsubscribed' WHERE id=? AND status='queued'"
      );
      for (const j of jobs) if (suppressed.has(j.contactId)) cancel.run(j.id);
    }
    for (let i = jobs.length - 1; i >= 0; i--) if (suppressed.has(jobs[i].contactId)) jobs.splice(i, 1);
  }

  if (jobs.length > 0) {
    const claimedAt = new Date().toISOString();
    const stmt = db.prepare("UPDATE send_jobs SET status='claimed', claimedAt=? WHERE id=?");
    for (const j of jobs) stmt.run(claimedAt, j.id);
  }

  // Attach the signed unsubscribe URL so the node emits the same token in the
  // List-Unsubscribe header and the visible body link. The controller is the sole
  // token authority; the node never needs the signing secret.
  for (const j of jobs) {
    j.unsubscribeUrl = buildUnsubscribeUrl(j.contactId, { identityId: j.senderIdentityId });
  }

  res.json({ jobs });
});

// ─── POST /api/nodes/results ──────────────────────────────────────────────────
// Node reports send outcomes (success or failure from local Postfix submission).
router.post('/results', (req, res) => {
  const { apiKey, results } = req.body;
  const server = getServer(apiKey);
  if (!server) return res.status(401).json({ error: 'Invalid apiKey' });
  if (!Array.isArray(results)) return res.status(400).json({ error: 'results array required' });
  touch(server.id);

  const updateJob = db.prepare(`
    UPDATE send_jobs SET status=?, queueId=?, dsnCode=?, relay=?, remoteResponse=?,
      reasonCategory=?, reasonDetail=?, sentAt=?
    WHERE id=?
  `);
  const updateLog = db.prepare(`
    UPDATE send_log SET status=?, error=?, queueId=?
    WHERE sendJobId=?
  `);
  const updateContact = db.prepare("UPDATE contacts SET status=?, sentAt=? WHERE id=?");

  // Temporary submission failures (e.g. OpenDKIM milter tempfail / 4xx) must not
  // mark the job or contact permanently failed — requeue for retry instead.
  const RETRYABLE = new Set(['greylisted', 'rate_limited', 'connection_error', 'deferred', 'signing_unavailable']);
  const requeueJob = db.prepare(
    "UPDATE send_jobs SET status='queued', claimedAt=NULL, reasonCategory=?, reasonDetail=? WHERE id=?"
  );

  for (const r of results) {
    const job = db.prepare('SELECT * FROM send_jobs WHERE id=?').get(r.jobId);
    if (!job) continue;

    if (r.status !== 'sent' && RETRYABLE.has(r.reasonCategory)) {
      // Keep it retryable; leave the contact untouched (infra issue, not a bad address).
      requeueJob.run(r.reasonCategory, r.reasonDetail || null, r.jobId);
      continue;
    }

    updateJob.run(
      r.status, r.queueId || null, r.dsnCode || null, r.relay || null,
      r.remoteResponse || null, r.reasonCategory || null, r.reasonDetail || null,
      r.sentAt || new Date().toISOString(), r.jobId
    );

    const logStatus = r.status === 'sent' ? 'sent' : 'failed';
    const logError  = r.status !== 'sent' ? (r.reasonDetail || r.remoteResponse || 'Send failed') : null;
    if (job.sendLogId) {
      updateLog.run(logStatus, logError, r.queueId || null, r.jobId);
    }

    if (job.contactId) {
      if (r.status === 'sent') {
        updateContact.run('sent', r.sentAt || new Date().toISOString(), job.contactId);
      } else {
        updateContact.run('failed', null, job.contactId);
      }
    }

    if (r.status === 'sent') {
      db.prepare('UPDATE sender_identities SET dailySentCount = dailySentCount + 1 WHERE id=?')
        .run(job.senderIdentityId);
    }
  }

  res.json({ ok: true });
});

// ─── POST /api/nodes/provisioning-report ─────────────────────────────────────
// A node proves it is locally provisioned to send its identities. Authenticated by
// apiKey → server (authoritative); the node never supplies a serverId. Reports are
// applied only to identities OWNED by the authenticated node (others are rejected).
// Idempotent. Stores only safe metadata (no keys/secrets).
router.post('/provisioning-report', (req, res) => {
  const { apiKey, reports } = req.body;
  const server = getServer(apiKey);
  if (!server) return res.status(401).json({ error: 'Invalid apiKey' });
  if (!Array.isArray(reports)) return res.status(400).json({ error: 'reports array required' });
  touch(server.id);

  const { applied, rejected } = applyReports(server.id, reports);
  res.json({ ok: true, applied, rejected });
});

// ─── POST /api/nodes/delivery-events ─────────────────────────────────────────
// Node reports parsed Postfix mail.log events (delivered / deferred / bounced).
// Delegated to DeliveryEventService which handles deduplication, FSM transitions,
// campaign_stats updates, and backward-compatible send_jobs / send_log writes.
router.post('/delivery-events', (req, res) => {
  const { apiKey, events } = req.body;
  const server = getServer(apiKey);
  if (!server) return res.status(401).json({ error: 'Invalid apiKey' });
  if (!Array.isArray(events)) return res.status(400).json({ error: 'events array required' });
  touch(server.id);

  const { processed, skipped } = processEvents(events);
  res.json({ ok: true, processed, skipped });
});

export default router;
