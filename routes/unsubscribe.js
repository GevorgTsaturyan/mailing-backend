// ─── Public unsubscribe endpoint (token-based, RFC 8058 one-click) ────────────
//
// Recipient-facing URL:  https://unsubscribe.serawin.net/u/<token>
// (served/proxied by the sending-domain infra → this backend; see UNSUBSCRIBE.md)
//
// Two flows, deliberately separated:
//
//   A. Visible body link (human):
//        GET  /u/<token>   → renders a confirmation page.  DOES NOT mutate.
//                            Safe against link scanners / prefetchers.
//        POST /u/<token>   → performs the unsubscribe (from the confirmation form).
//
//   B. RFC 8058 one-click (mailbox provider, e.g. Gmail/Yahoo):
//        POST /u/<token>   with Content-Type: application/x-www-form-urlencoded
//                          and body  List-Unsubscribe=One-Click
//                          → performs the unsubscribe, machine-readable 200 response.
//
// Suppression is idempotent and uses the single existing source of truth:
// contacts.status = 'unsubscribed'.  No second suppression store is introduced.

import express from 'express';
import db from '../db.js';
import { verifyToken } from '../services/unsubscribeToken.js';
import { cancelOutstandingJobsForContact } from '../services/SuppressionService.js';

const router = express.Router();

// Parse the one-click urlencoded body — scoped to this router only, so it never
// interferes with the JSON API routes.
router.use(express.urlencoded({ extended: false }));

// Resolve a token to a live contact row, or null if the token is invalid/tampered
// or the contact no longer exists.
function resolveContact(token) {
  const payload = verifyToken(token);
  if (!payload || payload.c == null) return null;
  return db.prepare('SELECT id, email, status FROM contacts WHERE id = ?').get(payload.c) || null;
}

// Idempotent, transactional suppression.  Returns nothing meaningful — the caller
// treats "already unsubscribed" and "just unsubscribed" identically (success).
function suppressContact(contactId) {
  db.prepare(
    "UPDATE contacts SET status = 'unsubscribed' WHERE id = ? AND status != 'unsubscribed'"
  ).run(contactId);
  // Proactively cancel any jobs queued before this unsubscribe so a job created
  // while subscribed can never be claimed and sent afterward.
  cancelOutstandingJobsForContact(contactId, 'unsubscribed');
}

function page(title, body) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 20px;text-align:center;color:#222">
${body}
</body></html>`;
}

// GET /u/:token — confirmation page ONLY. Never changes state (scanner-safe).
router.get('/u/:token', (req, res) => {
  const contact = resolveContact(req.params.token);
  if (!contact) {
    return res.status(404).send(page('Invalid link',
      '<h2>Invalid or expired unsubscribe link</h2><p>This link could not be verified.</p>'));
  }

  if (contact.status === 'unsubscribed') {
    return res.status(200).send(page('Already unsubscribed',
      '<h2>You are already unsubscribed</h2><p>You will not receive further campaigns.</p>'));
  }

  // Confirmation form posts back to the same URL. The mutation happens on POST.
  res.status(200).send(page('Confirm unsubscribe', `
    <h2>Unsubscribe from our emails?</h2>
    <p>Click the button below to stop receiving campaigns at this address.</p>
    <form method="POST" action="/u/${req.params.token}">
      <button type="submit"
        style="font-size:16px;padding:12px 28px;border:0;border-radius:6px;background:#d33;color:#fff;cursor:pointer">
        Unsubscribe
      </button>
    </form>
  `));
});

// POST /u/:token — performs the unsubscribe.
// Handles BOTH the confirmation-form submit and the RFC 8058 one-click POST
// (body: List-Unsubscribe=One-Click). Idempotent: repeated calls stay successful.
router.post('/u/:token', (req, res) => {
  const contact = resolveContact(req.params.token);
  if (!contact) {
    return res.status(404).send('Invalid or expired unsubscribe link');
  }

  suppressContact(contact.id);

  // RFC 8058 one-click: the provider sends `List-Unsubscribe=One-Click`.
  // Return a terse machine-readable 200 (no interactive page).
  const oneClick = req.body && req.body['List-Unsubscribe'] === 'One-Click';
  if (oneClick) {
    return res.status(200).json({ ok: true, unsubscribed: true });
  }

  res.status(200).send(page('Unsubscribed',
    '<h2>You have been unsubscribed</h2><p>You will no longer receive campaigns at this address.</p>'));
});

export default router;
