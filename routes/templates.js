import express from 'express';
import db from '../db.js';

const router = express.Router();

router.get('/', (req, res) => {
  const templates = db.prepare('SELECT name, subject FROM templates ORDER BY name').all();
  res.json(templates.map(t => t.name));
});

router.get('/:name', (req, res) => {
  const tmpl = db.prepare('SELECT * FROM templates WHERE name = ?').get(req.params.name);
  if (!tmpl) return res.status(404).json({ error: 'Template not found' });
  res.json(tmpl);
});

router.post('/', (req, res) => {
  const { name, subject, html, txt } = req.body;
  if (!name || !subject) return res.status(400).json({ error: 'name and subject required' });
  try {
    db.prepare(
      'INSERT INTO templates (name, subject, html, txt) VALUES (?, ?, ?, ?)'
    ).run(name.trim(), subject.trim(), html || '', txt || '');
    res.status(201).json({ name: name.trim() });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Template name already exists' });
    throw err;
  }
});

router.put('/:name', (req, res) => {
  const { subject, html, txt } = req.body;
  const existing = db.prepare('SELECT name FROM templates WHERE name = ?').get(req.params.name);
  if (!existing) return res.status(404).json({ error: 'Template not found' });

  db.prepare(
    'UPDATE templates SET subject=COALESCE(?, subject), html=COALESCE(?, html), txt=COALESCE(?, txt) WHERE name=?'
  ).run(subject ?? null, html ?? null, txt ?? null, req.params.name);

  res.json(db.prepare('SELECT * FROM templates WHERE name = ?').get(req.params.name));
});

router.delete('/:name', (req, res) => {
  const result = db.prepare('DELETE FROM templates WHERE name = ?').run(req.params.name);
  if (result.changes === 0) return res.status(404).json({ error: 'Template not found' });
  res.json({ ok: true });
});

export default router;
