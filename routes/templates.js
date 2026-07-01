import express from 'express';
import { listTemplates, loadTemplate } from '../mailer.js';

const router = express.Router();

router.get('/', async (req, res) => {
  const templates = await listTemplates();
  res.json(templates);
});

router.get('/:name', async (req, res) => {
  try {
    const { html, text } = await loadTemplate(req.params.name);
    res.json({ name: req.params.name, html, text });
  } catch {
    res.status(404).json({ error: 'Template not found' });
  }
});

export default router;
