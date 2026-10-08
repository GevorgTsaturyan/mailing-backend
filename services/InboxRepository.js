// ─── InboxRepository ─────────────────────────────────────────────────────────
//
// CRUD layer for inbound_messages.
//
// Security: html_body is sanitized with xss before storage.
// The xss library uses an allowlist (tags + attributes) and strips all event
// handlers, <script>, <iframe>, <embed>, <object>, and <form> tags.
// Links are forced to open in a new tab (target=_blank rel=noopener).
//
// Deduplication: the DB has a UNIQUE partial index on message_id (non-null).
// insertMessage checks for an existing row before inserting; returns
// { id, duplicate: true } without writing if the message_id was already seen.

import db              from '../db.js';
import { filterXSS }  from 'xss';

// ── HTML sanitizer config ─────────────────────────────────────────────────────

const EMAIL_TAGS = {
  // Document structure (needed for full email HTML)
  html: [], head: [], body: ['style', 'bgcolor', 'class'],
  meta: ['charset', 'http-equiv', 'content', 'name'],
  title: [], style: [],
  // Text
  a:          ['href', 'name', 'target', 'rel', 'style', 'class'],
  b:          ['style', 'class'], strong: ['style', 'class'],
  i:          ['style', 'class'], em:     ['style', 'class'],
  u:          ['style', 'class'], s:      ['style', 'class'],
  strike:     ['style'], del: ['style'],
  sup: [], sub: [],
  small: ['style'], big: ['style'],
  br: [], hr: ['style'],
  p:          ['style', 'align', 'dir', 'class'],
  div:        ['style', 'align', 'dir', 'class'],
  span:       ['style', 'class'],
  h1: ['style', 'class'], h2: ['style', 'class'], h3: ['style', 'class'],
  h4: ['style', 'class'], h5: ['style', 'class'], h6: ['style', 'class'],
  ul: ['style', 'class'], ol: ['style', 'type', 'class'], li: ['style', 'class'],
  blockquote: ['style', 'class', 'cite'],
  pre:        ['style', 'class'], code: ['style', 'class'],
  font:       ['size', 'color', 'face', 'style'],
  center:     ['style'],
  // Images
  img: ['src', 'alt', 'width', 'height', 'style', 'class', 'border'],
  // Tables (essential for email layout)
  table:   ['style', 'border', 'cellpadding', 'cellspacing', 'width', 'bgcolor', 'align', 'class'],
  thead:   ['style', 'class'], tbody: ['style', 'class'], tfoot: ['style', 'class'],
  tr:      ['style', 'bgcolor', 'align', 'valign', 'class'],
  td:      ['style', 'colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'bgcolor', 'class'],
  th:      ['style', 'colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'class'],
  caption: ['style'],
  // Definition lists
  dl: ['style'], dt: ['style'], dd: ['style'],
};

function sanitizeHtml(html) {
  if (!html) return null;

  let clean = filterXSS(html, {
    whiteList:         EMAIL_TAGS,
    stripIgnoreTag:    true,
    stripIgnoreTagBody: ['script', 'noscript', 'iframe', 'object', 'embed', 'form'],

    onTagAttr: (tag, name, value) => {
      // Validate href: only allow safe schemes; reject javascript:, data:, vbscript:.
      // Return the attribute explicitly rather than `undefined` — xss default URL filter
      // strips cid: and other non-http(s) schemes even when we intend to allow them.
      if (tag === 'a' && name === 'href') {
        const v = value.trim().toLowerCase();
        if (/^(https?:|mailto:|cid:|#)/.test(v)) return `href="${value}"`;
        return '';  // strip unsafe href
      }

      // Validate img src: only http/https/cid/data:image/.
      // Explicit return required: xss default strips cid: values silently.
      if (tag === 'img' && name === 'src') {
        const v = value.trim().toLowerCase();
        if (/^(https?:|cid:|data:image\/)/.test(v)) return `src="${value}"`;
        return 'src=""';  // blank out unsafe src
      }
    },
  });

  // Force all links to open safely in a new tab.
  // The regex replaces `<a ` but not `<acronym` / `<article` etc.
  clean = clean.replace(/<a(\s)/gi, '<a target="_blank" rel="noopener noreferrer"$1');

  return clean;
}

// ── Repository methods ────────────────────────────────────────────────────────

export function insertMessage(serverId, msg) {
  // Dedup by message_id before inserting (the UNIQUE index is the hard backstop,
  // but checking first avoids bumping the rowid counter and gives us the existing id).
  if (msg.message_id) {
    const existing = db.prepare(
      'SELECT id FROM inbound_messages WHERE message_id = ?'
    ).get(msg.message_id);
    if (existing) return { id: existing.id, duplicate: true };
  }

  const htmlBody  = sanitizeHtml(msg.html_body || null);
  const textBody  = msg.text_body  || null;
  const snippet   = msg.snippet    || (textBody || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const toAddr    = msg.to_address || '';
  const mailbox   = msg.mailbox    || toAddr;
  const domain    = mailbox.includes('@') ? mailbox.split('@')[1] : '';

  const info = db.prepare(`
    INSERT INTO inbound_messages (
      message_id, from_address, from_name, to_address, reply_to,
      subject, text_body, html_body, received_at, is_read, read_at,
      mailbox, domain, in_reply_to, msg_references,
      server_id, snippet, has_attachments, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    msg.message_id    || null,
    msg.from_address  || '',
    msg.from_name     || null,
    toAddr,
    msg.reply_to      || null,
    msg.subject       || '',
    textBody,
    htmlBody,
    msg.received_at   || new Date().toISOString(),
    mailbox,
    domain,
    msg.in_reply_to   || null,
    msg.references    || msg.msg_references || null,
    Number(serverId)  || 0,
    snippet,
    msg.has_attachments ? 1 : 0,
    new Date().toISOString()
  );

  return { id: Number(info.lastInsertRowid), duplicate: false };
}

export function listMessages({
  page    = 1,
  limit   = 20,
  domain,
  mailbox,
  is_read,
  search,
} = {}) {
  const safeLimit  = Math.min(100, Math.max(1, Number(limit) || 20));
  const safePage   = Math.max(1, Number(page) || 1);
  const offset     = (safePage - 1) * safeLimit;

  const conditions = [];
  const params     = [];

  if (domain  != null && domain  !== '') { conditions.push('domain = ?');  params.push(domain); }
  if (mailbox != null && mailbox !== '') { conditions.push('mailbox = ?'); params.push(mailbox); }
  if (is_read === true  || is_read === 1)  { conditions.push('is_read = 1'); }
  if (is_read === false || is_read === 0)  { conditions.push('is_read = 0'); }
  if (search  != null && search  !== '') {
    conditions.push(
      '(from_address LIKE ? OR to_address LIKE ? OR subject LIKE ? OR text_body LIKE ?)'
    );
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { cnt: total } = db.prepare(
    `SELECT COUNT(*) as cnt FROM inbound_messages ${where}`
  ).get(...params);

  const messages = db.prepare(`
    SELECT id, message_id, from_address, from_name, to_address, reply_to,
           subject, received_at, is_read, read_at, mailbox, domain,
           snippet, has_attachments, created_at
    FROM inbound_messages ${where}
    ORDER BY received_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, safeLimit, offset);

  return { messages, total, page: safePage, limit: safeLimit };
}

export function getMessage(id) {
  return db.prepare('SELECT * FROM inbound_messages WHERE id = ?').get(id) || null;
}

export function markRead(id) {
  db.prepare(
    'UPDATE inbound_messages SET is_read = 1, read_at = ? WHERE id = ?'
  ).run(new Date().toISOString(), id);
}

export function markUnread(id) {
  db.prepare(
    'UPDATE inbound_messages SET is_read = 0, read_at = NULL WHERE id = ?'
  ).run(id);
}

// Permanently remove an inbound message. Returns the number of rows deleted.
export function deleteMessage(id) {
  return db.prepare('DELETE FROM inbound_messages WHERE id = ?').run(id).changes;
}

export function getUnreadCount({ domain, mailbox } = {}) {
  const conditions = ['is_read = 0'];
  const params     = [];
  if (domain  != null && domain  !== '') { conditions.push('domain = ?');  params.push(domain); }
  if (mailbox != null && mailbox !== '') { conditions.push('mailbox = ?'); params.push(mailbox); }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const { cnt } = db.prepare(
    `SELECT COUNT(*) as cnt FROM inbound_messages ${where}`
  ).get(...params);
  return cnt;
}
