import express from 'express';
import db from '../db.js';
import { setPhases } from '../services/ProvisioningPhaseStore.js';

const router = express.Router();

router.get('/', (req, res) => {
  const { serverId } = req.query;
  const rows = serverId
    ? db.prepare('SELECT * FROM sender_identities WHERE serverId = ? ORDER BY id').all(serverId)
    : db.prepare(`
        SELECT si.*, s.label AS serverLabel, p.name AS providerName
        FROM sender_identities si
        JOIN servers s ON s.id = si.serverId
        LEFT JOIN providers p ON p.id = s.providerId
        ORDER BY p.name, s.label, si.domain
      `).all();
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM sender_identities WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.post('/', (req, res) => {
  const { serverId, domain, ip, fromName, fromAddr, dkimSelector, dailyLimit, warmupStage } = req.body;
  if (!serverId) return res.status(400).json({ error: 'serverId required' });
  if (!domain?.trim()) return res.status(400).json({ error: 'domain required' });
  if (!ip?.trim()) return res.status(400).json({ error: 'ip required' });
  if (!fromAddr?.trim()) return res.status(400).json({ error: 'fromAddr required' });
  if (!db.prepare('SELECT id FROM servers WHERE id = ?').get(serverId)) {
    return res.status(404).json({ error: 'Server not found' });
  }
  const existing = db.prepare(
    'SELECT * FROM sender_identities WHERE serverId = ? AND fromAddr = ?'
  ).get(serverId, fromAddr.trim());
  if (existing) return res.json(existing);

  const info = db.prepare(`
    INSERT INTO sender_identities (serverId, domain, ip, fromName, fromAddr, dkimSelector, dailyLimit, warmupStage, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    serverId, domain.trim(), ip.trim(),
    fromName?.trim() || '', fromAddr.trim(),
    dkimSelector?.trim() || 'mail',
    dailyLimit ?? 50, warmupStage ?? 1,
    new Date().toISOString()
  );
  res.json(db.prepare('SELECT * FROM sender_identities WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/:id', (req, res) => {
  const si = db.prepare('SELECT * FROM sender_identities WHERE id = ?').get(req.params.id);
  if (!si) return res.status(404).json({ error: 'Not found' });
  const { domain, ip, fromName, fromAddr, dkimSelector, dailyLimit, warmupStage, status } = req.body;
  const newDomain   = domain?.trim() ?? si.domain;
  const newIp       = ip?.trim() ?? si.ip;
  const newSelector = dkimSelector?.trim() ?? si.dkimSelector;

  // verificationStatus is node-proven and NOT settable via this API. If any of the
  // verified-defining attributes (domain / ip / DKIM selector) change, the prior
  // proof no longer applies — reset to 'unverified' so the identity cannot send
  // until the owning node re-verifies the new configuration.
  const invalidatesVerification =
    newDomain !== si.domain || newIp !== si.ip || newSelector !== si.dkimSelector;

  db.prepare(`
    UPDATE sender_identities
    SET domain=?, ip=?, fromName=?, fromAddr=?, dkimSelector=?, dailyLimit=?, warmupStage=?, status=?
    WHERE id=?
  `).run(
    newDomain, newIp,
    fromName?.trim() ?? si.fromName,
    fromAddr?.trim() ?? si.fromAddr,
    newSelector,
    dailyLimit ?? si.dailyLimit,
    warmupStage ?? si.warmupStage,
    status ?? si.status,
    req.params.id
  );

  if (invalidatesVerification) {
    db.prepare(`
      UPDATE sender_identities
      SET verificationStatus='unverified', lastVerifiedAt=NULL, verificationReasons=NULL,
          verifiedIpv4=NULL, verifiedHostname=NULL, verifiedDkimSelector=NULL
      WHERE id=?
    `).run(req.params.id);
  }

  res.json(db.prepare('SELECT * FROM sender_identities WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  const id = req.params.id;
  const si = db.prepare('SELECT id FROM sender_identities WHERE id = ?').get(id);
  if (!si) return res.json({ ok: true, alreadyGone: true });   // idempotent delete

  const legacyPending = db.prepare(
    "SELECT id FROM send_jobs WHERE senderIdentityId=? AND status IN ('queued','claimed') LIMIT 1"
  ).get(id);
  const canonicalPending = db.prepare(
    "SELECT id FROM jobs WHERE identity_id=? AND status IN ('PENDING','PROCESSING') LIMIT 1"
  ).get(id);
  if (legacyPending || canonicalPending) {
    return res.status(409).json({ error: 'There are pending jobs for this identity. Wait for them to complete first.' });
  }

  // foreign_keys is ON, so the identity row cannot be deleted while child rows
  // reference it. Clear them atomically first, otherwise a provisioned identity
  // (which always has provisioning_tasks) can never be deleted — blocking the
  // delete → re-add cycle.
  //
  // The schema encodes the intent per table:
  //   • provisioning_tasks.identityId is NOT NULL (a pure lifecycle row with no
  //     historical value once the identity is gone) → delete outright. This also
  //     removes any pending/in-progress task so no provisioning/reverify work is
  //     left orphaned against a deleted identity.
  //   • send_jobs.senderIdentityId, jobs.identity_id and campaigns.identity_id are
  //     all NULLABLE historical references → detach (set NULL) so delivery/campaign
  //     history survives the deletion instead of being destroyed.
  // These are exactly the four FOREIGN KEYs that reference sender_identities(id).
  try {
    const purge = db.transaction((identityId) => {
      db.prepare('DELETE FROM provisioning_tasks WHERE identityId = ?').run(identityId);
      db.prepare('UPDATE send_jobs SET senderIdentityId = NULL WHERE senderIdentityId = ?').run(identityId);
      db.prepare('UPDATE jobs SET identity_id = NULL WHERE identity_id = ?').run(identityId);
      db.prepare('UPDATE campaigns SET identity_id = NULL WHERE identity_id = ?').run(identityId);
      db.prepare('DELETE FROM sender_identities WHERE id = ?').run(identityId);
    });
    purge(id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[sender-identities] delete failed for id', id, '-', e.message);
    res.status(500).json({ error: 'Failed to delete identity' });
  }
});

// POST /api/sender-identities/:id/provision
// Creates a provisioning task for the identity. Idempotent: if a PENDING or
// IN_PROGRESS task already exists, returns it without creating a duplicate.
// Requires JWT auth (inherited from app.use('/api', requireAuth)).
router.post('/:id/provision', (req, res) => {
  const si = db.prepare('SELECT * FROM sender_identities WHERE id=?').get(req.params.id);
  if (!si) return res.status(404).json({ error: 'Not found' });

  const existing = db.prepare(`
    SELECT id, status FROM provisioning_tasks
    WHERE identityId=? AND status IN ('PENDING','IN_PROGRESS')
    ORDER BY requestedAt DESC LIMIT 1
  `).get(si.id);
  if (existing) {
    return res.json({ taskId: existing.id, status: existing.status, alreadyQueued: true });
  }

  const now  = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO provisioning_tasks (identityId, serverId, status, taskType, requestedAt) VALUES (?,?,'PENDING','provision',?)`
  ).run(si.id, si.serverId, now);
  db.prepare(`UPDATE sender_identities SET provisioningStatus='PENDING' WHERE id=?`).run(si.id);

  // Initialise the pipeline phases blob so the UI has something to render
  // immediately — each group starts as PENDING.
  setPhases(si.id, {
    mailNode:     { status: 'PENDING', phases: {} },
    cloudflare:   { status: 'PENDING', phases: {} },
    dns:          { status: 'PENDING', message: null },
    nginx:        { status: 'PENDING', phases: {} },
    ptr:          { status: 'PENDING', message: null },
    verification: { status: 'PENDING', reasons: [] },
  });

  res.json({ taskId: Number(info.lastInsertRowid), status: 'PENDING' });
});

router.post('/:id/pause', (req, res) => {
  db.prepare("UPDATE sender_identities SET status='paused' WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

router.post('/:id/resume', (req, res) => {
  db.prepare("UPDATE sender_identities SET status='active' WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

export default router;
