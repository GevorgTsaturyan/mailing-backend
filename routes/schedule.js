import express from 'express';
import { readJson, writeJson } from '../db.js';
import { applyScheduleConfig } from '../scheduler.js';

const router = express.Router();

router.get('/', async (req, res) => {
  const schedule = await readJson('schedule.json');
  res.json(schedule);
});

router.post('/', async (req, res) => {
  const { time, batchSize, enabled } = req.body;

  const schedule = await readJson('schedule.json');
  if (time !== undefined) schedule.time = time;
  if (batchSize !== undefined) schedule.batchSize = batchSize;
  if (enabled !== undefined) schedule.enabled = enabled;

  await writeJson('schedule.json', schedule);
  applyScheduleConfig(schedule);

  res.json(schedule);
});

export default router;
