// ─── PublicSubscribeService ───────────────────────────────────────────────────
// Double opt-in for the public offers site (offers-site/). The site's backend
// calls these server-to-server (X-Site-Key); browsers never talk to the controller.
//
//   requestSubscription → store a pending row + queue ONE confirmation email
//                         (raw job through OFFERS_CONFIRM_IDENTITY_ID)
//   confirmSubscription → token valid → contact created/updated to 'pending'
//                         (eligible) and added to the "Website subscribers" group
//
// Nothing is added to contacts until the address owner clicks the link, so the
// list only ever contains confirmed opt-ins (best possible engagement signal).
// An address that unsubscribed earlier gets no confirmation email (suppression
// is respected); it is reported back so the site can show a neutral message.

import crypto from 'node:crypto';
import db from '../db.js';
import * as JobService from './JobService.js';
import { isEmailSuppressed } from './SuppressionService.js';

const TOKEN_TTL_MS     = 48 * 3600_000;
const RESEND_COOLDOWN  = 10 * 60_000;   // one confirmation email per address per 10 min
const EMAIL_RE         = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function config() {
  return {
    siteUrl:    (process.env.OFFERS_SITE_URL || '').replace(/\/+$/, ''),
    siteName:   process.env.OFFERS_SITE_NAME || 'our offers',
    identityId: Number(process.env.OFFERS_CONFIRM_IDENTITY_ID) || null,
    groupName:  process.env.OFFERS_SUBSCRIBERS_GROUP || 'Website subscribers',
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function confirmationBody({ firstName, link, siteName }) {
  const hi = firstName ? `Hi ${esc(firstName)},` : 'Hi,';
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f5f8;font-family:Arial,Helvetica,sans-serif;color:#222">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border-radius:10px">
<tr><td style="padding:28px 24px">
<p style="margin:0 0 14px;font-size:16px">${hi}</p>
<p style="margin:0 0 14px;font-size:15px;line-height:1.6">Please confirm that you want to receive emails from ${esc(siteName)}. If you did not sign up, just ignore this email and you will not hear from us.</p>
<p style="margin:24px 0;text-align:center"><a href="${esc(link)}" style="display:inline-block;background:#1f6feb;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 28px;border-radius:6px">Confirm my subscription</a></p>
<p style="margin:0;font-size:12px;color:#777;line-height:1.5">Or open this link: ${esc(link)}<br>The link expires in 48 hours.</p>
</td></tr></table></td></tr></table></body></html>`;
}

// Returns { status } where status ∈ 'sent' | 'already_subscribed' | 'suppressed' | 'cooldown'.
// Throws Error with .code = 'invalid_email' | 'not_configured' for caller errors.
export function requestSubscription({ email, firstName, source }, deps = {}) {
  const createJob = deps.createJob || JobService.createJob;
  const now       = deps.now ? deps.now() : new Date();
  const cfg       = config();

  const addr = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(addr) || addr.length > 254) throw Object.assign(new Error('invalid email'), { code: 'invalid_email' });
  if (!cfg.siteUrl || !cfg.identityId) throw Object.assign(new Error('offers subscription is not configured'), { code: 'not_configured' });

  const name = String(firstName || '').trim().slice(0, 60) || null;

  if (isEmailSuppressed(addr)) return { status: 'suppressed' };

  const contact = db.prepare('SELECT id FROM contacts WHERE email=?').get(addr);
  if (contact) {
    const group = db.prepare('SELECT id FROM contact_groups WHERE name=?').get(cfg.groupName);
    const member = group && db.prepare('SELECT 1 FROM contact_group_members WHERE group_id=? AND contact_id=?').get(group.id, contact.id);
    if (member) return { status: 'already_subscribed' };
  }

  const existing = db.prepare('SELECT * FROM pending_subscriptions WHERE email=?').get(addr);
  if (existing && now - new Date(existing.created_at) < RESEND_COOLDOWN) return { status: 'cooldown' };

  const token = crypto.randomBytes(24).toString('base64url');
  const link  = `${cfg.siteUrl}/confirm?token=${encodeURIComponent(token)}`;
  const job   = createJob({
    identity_id:  cfg.identityId,
    recipient:    addr,
    subject:      `Please confirm your subscription to ${cfg.siteName}`,
    body:         confirmationBody({ firstName: name, link, siteName: cfg.siteName }),
    content_type: 'html',
    priority:     10,
  });

  db.prepare(`
    INSERT INTO pending_subscriptions (email, firstName, source, token, job_id, created_at, expires_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(email) DO UPDATE SET firstName=excluded.firstName, source=excluded.source,
      token=excluded.token, job_id=excluded.job_id, created_at=excluded.created_at, expires_at=excluded.expires_at
  `).run(addr, name, source ? String(source).slice(0, 60) : null, token, job?.id ?? null,
         now.toISOString(), new Date(now.getTime() + TOKEN_TTL_MS).toISOString());

  return { status: 'sent' };
}

// Returns { status } where status ∈ 'confirmed' | 'invalid' | 'expired' | 'suppressed'.
export function confirmSubscription(token, deps = {}) {
  const now = deps.now ? deps.now() : new Date();
  const cfg = config();
  if (!token) return { status: 'invalid' };

  const row = db.prepare('SELECT * FROM pending_subscriptions WHERE token=?').get(String(token));
  if (!row) return { status: 'invalid' };
  if (new Date(row.expires_at) < now) {
    db.prepare('DELETE FROM pending_subscriptions WHERE id=?').run(row.id);
    return { status: 'expired' };
  }

  // Unsubscribed after requesting — the unsubscribe wins; never re-add.
  if (isEmailSuppressed(row.email)) {
    db.prepare('DELETE FROM pending_subscriptions WHERE id=?').run(row.id);
    return { status: 'suppressed' };
  }

  const ts = now.toISOString();
  db.transaction(() => {
    let contact = db.prepare('SELECT id, status FROM contacts WHERE email=?').get(row.email);
    if (!contact) {
      const id = db.prepare("INSERT INTO contacts (firstName, lastName, email, status) VALUES (?, '', ?, 'pending')")
        .run(row.firstName || '', row.email).lastInsertRowid;
      contact = { id };
    }
    db.prepare('INSERT OR IGNORE INTO contact_groups (name, description, createdAt) VALUES (?, ?, ?)')
      .run(cfg.groupName, 'Confirmed (double opt-in) signups from the offers website', ts);
    const group = db.prepare('SELECT id FROM contact_groups WHERE name=?').get(cfg.groupName);
    db.prepare('INSERT OR IGNORE INTO contact_group_members (group_id, contact_id, addedAt) VALUES (?,?,?)')
      .run(group.id, contact.id, ts);
    db.prepare('DELETE FROM pending_subscriptions WHERE id=?').run(row.id);
  })();

  return { status: 'confirmed' };
}
