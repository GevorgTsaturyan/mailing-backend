import express from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import db from '../db.js';
import * as Groups from '../services/GroupRepository.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// GET /api/contacts            → all contacts
// GET /api/contacts?groupId=N  → only contacts in group N
router.get('/', (req, res) => {
  const groupId = req.query.groupId != null ? Number(req.query.groupId) : null;
  if (groupId != null && !Number.isNaN(groupId)) {
    return res.json(db.prepare(`
      SELECT c.* FROM contacts c
      JOIN contact_group_members m ON m.contact_id = c.id
      WHERE m.group_id = ?
      ORDER BY c.id
    `).all(groupId));
  }
  res.json(db.prepare('SELECT * FROM contacts ORDER BY id').all());
});

router.post('/', (req, res) => {
  const { firstName, lastName, email, status = 'pending' } = req.body;
  if (!firstName || !lastName || !email) {
    return res.status(400).json({ error: 'firstName, lastName, email are required' });
  }
  try {
    const result = db.prepare(
      'INSERT INTO contacts (firstName, lastName, email, status) VALUES (?, ?, ?, ?)'
    ).run(firstName.trim(), lastName.trim(), email.trim().toLowerCase(), status);
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(contact);
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Email already exists' });
    throw err;
  }
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const { firstName, lastName, email, status, sentAt } = req.body;

  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  const updated = {
    firstName: firstName ?? contact.firstName,
    lastName:  lastName  ?? contact.lastName,
    email:     email     ?? contact.email,
    status:    status    ?? contact.status,
    sentAt:    sentAt    !== undefined ? sentAt : contact.sentAt,
  };

  try {
    db.prepare(
      'UPDATE contacts SET firstName=?, lastName=?, email=?, status=?, sentAt=? WHERE id=?'
    ).run(updated.firstName, updated.lastName, updated.email, updated.status, updated.sentAt, id);
    res.json(db.prepare('SELECT * FROM contacts WHERE id = ?').get(id));
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Email already exists' });
    throw err;
  }
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'Contact not found' });
  res.json({ ok: true });
});

// POST /api/contacts/import  — CSV upload
// Optional multipart fields:
//   groupId       → add every imported row to this existing group
//   newGroupName  → create (or reuse) a group by name and add every row to it
// When a group is targeted, BOTH newly-inserted and pre-existing contacts named
// in the CSV are added to it (membership is idempotent). No group field keeps the
// previous behaviour exactly.
router.post('/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let rows;
  try {
    rows = parse(req.file.buffer.toString('utf-8'), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch (e) {
    return res.status(400).json({ error: 'Invalid CSV: ' + e.message });
  }

  // Resolve the target group (if any) before importing.
  let group = null;
  const newGroupName = (req.body.newGroupName || '').trim();
  const groupId      = req.body.groupId != null && req.body.groupId !== '' ? Number(req.body.groupId) : null;
  if (newGroupName) {
    group = Groups.findOrCreateByName(newGroupName);
  } else if (groupId != null && !Number.isNaN(groupId)) {
    group = Groups.get(groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });
  }

  const ins = db.prepare(
    'INSERT OR IGNORE INTO contacts (firstName, lastName, email, status) VALUES (?, ?, ?, ?)'
  );
  const findId = db.prepare('SELECT id FROM contacts WHERE email = ?');
  let imported = 0;
  let skipped = 0;
  const contactIdsForGroup = [];

  const importMany = db.transaction((rows) => {
    for (const row of rows) {
      const fn = row.firstName || row.first_name || row.firstname || '';
      const ln = row.lastName  || row.last_name  || row.lastname  || '';
      const em = row.email || row.Email || row.EMAIL || '';
      if (!fn || !ln || !em) { skipped++; continue; }
      const email = em.trim().toLowerCase();
      const r = ins.run(fn.trim(), ln.trim(), email, 'pending');
      if (r.changes > 0) imported++; else skipped++;
      // Collect the contact id (new or pre-existing) so it can join the group.
      if (group) {
        const existing = findId.get(email);
        if (existing) contactIdsForGroup.push(existing.id);
      }
    }
  });
  importMany(rows);

  const result = { imported, skipped };
  if (group) {
    const addedToGroup = Groups.addMembers(group.id, contactIdsForGroup);
    result.group = { id: group.id, name: group.name, addedToGroup };
  }
  res.json(result);
});

export default router;
