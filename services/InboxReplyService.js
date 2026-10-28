// ─── InboxReplyService — answer an inbound message from the Inbox ────────────
//
// A reply is a normal canonical `jobs` row (no contact / campaign), so it rides
// the existing poll → claim → send → delivery-tracking pipeline on the node that
// owns the mailbox. Deliverability choices for a 1:1 reply:
//   • sent FROM the identity whose fromAddr is the mailbox the message arrived at
//     (same domain/IP/DKIM the correspondent already wrote to)
//   • plain text only, no tracking, no unsubscribe header (contact_id is NULL)
//   • In-Reply-To / References set so mail clients thread it with the original
//   • high priority so it is not stuck behind a campaign backlog

import db from '../db.js';
import * as JobService from './JobService.js';
import { getMessage } from './InboxRepository.js';

const REPLY_PRIORITY = 100;
const MAX_BODY = 50000;

// The sender identity that owns the mailbox the message was delivered to.
export function identityForMessage(msg) {
  const candidates = [msg.mailbox, msg.to_address]
    .filter(Boolean)
    .flatMap((v) => String(v).split(','))
    .map((v) => (v.match(/<([^>]+)>/)?.[1] ?? v).trim().toLowerCase())
    .filter(Boolean);
  for (const addr of candidates) {
    const row = db.prepare(
      "SELECT id, fromAddr, fromName FROM sender_identities WHERE lower(fromAddr) = ? AND status = 'active'"
    ).get(addr);
    if (row) return row;
  }
  return null;
}

export function replySubject(subject) {
  const s = String(subject || '').trim();
  return /^re:/i.test(s) ? s : `Re: ${s || '(no subject)'}`;
}

function replyRecipient(msg) {
  const raw = String(msg.reply_to || msg.from_address || '').split(',')[0];
  return (raw.match(/<([^>]+)>/)?.[1] ?? raw).trim();
}

// "On <date>, <sender> wrote:" + the original plain text, quoted with "> ".
export function quoteOriginal(msg) {
  const who  = msg.from_name ? `${msg.from_name} <${msg.from_address}>` : msg.from_address;
  const when = new Date(msg.received_at);
  const date = isNaN(when.getTime()) ? msg.received_at : when.toUTCString();
  const text = String(msg.text_body || msg.snippet || '').replace(/\r\n/g, '\n').trimEnd();
  if (!text) return '';
  return `\n\nOn ${date}, ${who} wrote:\n` + text.split('\n').map((l) => `> ${l}`).join('\n');
}

// References = original References + original Message-ID (RFC 5322 §3.6.4).
function threadHeaders(msg) {
  const mid = msg.message_id ? (msg.message_id.startsWith('<') ? msg.message_id : `<${msg.message_id}>`) : null;
  const refs = [msg.msg_references, mid].filter(Boolean).join(' ').trim();
  return { inReplyTo: mid, references: refs || null };
}

// Queue a reply. Returns { reply } or { error, status }.
export function sendReply(messageId, { body, includeQuote = true } = {}) {
  const msg = getMessage(messageId);
  if (!msg) return { error: 'Message not found', status: 404 };

  const text = String(body ?? '').trim();
  if (!text) return { error: 'Reply text is required', status: 400 };
  if (text.length > MAX_BODY) return { error: 'Reply is too long', status: 400 };

  const identity = identityForMessage(msg);
  if (!identity) {
    return { error: `No active sender identity owns ${msg.mailbox || msg.to_address} — cannot reply from this mailbox`, status: 400 };
  }
  const to = replyRecipient(msg);
  if (!to || !to.includes('@')) return { error: 'Original message has no valid sender address to reply to', status: 400 };

  const subject  = replySubject(msg.subject);
  const fullBody = text + (includeQuote ? quoteOriginal(msg) : '');
  const { inReplyTo, references } = threadHeaders(msg);

  let job;
  try {
    job = JobService.createJob({
      identity_id: identity.id, recipient: to, subject, body: fullBody,
      priority: REPLY_PRIORITY, content_type: 'text',
    });
  } catch (err) {
    return { error: err.message, status: 400 };
  }

  const now = new Date().toISOString();
  const id = db.transaction(() => {
    db.prepare('UPDATE jobs SET in_reply_to = ?, msg_references = ? WHERE id = ?').run(inReplyTo, references, job.id);
    db.prepare('UPDATE inbound_messages SET is_read = 1, read_at = COALESCE(read_at, ?) WHERE id = ?').run(now, msg.id);
    return db.prepare(`
      INSERT INTO inbox_replies (inbound_message_id, job_id, identity_id, from_address, to_address, subject, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(msg.id, job.id, identity.id, identity.fromAddr, to, subject, fullBody, now).lastInsertRowid;
  })();

  return { reply: listReplies(msg.id).find((r) => r.id === Number(id)) };
}

// Replies to a message, oldest first, with the job's live send/delivery state.
export function listReplies(messageId) {
  return db.prepare(`
    SELECT r.*, j.status AS job_status, j.delivery_status, j.error_message, j.finished_at
    FROM inbox_replies r
    LEFT JOIN jobs j ON j.id = r.job_id
    WHERE r.inbound_message_id = ?
    ORDER BY r.id
  `).all(messageId);
}
