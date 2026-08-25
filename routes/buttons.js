import express from 'express';
import * as ButtonRepository from '../services/ButtonRepository.js';
import { renderButtonHtml } from '../services/BodyCompiler.js';

const router = express.Router();

// GET /api/buttons — library list (internal_name is the admin-facing identifier)
router.get('/', (req, res) => {
  res.json(ButtonRepository.list());
});

// GET /api/buttons/:id — full record for edit + live preview
router.get('/:id', (req, res) => {
  const b = ButtonRepository.findById(Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Button not found' });
  res.json(b);
});

// GET /api/buttons/:id/preview — server-rendered HTML using the SAME renderer the
// send pipeline uses, so the admin preview matches the delivered button exactly.
// href is a harmless placeholder (# ) — no token is minted for a preview.
router.get('/:id/preview', (req, res) => {
  const b = ButtonRepository.findById(Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Button not found' });
  res.json({ html: renderButtonHtml(b.style, b.text, '#') });
});

// POST /api/buttons — create
router.post('/', (req, res) => {
  try {
    res.status(201).json(ButtonRepository.create(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/buttons/:id — update
router.put('/:id', (req, res) => {
  try {
    const b = ButtonRepository.update(Number(req.params.id), req.body);
    if (!b) return res.status(404).json({ error: 'Button not found' });
    res.json(b);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/buttons/:id — soft-delete (inactivate); snapshots keep working.
router.delete('/:id', (req, res) => {
  const ok = ButtonRepository.remove(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Button not found' });
  res.json({ ok: true });
});

export default router;
