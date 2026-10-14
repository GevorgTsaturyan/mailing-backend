// ─── /api/inbox ──────────────────────────────────────────────────────────────
// JWT-protected user-facing inbox endpoints.
// All routes require requireAuth (applied in index.js via app.use('/api', requireAuth)).

import express from 'express';
import {
  listMessages,
  getMessage,
  markRead,
  markUnread,
  deleteMessage,
  getUnreadCount,
  listAttachments,
  getAttachment,
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

// GET /api/inbox/:id — full message including html_body, text_body, attachments
router.get('/:id', (req, res) => {
  const msg = getMessage(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  res.json({ ...msg, attachments: listAttachments(msg.id) });
});

// GET /api/inbox/:id/attachments/:attachmentId — download one attachment.
// JWT-protected (like all /api/inbox routes); the frontend fetches it as a blob
// so the Authorization header is sent. The attachment is scoped to its message.
router.get('/:id/attachments/:attachmentId', (req, res) => {
  const msg = getMessage(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  const att = getAttachment(msg.id, req.params.attachmentId);
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  if (att.content == null) {
    return res.status(404).json({ error: 'Attachment content not stored (too large)' });
  }
  const name = String(att.filename || 'attachment');
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Type', att.content_type || 'application/octet-stream');
  res.setHeader('Content-Disposition',
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Content-Length', att.content.length);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.send(att.content);
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

// DELETE /api/inbox/:id — permanently remove an inbound message
router.delete('/:id', (req, res) => {
  if (!getMessage(req.params.id)) return res.status(404).json({ error: 'Message not found' });
  deleteMessage(req.params.id);
  res.json({ ok: true });
});

export default router;
