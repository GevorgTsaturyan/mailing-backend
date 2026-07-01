import express from 'express';
import { readJson, writeJson } from '../db.js';

const router = express.Router();

router.get('/', async (req, res) => {
  const contacts = await readJson('contacts.json');
  res.json(contacts);
});

router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { status, sentAt } = req.body;

  const contacts = await readJson('contacts.json');
  const contact = contacts.find((c) => c.id === id);

  if (!contact) {
    return res.status(404).json({ error: 'Contact not found' });
  }

  if (status !== undefined) contact.status = status;
  if (sentAt !== undefined) contact.sentAt = sentAt;

  await writeJson('contacts.json', contacts);
  res.json(contact);
});

export default router;
