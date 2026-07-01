import express from 'express';
import db from '../db.js';
import { sendCampaignEmail } from '../mailer.js';

const router = express.Router();

router.post('/', async (req, res) => {
  const { contactIds, templateName = 'welcome', variables = {} } = req.body;

  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return res.status(400).json({ error: 'contactIds must be a non-empty array' });
  }

  const results = [];
  const insertLog = db.prepare(`
    INSERT INTO send_log (date, contactId, name, email, template, status, previewUrl, error)
    VALUES (@date, @contactId, @name, @email, @template, @status, @previewUrl, @error)
  `);

  for (const id of contactIds) {
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
    if (!contact) {
      results.push({ id, status: 'failed', error: 'Contact not found' });
      continue;
    }

    const logEntry = {
      date: new Date().toISOString(),
      contactId: contact.id,
      name: `${contact.firstName} ${contact.lastName}`,
      email: contact.email,
      template: templateName,
      status: 'failed',
      previewUrl: null,
      error: null,
    };

    try {
      const { previewUrl } = await sendCampaignEmail({
        to: contact.email,
        templateName,
        variables: { firstName: contact.firstName, lastName: contact.lastName, ...variables },
      });

      db.prepare('UPDATE contacts SET status=?, sentAt=? WHERE id=?')
        .run('sent', logEntry.date, id);

      logEntry.status = 'sent';
      logEntry.previewUrl = previewUrl;
      results.push({ id, status: 'sent', previewUrl });
    } catch (err) {
      db.prepare('UPDATE contacts SET status=? WHERE id=?').run('failed', id);
      logEntry.error = err.message;
      results.push({ id, status: 'failed', error: err.message });
    }

    insertLog.run(logEntry);
  }

  res.json({ results });
});

export default router;
