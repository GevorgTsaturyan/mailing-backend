import express from 'express';
import db from '../db.js';

const router = express.Router();

router.get('/', (req, res) => {
  const log = db.prepare('SELECT * FROM send_log ORDER BY id DESC LIMIT 500').all();
  res.json(log);
});

router.delete('/', (req, res) => {
  db.prepare('DELETE FROM send_log').run();
  res.json({ ok: true });
});

export default router;
