import express from 'express';
import db from '../db.js';
import * as Groups from '../services/GroupRepository.js';

const router = express.Router();

// GET /api/groups — list groups with member counts
router.get('/', (req, res) => {
  res.json(Groups.list());
});

// GET /api/groups/:id
router.get('/:id', (req, res) => {
  const group = Groups.get(Number(req.params.id));
  if (!group) return res.status(404).json({ error: 'Group not found' });
  res.json(group);
});

// POST /api/groups — create { name, description? }
router.post('/', (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    res.status(201).json(Groups.create({ name, description: description ?? null }));
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'A group with that name already exists' });
    throw err;
  }
});

// PUT /api/groups/:id — rename / edit description
router.put('/:id', (req, res) => {
  const { name, description } = req.body;
  if (name !== undefined && !name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
  try {
    const updated = Groups.update(Number(req.params.id), { name, description });
    if (!updated) return res.status(404).json({ error: 'Group not found' });
    res.json(updated);
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'A group with that name already exists' });
    throw err;
  }
});

// DELETE /api/groups/:id            — blocked (409) if targeted by an active/paused
//                                      recurring campaign or the group-mode daily batch
// DELETE /api/groups/:id?detach=true — detach the group from those targets, pause
//                                      recurring campaigns / disable daily batch left
//                                      with zero groups, then delete.
// Completed recurring campaigns and one-off/manual sends never block deletion.
router.delete('/:id', (req, res) => {
  const id     = Number(req.params.id);
  const detach = req.query.detach === 'true';
  if (!Groups.get(id)) return res.status(404).json({ error: 'Group not found' });

  const usage    = Groups.usages(id);
  const blocking = usage.recurring.length > 0 || usage.dailyBatch;
  if (blocking && !detach) {
    return res.status(409).json({
      error: 'Group is in use by active targeting and cannot be deleted. Retry with detach to remove it from these targets.',
      usages: usage,
    });
  }

  const result = db.transaction(() => {
    // Campaigns (active/paused) currently referencing this group — candidates to
    // pause if detaching empties their target set.
    const affected = db.prepare(`
      SELECT rc.id, rc.name FROM recurring_campaign_groups g
      JOIN recurring_campaigns rc ON rc.id = g.recurring_campaign_id
      WHERE g.group_id = ? AND rc.status IN ('active','paused')
    `).all(id);
    const dailyBatchReferenced = !!db.prepare('SELECT 1 FROM daily_batch_groups WHERE group_id = ?').get(id);

    // Clear ALL targeting references (RESTRICT FK requires this before delete).
    db.prepare('DELETE FROM recurring_campaign_groups WHERE group_id = ?').run(id);
    db.prepare('DELETE FROM daily_batch_groups WHERE group_id = ?').run(id);

    const paused = [];
    let dailyBatchDisabled = false;
    if (detach) {
      for (const rc of affected) {
        const remaining = db.prepare('SELECT COUNT(*) n FROM recurring_campaign_groups WHERE recurring_campaign_id = ?').get(rc.id).n;
        const mode      = db.prepare('SELECT target_mode FROM recurring_campaigns WHERE id = ?').get(rc.id).target_mode;
        if (mode === 'groups' && remaining === 0) {
          db.prepare("UPDATE recurring_campaigns SET status = 'paused' WHERE id = ? AND status = 'active'").run(rc.id);
          paused.push(rc);
        }
      }
      const cfg = db.prepare('SELECT target_mode FROM schedule_config WHERE id = 1').get();
      const dailyRemaining = db.prepare('SELECT COUNT(*) n FROM daily_batch_groups').get().n;
      if (dailyBatchReferenced && cfg?.target_mode === 'groups' && dailyRemaining === 0) {
        db.prepare('UPDATE schedule_config SET enabled = 0 WHERE id = 1').run();
        dailyBatchDisabled = true;
      }
    }

    Groups.remove(id); // membership cascades
    return { paused, dailyBatchDisabled };
  })();

  res.json({ ok: true, detached: detach, ...result });
});

// POST /api/groups/:id/members — add contacts { contactIds: [...] }
router.post('/:id/members', (req, res) => {
  const id = Number(req.params.id);
  if (!Groups.get(id)) return res.status(404).json({ error: 'Group not found' });
  const { contactIds } = req.body;
  if (!Array.isArray(contactIds) || contactIds.length === 0)
    return res.status(400).json({ error: 'contactIds must be a non-empty array' });
  const added = Groups.addMembers(id, contactIds.map(Number));
  res.json({ added, group: Groups.get(id) });
});

// DELETE /api/groups/:id/members — remove contacts { contactIds: [...] }
router.delete('/:id/members', (req, res) => {
  const id = Number(req.params.id);
  if (!Groups.get(id)) return res.status(404).json({ error: 'Group not found' });
  const { contactIds } = req.body;
  if (!Array.isArray(contactIds) || contactIds.length === 0)
    return res.status(400).json({ error: 'contactIds must be a non-empty array' });
  const removed = Groups.removeMembers(id, contactIds.map(Number));
  res.json({ removed, group: Groups.get(id) });
});

export default router;
