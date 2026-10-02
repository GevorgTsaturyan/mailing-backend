import express from 'express';
import db from '../db.js';
import { applyRecurringCampaigns } from '../scheduler.js';

const router = express.Router();

// Attach the targeted group ids (empty for 'all' mode) to each campaign row.
function withGroups(row) {
  if (!row) return row;
  const groupIds = db.prepare(
    'SELECT group_id FROM recurring_campaign_groups WHERE recurring_campaign_id = ? ORDER BY group_id'
  ).all(row.id).map((r) => r.group_id);
  return { ...row, groupIds };
}

// Validate target_mode + groupIds. Returns an error string, or null when valid.
// Empty group set in 'groups' mode is rejected — it must never fall through to all.
function validateTargeting(targetMode, groupIds) {
  if (targetMode != null && targetMode !== 'all' && targetMode !== 'groups')
    return "target_mode must be 'all' or 'groups'";
  if (targetMode === 'groups' && (!Array.isArray(groupIds) || groupIds.length === 0))
    return 'At least one group is required when target_mode is "groups"';
  return null;
}

// Replace a campaign's targeted groups with the given set (only existing groups).
function syncGroups(campaignId, groupIds) {
  db.prepare('DELETE FROM recurring_campaign_groups WHERE recurring_campaign_id = ?').run(campaignId);
  const ins    = db.prepare('INSERT OR IGNORE INTO recurring_campaign_groups (recurring_campaign_id, group_id) VALUES (?, ?)');
  const exists = db.prepare('SELECT 1 FROM contact_groups WHERE id = ?');
  for (const gid of [...new Set((groupIds || []).map(Number))]) {
    if (exists.get(gid)) ins.run(campaignId, gid);
  }
}

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM recurring_campaigns ORDER BY createdAt DESC').all().map(withGroups));
});

router.post('/', (req, res) => {
  const { name, templateName, subject, html, txt, startTime, endTime, initialCount, increasePercent, content_type, target_mode, groupIds, senderIdentityId, timezone } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!templateName && !subject) return res.status(400).json({ error: 'templateName or subject required' });
  if (content_type != null && content_type !== 'html' && content_type !== 'text')
    return res.status(400).json({ error: "content_type must be 'html' or 'text'" });
  const targetMode = target_mode || 'all';
  const targetingError = validateTargeting(targetMode, groupIds);
  if (targetingError) return res.status(400).json({ error: targetingError });

  const identityId = senderIdentityId
    ? (db.prepare('SELECT id FROM sender_identities WHERE id=? AND status=?').get(senderIdentityId, 'active')?.id ?? null)
    : null;

  const id = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO recurring_campaigns
        (name, templateName, subject, html, txt, content_type, startTime, endTime, initialCount, increasePercent, status, currentDay, target_mode, sender_identity_id, timezone, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?)
    `).run(
      name,
      templateName || null, subject || null, html || null, txt || null,
      content_type || 'html',
      startTime || '09:00', endTime || '17:00',
      initialCount || 10, increasePercent || 0,
      targetMode, identityId, timezone || 'UTC',
      new Date().toISOString()
    );
    const cid = result.lastInsertRowid;
    if (targetMode === 'groups') syncGroups(cid, groupIds);
    return cid;
  })();

  applyRecurringCampaigns();
  res.status(201).json(withGroups(db.prepare('SELECT * FROM recurring_campaigns WHERE id=?').get(id)));
});

router.put('/:id', (req, res) => {
  const id  = Number(req.params.id);
  const row = db.prepare('SELECT * FROM recurring_campaigns WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const { name, templateName, subject, html, txt, startTime, endTime, initialCount, increasePercent, content_type, target_mode, groupIds, senderIdentityId, timezone } = req.body;

  if (content_type != null && content_type !== 'html' && content_type !== 'text')
    return res.status(400).json({ error: "content_type must be 'html' or 'text'" });

  // Effective targeting after this edit (fall back to the stored mode/groups when
  // the field is omitted) so we can validate the resulting state.
  const nextMode   = target_mode !== undefined ? (target_mode || 'all') : row.target_mode;
  const nextGroups = groupIds !== undefined
    ? groupIds
    : db.prepare('SELECT group_id FROM recurring_campaign_groups WHERE recurring_campaign_id = ?').all(id).map((r) => r.group_id);
  const targetingError = validateTargeting(nextMode, nextGroups);
  if (targetingError) return res.status(400).json({ error: targetingError });

  const nextIdentityId = senderIdentityId !== undefined
    ? (senderIdentityId ? (db.prepare('SELECT id FROM sender_identities WHERE id=? AND status=?').get(senderIdentityId, 'active')?.id ?? null) : null)
    : row.sender_identity_id;

  db.transaction(() => {
    db.prepare(`
      UPDATE recurring_campaigns
      SET name=?, templateName=?, subject=?, html=?, txt=?, content_type=?,
          startTime=?, endTime=?, initialCount=?, increasePercent=?, target_mode=?, sender_identity_id=?, timezone=?
      WHERE id=?
    `).run(
      name          ?? row.name,
      templateName  !== undefined ? templateName  : row.templateName,
      subject       !== undefined ? subject       : row.subject,
      html          !== undefined ? html          : row.html,
      txt           !== undefined ? txt           : row.txt,
      content_type  !== undefined ? content_type  : row.content_type,
      startTime     ?? row.startTime,
      endTime       ?? row.endTime,
      initialCount  ?? row.initialCount,
      increasePercent ?? row.increasePercent,
      nextMode, nextIdentityId,
      timezone      !== undefined ? (timezone || 'UTC') : (row.timezone || 'UTC'),
      id
    );
    // Rewrite membership when mode/groups change; 'all' clears any stale rows.
    if (nextMode === 'groups') syncGroups(id, nextGroups);
    else if (target_mode !== undefined || groupIds !== undefined) syncGroups(id, []);
  })();

  applyRecurringCampaigns();
  res.json(withGroups(db.prepare('SELECT * FROM recurring_campaigns WHERE id=?').get(id)));
});

router.post('/:id/pause', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM recurring_campaigns WHERE id=?').get(id))
    return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE recurring_campaigns SET status='paused' WHERE id=?").run(id);
  applyRecurringCampaigns();
  res.json(db.prepare('SELECT * FROM recurring_campaigns WHERE id=?').get(id));
});

router.post('/:id/resume', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM recurring_campaigns WHERE id=?').get(id))
    return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE recurring_campaigns SET status='active' WHERE id=?").run(id);
  applyRecurringCampaigns();
  res.json(db.prepare('SELECT * FROM recurring_campaigns WHERE id=?').get(id));
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare('DELETE FROM recurring_campaigns WHERE id=?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  applyRecurringCampaigns();
  res.json({ ok: true });
});

export default router;
