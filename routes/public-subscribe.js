// ─── Public subscribe API (server-to-server from the offers site) ─────────────
// POST /api/public/subscribe  { email, firstName?, source? } → { status }
// POST /api/public/confirm    { token }                      → { status }
// Auth: header X-Site-Key must equal OFFERS_SITE_KEY. Mounted before requireAuth.
// Disabled (503) when OFFERS_SITE_KEY is not set.

import express from 'express';
import crypto from 'node:crypto';
import { requestSubscription, confirmSubscription } from '../services/PublicSubscribeService.js';

const router = express.Router();

function requireSiteKey(req, res, next) {
  const expected = process.env.OFFERS_SITE_KEY || '';
  if (!expected) return res.status(503).json({ error: 'public subscribe API disabled' });
  const given = String(req.get('X-Site-Key') || '');
  const a = Buffer.from(given), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'invalid site key' });
  next();
}

router.use(requireSiteKey);

router.post('/subscribe', (req, res) => {
  try {
    res.json(requestSubscription(req.body || {}));
  } catch (err) {
    if (err.code === 'invalid_email')  return res.status(400).json({ error: 'invalid email' });
    if (err.code === 'not_configured') return res.status(503).json({ error: err.message });
    console.error('[public-subscribe] subscribe failed:', err.message);
    res.status(500).json({ error: 'subscribe failed' });
  }
});

router.post('/confirm', (req, res) => {
  try {
    res.json(confirmSubscription(req.body?.token));
  } catch (err) {
    console.error('[public-subscribe] confirm failed:', err.message);
    res.status(500).json({ error: 'confirm failed' });
  }
});

export default router;
