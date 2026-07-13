import express from 'express';
import db from '../db.js';

const router = express.Router();

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, COUNT(s.id) AS serverCount
    FROM providers p
    LEFT JOIN servers s ON s.providerId = p.id
    GROUP BY p.id
    ORDER BY p.name
  `).all();
  res.json(rows);
});

router.post('/', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  try {
    const info = db.prepare('INSERT INTO providers (name, createdAt) VALUES (?, ?)').run(name.trim(), new Date().toISOString());
    res.json(db.prepare('SELECT * FROM providers WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Provider name already exists' });
    throw e;
  }
});

router.put('/:id', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  db.prepare('UPDATE providers SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
  res.json(db.prepare('SELECT * FROM providers WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  const servers = db.prepare('SELECT id FROM servers WHERE providerId = ?').all(req.params.id);
  if (servers.length > 0) return res.status(409).json({ error: 'Remove all servers under this provider first' });
  db.prepare('DELETE FROM providers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
