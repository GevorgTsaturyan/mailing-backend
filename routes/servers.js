import express from 'express';
import crypto from 'crypto';
import db from '../db.js';

const router = express.Router();

router.get('/', (req, res) => {
  const servers = db.prepare(`
    SELECT s.*, p.name AS providerName,
      COUNT(si.id) AS identityCount,
      SUM(CASE WHEN si.status='active' THEN 1 ELSE 0 END) AS activeIdentities
    FROM servers s
    LEFT JOIN providers p ON p.id = s.providerId
    LEFT JOIN sender_identities si ON si.serverId = s.id
    GROUP BY s.id
    ORDER BY p.name, s.label
  `).all();
  res.json(servers);
});

router.get('/:id', (req, res) => {
  const server = db.prepare(`
    SELECT s.*, p.name AS providerName
    FROM servers s LEFT JOIN providers p ON p.id = s.providerId
    WHERE s.id = ?
  `).get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  server.identities = db.prepare('SELECT * FROM sender_identities WHERE serverId = ? ORDER BY id').all(server.id);
  res.json(server);
});

router.post('/', (req, res) => {
  const { providerId, label, mainIp } = req.body;
  if (!label?.trim()) return res.status(400).json({ error: 'label required' });
  const apiKey = crypto.randomBytes(32).toString('hex');
  const info = db.prepare(`
    INSERT INTO servers (providerId, label, mainIp, apiKey, status, createdAt)
    VALUES (?, ?, ?, ?, 'offline', ?)
  `).run(providerId || null, label.trim(), mainIp?.trim() || '', apiKey, new Date().toISOString());
  res.json(db.prepare('SELECT * FROM servers WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/:id', (req, res) => {
  const { providerId, label, mainIp, status } = req.body;
  const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  db.prepare(`
    UPDATE servers SET providerId=?, label=?, mainIp=?, status=? WHERE id=?
  `).run(
    providerId ?? s.providerId,
    label?.trim() ?? s.label,
    mainIp?.trim() ?? s.mainIp,
    status ?? s.status,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  const identities = db.prepare('SELECT id FROM sender_identities WHERE serverId = ?').all(req.params.id);
  if (identities.length > 0) return res.status(409).json({ error: 'Remove all sender identities on this server first' });
  db.prepare('DELETE FROM servers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Regenerate apiKey
router.post('/:id/regenerate-key', (req, res) => {
  const newKey = crypto.randomBytes(32).toString('hex');
  db.prepare('UPDATE servers SET apiKey = ? WHERE id = ?').run(newKey, req.params.id);
  res.json({ apiKey: newKey });
});

export default router;
