import express from 'express';
import db from '../db.js';

const router = express.Router();

function getServer(apiKey) {
  return db.prepare('SELECT * FROM servers WHERE apiKey = ?').get(apiKey);
}

function touch(serverId) {
  db.prepare("UPDATE servers SET status='online', lastSeenAt=? WHERE id=?")
    .run(new Date().toISOString(), serverId);
}

// POST /api/nodes/register
// Called by a node on startup. apiKey must already exist (created in controller UI).
router.post('/register', (req, res) => {
  const { apiKey, mainIp, label } = req.body;
  const server = getServer(apiKey);
  if (!server) return res.status(401).json({ error: 'Invalid apiKey. Create the server in the controller UI first.' });

  const updates = {};
  if (mainIp) updates.mainIp = mainIp;
  if (label)  updates.label  = label;

  if (Object.keys(updates).length > 0) {
    const sets = Object.keys(updates).map(k => `${k}=?`).join(', ');
    db.prepare(`UPDATE servers SET ${sets} WHERE id=?`).run(...Object.values(updates), server.id);
  }
  touch(server.id);

  const identities = db.prepare("SELECT * FROM sender_identities WHERE serverId=? AND status='active'").all(server.id);
  res.json({ ok: true, serverId: server.id, identities });
});

// POST /api/nodes/heartbeat
router.post('/heartbeat', (req, res) => {
  const { apiKey } = req.body;
  const server = getServer(apiKey);
  if (!server) return res.status(401).json({ error: 'Invalid apiKey' });
  touch(server.id);
  res.json({ ok: true });
});

// GET /api/nodes/jobs?apiKey=xxx&limit=10
// Returns queued jobs assigned to this server's identities, respecting scheduledFor and daily limits.
router.get('/jobs', (req, res) => {
  const { apiKey, limit = 10 } = req.query;
  const server = getServer(apiKey);
  if (!server) return res.status(401).json({ error: 'Invalid apiKey' });
  touch(server.id);

  const today = new Date().toISOString().slice(0, 10);

  // Reset daily counts for identities whose date rolled over
  db.prepare(`
    UPDATE sender_identities SET dailySentCount=0, lastResetDate=?
    WHERE serverId=? AND (lastResetDate IS NULL OR lastResetDate != ?)
  `).run(today, server.id, today);

  const identities = db.prepare("SELECT * FROM sender_identities WHERE serverId=? AND status='active'").all(server.id);
  if (identities.length === 0) return res.json({ jobs: [] });

  const now = new Date().toISOString();
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

  if (jobs.length > 0) {
    const claimedAt = new Date().toISOString();
    const stmt = db.prepare("UPDATE send_jobs SET status='claimed', claimedAt=? WHERE id=?");
    for (const j of jobs) stmt.run(claimedAt, j.id);
  }

  res.json({ jobs });
});

// POST /api/nodes/results
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

  for (const r of results) {
    const job = db.prepare('SELECT * FROM send_jobs WHERE id=?').get(r.jobId);
    if (!job) continue;

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

// POST /api/nodes/delivery-events
// Node reports parsed Postfix mail.log events (delivered / deferred / bounced).
// These are the final verdicts from Gmail/Outlook/etc.
router.post('/delivery-events', (req, res) => {
  const { apiKey, events } = req.body;
  const server = getServer(apiKey);
  if (!server) return res.status(401).json({ error: 'Invalid apiKey' });
  if (!Array.isArray(events)) return res.status(400).json({ error: 'events array required' });
  touch(server.id);

  const now = new Date().toISOString();
  const insertEvent = db.prepare(`
    INSERT INTO delivery_events (sendJobId, queueId, email, eventType, dsnCode, relay, response, reasonCategory, reasonDetail, logTime, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateJob = db.prepare(`
    UPDATE send_jobs SET status=?, dsnCode=?, relay=?, remoteResponse=?, reasonCategory=?, reasonDetail=?, deliveredAt=?
    WHERE queueId=? AND status NOT IN ('delivered','bounced')
  `);
  const updateLog = db.prepare(`
    UPDATE send_log SET deliveryStatus=?, dsnCode=?, remoteMx=?, remoteResponse=?,
      reasonCategory=?, reasonDetail=?, deliveredAt=?, lastEventAt=?
    WHERE queueId=?
  `);

  for (const e of events) {
    const job = db.prepare('SELECT id, email FROM send_jobs WHERE queueId=?').get(e.queueId);

    insertEvent.run(
      job?.id || null, e.queueId, job?.email || e.email || null,
      e.eventType, e.dsnCode || null, e.relay || null,
      (e.response || '').slice(0, 500),
      e.reasonCategory || null, e.reasonDetail || null,
      e.logTime || now, now
    );

    const finalStatus = e.eventType === 'sent' ? 'delivered' : e.eventType === 'bounced' ? 'bounced' : 'deferred';
    const deliveredAt = e.eventType === 'sent' ? now : null;

    updateJob.run(finalStatus, e.dsnCode || null, e.relay || null,
      (e.response || '').slice(0, 500), e.reasonCategory || null, e.reasonDetail || null,
      deliveredAt, e.queueId);

    updateLog.run(
      finalStatus, e.dsnCode || null, e.relay || null,
      (e.response || '').slice(0, 500), e.reasonCategory || null, e.reasonDetail || null,
      deliveredAt, now, e.queueId
    );
  }

  res.json({ ok: true });
});

export default router;
