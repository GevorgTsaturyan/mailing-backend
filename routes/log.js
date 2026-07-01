import express from 'express';
import { readJson } from '../db.js';

const router = express.Router();

router.get('/', async (req, res) => {
  const sendLog = await readJson('sendLog.json');
  res.json(sendLog);
});

export default router;
