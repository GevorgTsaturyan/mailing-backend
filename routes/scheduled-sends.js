import express from 'express';
import db from '../db.js';
import * as Groups from '../services/GroupRepository.js';

const router = express.Router();

function parse(row) {
  return { ...row, contactIds: JSON.parse(row.contactIds) };
}

router.get('/', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM scheduled_sends ORDER BY scheduledAt ASC'
  ).all();
  res.json(rows.map(row => {
    const parsed = parse(row);
    const lastLog = db.prepare(
      'SELECT MAX(id) as lastId FROM send_log WHERE scheduledSendId = ?'
    ).get(row.id);
    return { ...parsed, lastSendLogId: lastLog?.lastId || null };
  }));
});

router.get('/:id', (req, res) => {
  const id  = Number(req.params.id);
  const row = db.prepare('SELECT * FROM scheduled_sends WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const parsed   = parse(row);
  const logs     = db.prepare(
    'SELECT * FROM send_log WHERE scheduledSendId = ? ORDER BY id ASC'
  ).all(id);
  const contacts = parsed.contactIds
    .map(cid => db.prepare('SELECT * FROM contacts WHERE id = ?').get(cid))
    .filter(Boolean);

  res.json({ ...parsed, logs, contacts });
});

router.post('/', (req, res) => {
  const { label, contactIds, groupIds, templateName, subject, html, txt, scheduledAt, content_type } = req.body;

  // Resolve groups to member ids AT CREATION TIME and snapshot the distinct union
  // of explicit contactIds + group members. The snapshot is fixed once stored —
  // later membership changes never alter this one-off send. No historical dedup.
  const fromGroups = groupIds?.length ? Groups.contactIdsInGroups(groupIds) : [];
  const snapshot   = [...new Set([...(Array.isArray(contactIds) ? contactIds : []), ...fromGroups])];

  if (snapshot.length === 0)
    return res.status(400).json({ error: 'contactIds or groupIds must resolve to at least one recipient' });
  if (!scheduledAt)
    return res.status(400).json({ error: 'scheduledAt required' });
  if (!templateName && !subject)
    return res.status(400).json({ error: 'templateName or subject required' });
  if (content_type != null && content_type !== 'html' && content_type !== 'text')
    return res.status(400).json({ error: "content_type must be 'html' or 'text'" });

  const result = db.prepare(`
    INSERT INTO scheduled_sends
      (label, contactIds, templateName, subject, html, txt, content_type, scheduledAt, status, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    label || null,
    JSON.stringify(snapshot),
    templateName || null,
    subject || null,
    html || null,
    txt || null,
    content_type || 'html',
    scheduledAt,
    new Date().toISOString()
  );

  const row = db.prepare('SELECT * FROM scheduled_sends WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(parse(row));
});

router.put('/:id', (req, res) => {
  const id  = Number(req.params.id);
  const row = db.prepare('SELECT * FROM scheduled_sends WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.status !== 'pending')
    return res.status(400).json({ error: 'Only pending scheduled sends can be edited' });

  const { label, scheduledAt, templateName, subject, html, txt, content_type } = req.body;

  if (content_type != null && content_type !== 'html' && content_type !== 'text')
    return res.status(400).json({ error: "content_type must be 'html' or 'text'" });

  db.prepare(`
    UPDATE scheduled_sends
    SET label=?, scheduledAt=?, templateName=?, subject=?, html=?, txt=?, content_type=?
    WHERE id=?
  `).run(
    label         !== undefined ? label         : row.label,
    scheduledAt   ?? row.scheduledAt,
    templateName  !== undefined ? templateName  : row.templateName,
    subject       !== undefined ? subject       : row.subject,
    html          !== undefined ? html          : row.html,
    txt           !== undefined ? txt           : row.txt,
    content_type  !== undefined ? content_type  : row.content_type,
    id
  );

  const updated = db.prepare('SELECT * FROM scheduled_sends WHERE id = ?').get(id);
  res.json(parse(updated));
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare('DELETE FROM scheduled_sends WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

export default router;
