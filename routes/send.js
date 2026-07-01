import express from 'express';
import { readJson, writeJson } from '../db.js';
import { sendCampaignEmail } from '../mailer.js';

const router = express.Router();

router.post('/', async (req, res) => {
  const { contactIds, templateName = 'welcome', variables = {} } = req.body;

  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return res.status(400).json({ error: 'contactIds must be a non-empty array' });
  }

  const contacts = await readJson('contacts.json');
  const sendLog = await readJson('sendLog.json');
  const results = [];

  for (const id of contactIds) {
    const contact = contacts.find((c) => c.id === id);
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

      contact.status = 'sent';
      contact.sentAt = logEntry.date;

      logEntry.status = 'sent';
      logEntry.previewUrl = previewUrl;
      results.push({ id, status: 'sent', previewUrl });
    } catch (err) {
      contact.status = 'failed';
      logEntry.error = err.message;
      results.push({ id, status: 'failed', error: err.message });
    }

    sendLog.push(logEntry);
  }

  await writeJson('contacts.json', contacts);
  await writeJson('sendLog.json', sendLog);

  res.json({ results });
});

export default router;
