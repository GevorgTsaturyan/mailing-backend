import express from 'express';
import db from '../db.js';
import { applyScheduleConfig } from '../scheduler.js';

const router = express.Router();

router.get('/', (req, res) => {
  const cfg = db.prepare('SELECT * FROM schedule_config WHERE id = 1').get();
  res.json({ ...cfg, enabled: cfg.enabled === 1 });
});

router.post('/', (req, res) => {
  const { time, batchSize, enabled, template } = req.body;

  const cfg = db.prepare('SELECT * FROM schedule_config WHERE id = 1').get();
  const updated = {
    enabled:   enabled   !== undefined ? (enabled ? 1 : 0) : cfg.enabled,
    time:      time      ?? cfg.time,
    batchSize: batchSize ?? cfg.batchSize,
    template:  template  ?? cfg.template,
  };

  db.prepare(
    'UPDATE schedule_config SET enabled=?, time=?, batchSize=?, template=? WHERE id=1'
  ).run(updated.enabled, updated.time, updated.batchSize, updated.template);

  applyScheduleConfig({ ...updated, enabled: updated.enabled === 1 });
  res.json({ ...updated, enabled: updated.enabled === 1 });
});

export default router;
