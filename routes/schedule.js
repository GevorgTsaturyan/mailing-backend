import express from 'express';
import db from '../db.js';
import { applyScheduleConfig } from '../scheduler.js';

const router = express.Router();

router.get('/', (req, res) => {
  const cfg = db.prepare('SELECT * FROM schedule_config WHERE id = 1').get();
  res.json({ ...cfg, enabled: cfg.enabled === 1 });
});

router.post('/', (req, res) => {
  const { startTime, endTime, batchSize, enabled, template } = req.body;

  const cfg = db.prepare('SELECT * FROM schedule_config WHERE id = 1').get();
  const updated = {
    enabled:   enabled   !== undefined ? (enabled ? 1 : 0) : cfg.enabled,
    startTime: startTime ?? cfg.startTime,
    endTime:   endTime   ?? cfg.endTime,
    batchSize: batchSize ?? cfg.batchSize,
    template:  template  ?? cfg.template,
  };

  db.prepare(
    'UPDATE schedule_config SET enabled=?, startTime=?, endTime=?, batchSize=?, template=? WHERE id=1'
  ).run(updated.enabled, updated.startTime, updated.endTime, updated.batchSize, updated.template);

  applyScheduleConfig();
  res.json({ ...updated, enabled: updated.enabled === 1 });
});

export default router;
