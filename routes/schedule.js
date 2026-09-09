import express from 'express';
import db from '../db.js';
import { applyScheduleConfig } from '../scheduler.js';

const router = express.Router();

const dailyBatchGroupIds = () =>
  db.prepare('SELECT group_id FROM daily_batch_groups ORDER BY group_id').all().map((r) => r.group_id);

router.get('/', (req, res) => {
  const cfg = db.prepare('SELECT * FROM schedule_config WHERE id = 1').get();
  res.json({ ...cfg, enabled: cfg.enabled === 1, groupIds: dailyBatchGroupIds() });
});

router.post('/', (req, res) => {
  const { startTime, endTime, batchSize, enabled, template, target_mode, groupIds } = req.body;

  const cfg = db.prepare('SELECT * FROM schedule_config WHERE id = 1').get();

  const nextMode = target_mode !== undefined ? (target_mode || 'all') : cfg.target_mode;
  if (nextMode !== 'all' && nextMode !== 'groups')
    return res.status(400).json({ error: "target_mode must be 'all' or 'groups'" });
  const nextGroups  = groupIds !== undefined ? groupIds : dailyBatchGroupIds();
  const wantEnabled = enabled  !== undefined ? (enabled ? 1 : 0) : cfg.enabled;
  // A group-mode batch must have at least one group whenever it is (or stays) enabled —
  // an empty group set must never fall through to "all contacts".
  if (nextMode === 'groups' && wantEnabled && (!Array.isArray(nextGroups) || nextGroups.length === 0))
    return res.status(400).json({ error: 'At least one group is required to enable a group-targeted daily batch' });

  const updated = {
    enabled:     wantEnabled,
    startTime:   startTime ?? cfg.startTime,
    endTime:     endTime   ?? cfg.endTime,
    batchSize:   batchSize ?? cfg.batchSize,
    template:    template  ?? cfg.template,
    target_mode: nextMode,
  };

  db.transaction(() => {
    db.prepare(
      'UPDATE schedule_config SET enabled=?, startTime=?, endTime=?, batchSize=?, template=?, target_mode=? WHERE id=1'
    ).run(updated.enabled, updated.startTime, updated.endTime, updated.batchSize, updated.template, updated.target_mode);

    if (target_mode !== undefined || groupIds !== undefined) {
      db.prepare('DELETE FROM daily_batch_groups').run();
      if (nextMode === 'groups') {
        const ins    = db.prepare('INSERT OR IGNORE INTO daily_batch_groups (group_id) VALUES (?)');
        const exists = db.prepare('SELECT 1 FROM contact_groups WHERE id = ?');
        for (const gid of [...new Set((nextGroups || []).map(Number))]) if (exists.get(gid)) ins.run(gid);
      }
    }
  })();

  applyScheduleConfig();
  res.json({ ...updated, enabled: updated.enabled === 1, groupIds: dailyBatchGroupIds() });
});

export default router;
