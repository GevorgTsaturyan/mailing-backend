import express from 'express';
import db from '../db.js';
import * as FailedMails from './../services/FailedMailRepository.js';

const router = express.Router();

// GET /api/failed-mails — failed contacts + total count
//   { total: <number of failed contacts>, items: [ {id, firstName, lastName,
//     email, status, sentAt, reason, source, failCount, firstFailedAt, failedAt} ] }
router.get('/', (req, res) => {
  const items = FailedMails.list();
  res.json({ total: items.length, items });
});

// POST /api/failed-mails/:id/reset — clear the failure and set the contact back
// to 'pending' so it can be re-queued. (:id is the contact id.)
router.post('/:id/reset', (req, res) => {
  const id = Number(req.params.id);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  db.transaction(() => {
    db.prepare("UPDATE contacts SET status = 'pending', sentAt = NULL WHERE id = ?").run(id);
    FailedMails.clear(id);
  })();
  res.json({ ok: true });
});

// DELETE /api/failed-mails/:id — dismiss a contact from the failed list only
// (leaves the contact row and its status untouched). (:id is the contact id.)
router.delete('/:id', (req, res) => {
  const removed = FailedMails.clear(Number(req.params.id));
  if (removed === 0) return res.status(404).json({ error: 'Not in the failed list' });
  res.json({ ok: true });
});

export default router;
