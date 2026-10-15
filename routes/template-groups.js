// ─── /api/template-groups ─────────────────────────────────────────────────────
// JWT-protected CRUD for template groups + membership management. Mirrors
// routes/groups.js (contact groups) but keyed by template name, and without the
// targeting/usage checks (template groups are purely organisational).

import express from 'express';
import * as Groups from '../services/TemplateGroupRepository.js';

const router = express.Router();

// GET /api/template-groups — all groups with their member template names + counts
router.get('/', (req, res) => {
  res.json(Groups.list());
});

// GET /api/template-groups/:id
router.get('/:id', (req, res) => {
  const group = Groups.get(Number(req.params.id));
  if (!group) return res.status(404).json({ error: 'Group not found' });
  res.json(group);
});

// POST /api/template-groups — create { name, description? }
router.post('/', (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    res.status(201).json(Groups.create({ name, description: description ?? null }));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'A group with that name already exists' });
    }
    throw err;
  }
});

// PUT /api/template-groups/:id — rename / edit description
router.put('/:id', (req, res) => {
  const { name, description } = req.body;
  if (name !== undefined && !name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
  try {
    const updated = Groups.update(Number(req.params.id), { name, description });
    if (!updated) return res.status(404).json({ error: 'Group not found' });
    res.json(updated);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'A group with that name already exists' });
    }
    throw err;
  }
});

// DELETE /api/template-groups/:id — removes the group; membership rows cascade.
// Templates themselves are never deleted.
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Groups.get(id)) return res.status(404).json({ error: 'Group not found' });
  Groups.remove(id);
  res.json({ ok: true });
});

// POST /api/template-groups/:id/members — add templates { templateNames: [...] }
router.post('/:id/members', (req, res) => {
  const id = Number(req.params.id);
  if (!Groups.get(id)) return res.status(404).json({ error: 'Group not found' });
  const { templateNames } = req.body;
  if (!Array.isArray(templateNames) || templateNames.length === 0) {
    return res.status(400).json({ error: 'templateNames must be a non-empty array' });
  }
  const added = Groups.addMembers(id, templateNames);
  res.json({ added, group: Groups.get(id) });
});

// DELETE /api/template-groups/:id/members — remove templates { templateNames: [...] }
router.delete('/:id/members', (req, res) => {
  const id = Number(req.params.id);
  if (!Groups.get(id)) return res.status(404).json({ error: 'Group not found' });
  const { templateNames } = req.body;
  if (!Array.isArray(templateNames) || templateNames.length === 0) {
    return res.status(400).json({ error: 'templateNames must be a non-empty array' });
  }
  const removed = Groups.removeMembers(id, templateNames);
  res.json({ removed, group: Groups.get(id) });
});

export default router;
