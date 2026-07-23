import express from 'express';
import db from '../db.js';

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
  db.prepare(`
    UPDATE sender_identities
    SET domain=?, ip=?, fromName=?, fromAddr=?, dkimSelector=?, dailyLimit=?, warmupStage=?, status=?
    WHERE id=?
  `).run(
    domain?.trim() ?? si.domain,
    ip?.trim() ?? si.ip,
    fromName?.trim() ?? si.fromName,
    fromAddr?.trim() ?? si.fromAddr,
    dkimSelector?.trim() ?? si.dkimSelector,
    dailyLimit ?? si.dailyLimit,
    warmupStage ?? si.warmupStage,
    status ?? si.status,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM sender_identities WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  const legacyPending = db.prepare(
    "SELECT id FROM send_jobs WHERE senderIdentityId=? AND status IN ('queued','claimed') LIMIT 1"
  ).get(req.params.id);
  const canonicalPending = db.prepare(
    "SELECT id FROM jobs WHERE identity_id=? AND status IN ('PENDING','PROCESSING') LIMIT 1"
  ).get(req.params.id);
  if (legacyPending || canonicalPending) {
    return res.status(409).json({ error: 'There are pending jobs for this identity. Wait for them to complete first.' });
  }
  db.prepare('DELETE FROM sender_identities WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
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
