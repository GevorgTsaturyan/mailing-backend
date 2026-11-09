// ─── /api/button-groups ─────────────────────────────────────────────────────
// JWT-protected CRUD for button groups + membership management. Mirrors
// routes/groups.js (contact groups) but keyed by button id, and without the
// targeting/usage checks (button groups are purely organisational).

import express from 'express';
import * as Groups from '../services/ButtonGroupRepository.js';

const router = express.Router();

// GET /api/button-groups — all groups with their member button ids + counts
router.get('/', (req, res) => {
  res.json(Groups.list());
});

// GET /api/button-groups/:id
router.get('/:id', (req, res) => {
  const group = Groups.get(Number(req.params.id));
  if (!group) return res.status(404).json({ error: 'Group not found' });
  res.json(group);
});

// POST /api/button-groups — create { name, description? }
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

// PUT /api/button-groups/:id — rename / edit description
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

// DELETE /api/button-groups/:id — removes the group; membership rows cascade.
// Buttons themselves are never deleted.
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Groups.get(id)) return res.status(404).json({ error: 'Group not found' });
  Groups.remove(id);
  res.json({ ok: true });
});

// POST /api/button-groups/:id/members — add buttons { buttonIds: [...] }
router.post('/:id/members', (req, res) => {
  const id = Number(req.params.id);
  if (!Groups.get(id)) return res.status(404).json({ error: 'Group not found' });
  const { buttonIds } = req.body;
  if (!Array.isArray(buttonIds) || buttonIds.length === 0) {
    return res.status(400).json({ error: 'buttonIds must be a non-empty array' });
  }
  const added = Groups.addMembers(id, buttonIds);
  res.json({ added, group: Groups.get(id) });
});

// DELETE /api/button-groups/:id/members — remove buttons { buttonIds: [...] }
router.delete('/:id/members', (req, res) => {
  const id = Number(req.params.id);
  if (!Groups.get(id)) return res.status(404).json({ error: 'Group not found' });
  const { buttonIds } = req.body;
  if (!Array.isArray(buttonIds) || buttonIds.length === 0) {
    return res.status(400).json({ error: 'buttonIds must be a non-empty array' });
  }
  const removed = Groups.removeMembers(id, buttonIds);
  res.json({ removed, group: Groups.get(id) });
});

export default router;
