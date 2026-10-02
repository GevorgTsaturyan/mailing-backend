// ─── /api/inbox ──────────────────────────────────────────────────────────────
// JWT-protected user-facing inbox endpoints.
// All routes require requireAuth (applied in index.js via app.use('/api', requireAuth)).

import express from 'express';
import {
  listMessages,
  getMessage,
  markRead,
  markUnread,
  getUnreadCount,
} from '../services/InboxRepository.js';

const router = express.Router();

// GET /api/inbox
// Query params: page, limit, domain, mailbox, read (true|false), search
router.get('/', (req, res) => {
  const { page, limit, domain, mailbox, read, search } = req.query;

  const is_read =
    read === 'true'  ? true  :
    read === 'false' ? false :
    undefined;

  const result = listMessages({
    page:    page    ? Number(page)    : 1,
    limit:   limit   ? Number(limit)   : 20,
    domain:  domain  || undefined,
    mailbox: mailbox || undefined,
    is_read,
    search:  search  || undefined,
  });

  res.json(result);
});

// GET /api/inbox/stats — unread count (with optional domain/mailbox filter)
router.get('/stats', (req, res) => {
  const { domain, mailbox } = req.query;
  const unread = getUnreadCount({
    domain:  domain  || undefined,
    mailbox: mailbox || undefined,
  });
  res.json({ unread });
});

// GET /api/inbox/:id — full message including html_body, text_body
router.get('/:id', (req, res) => {
  const msg = getMessage(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  res.json(msg);
});

// PATCH /api/inbox/:id/read
router.patch('/:id/read', (req, res) => {
  if (!getMessage(req.params.id)) return res.status(404).json({ error: 'Message not found' });
  markRead(req.params.id);
  res.json({ ok: true });
});

// PATCH /api/inbox/:id/unread
router.patch('/:id/unread', (req, res) => {
  if (!getMessage(req.params.id)) return res.status(404).json({ error: 'Message not found' });
  markUnread(req.params.id);
  res.json({ ok: true });
});

export default router;
