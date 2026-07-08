import express from 'express';
import db from '../db.js';
import { applyRecurringCampaigns } from '../scheduler.js';

const router = express.Router();

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM recurring_campaigns ORDER BY createdAt DESC').all());
});

router.post('/', (req, res) => {
  const { name, templateName, subject, html, txt, startTime, endTime, initialCount, increasePercent } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!templateName && !subject) return res.status(400).json({ error: 'templateName or subject required' });

  const result = db.prepare(`
    INSERT INTO recurring_campaigns
      (name, templateName, subject, html, txt, startTime, endTime, initialCount, increasePercent, status, currentDay, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?)
  `).run(
    name,
    templateName || null, subject || null, html || null, txt || null,
    startTime || '09:00', endTime || '17:00',
    initialCount || 10, increasePercent || 0,
    new Date().toISOString()
  );

  applyRecurringCampaigns();
  res.status(201).json(db.prepare('SELECT * FROM recurring_campaigns WHERE id=?').get(result.lastInsertRowid));
});

router.put('/:id', (req, res) => {
  const id  = Number(req.params.id);
  const row = db.prepare('SELECT * FROM recurring_campaigns WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const { name, templateName, subject, html, txt, startTime, endTime, initialCount, increasePercent } = req.body;

  db.prepare(`
    UPDATE recurring_campaigns
    SET name=?, templateName=?, subject=?, html=?, txt=?,
        startTime=?, endTime=?, initialCount=?, increasePercent=?
    WHERE id=?
  `).run(
    name          ?? row.name,
    templateName  !== undefined ? templateName  : row.templateName,
    subject       !== undefined ? subject       : row.subject,
    html          !== undefined ? html          : row.html,
    txt           !== undefined ? txt           : row.txt,
    startTime     ?? row.startTime,
    endTime       ?? row.endTime,
    initialCount  ?? row.initialCount,
    increasePercent ?? row.increasePercent,
    id
  );

  applyRecurringCampaigns();
  res.json(db.prepare('SELECT * FROM recurring_campaigns WHERE id=?').get(id));
});

router.post('/:id/pause', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM recurring_campaigns WHERE id=?').get(id))
    return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE recurring_campaigns SET status='paused' WHERE id=?").run(id);
  applyRecurringCampaigns();
  res.json(db.prepare('SELECT * FROM recurring_campaigns WHERE id=?').get(id));
});

router.post('/:id/resume', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM recurring_campaigns WHERE id=?').get(id))
    return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE recurring_campaigns SET status='active' WHERE id=?").run(id);
  applyRecurringCampaigns();
  res.json(db.prepare('SELECT * FROM recurring_campaigns WHERE id=?').get(id));
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare('DELETE FROM recurring_campaigns WHERE id=?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  applyRecurringCampaigns();
  res.json({ ok: true });
});

export default router;
