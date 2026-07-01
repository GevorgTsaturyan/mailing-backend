import express from 'express';
import db from '../db.js';
import { testSmtpConnection, resetTransporter } from '../mailer.js';

const router = express.Router();

router.get('/', (req, res) => {
  const cfg = db.prepare('SELECT * FROM smtp_config WHERE id = 1').get();
  // Never expose password
  res.json({ ...cfg, pass: cfg.pass ? '••••••••' : '' });
});

router.put('/', async (req, res) => {
  const { host, port, secure, user, pass, fromName, fromAddr } = req.body;
  const cfg = db.prepare('SELECT * FROM smtp_config WHERE id = 1').get();

  const updated = {
    host:     host     ?? cfg.host,
    port:     port     ?? cfg.port,
    secure:   secure   !== undefined ? (secure ? 1 : 0) : cfg.secure,
    user:     user     ?? cfg.user,
    pass:     (pass && pass !== '••••••••') ? pass : cfg.pass,
    fromName: fromName ?? cfg.fromName,
    fromAddr: fromAddr ?? cfg.fromAddr,
  };

  db.prepare(
    'UPDATE smtp_config SET host=?, port=?, secure=?, user=?, pass=?, fromName=?, fromAddr=? WHERE id=1'
  ).run(updated.host, updated.port, updated.secure, updated.user, updated.pass, updated.fromName, updated.fromAddr);

  resetTransporter();
  res.json({ ...updated, pass: updated.pass ? '••••••••' : '' });
});

// Accepts form values from body OR falls back to saved DB config
router.post('/test', async (req, res) => {
  const saved = db.prepare('SELECT * FROM smtp_config WHERE id = 1').get();
  const { host, port, secure, user, pass } = req.body;

  const cfg = {
    host:   host   || saved.host,
    port:   port   || saved.port,
    secure: secure !== undefined ? secure : saved.secure === 1,
    user:   user   || saved.user,
    // if body pass is placeholder or empty, use saved password
    pass:   (pass && pass !== '••••••••') ? pass : saved.pass,
  };

  if (!cfg.host || !cfg.user || !cfg.pass) {
    return res.status(400).json({ error: 'Fill in host, user, and password before testing' });
  }

  try {
    await testSmtpConnection(cfg);
    res.json({ ok: true, message: 'Connection successful' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
