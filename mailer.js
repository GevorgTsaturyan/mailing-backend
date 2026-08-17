import nodemailer from 'nodemailer';
import db from './db.js';
import { buildUnsubscribeUrl } from './services/unsubscribeToken.js';
import { isEmailSuppressed } from './services/SuppressionService.js';

let _transporter = null;
let _transporterConfig = null;

function smtpConfigHash(cfg) {
  return `${cfg.host}:${cfg.port}:${cfg.user}:${cfg.secure}`;
}

export function resetTransporter() {
  _transporter = null;
  _transporterConfig = null;
}

async function getTransporter() {
  const cfg = db.prepare('SELECT * FROM smtp_config WHERE id = 1').get();
  const hash = smtpConfigHash(cfg);

  if (_transporter && _transporterConfig === hash) return _transporter;

  if (cfg.host) {
    const transportOpts = {
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure === 1,
    };
    if (cfg.user && cfg.pass) {
      transportOpts.auth = { user: cfg.user, pass: cfg.pass };
    }
    _transporter = nodemailer.createTransport(transportOpts);
  } else {
    const testAccount = await nodemailer.createTestAccount();
    console.log('Using Ethereal test account:', testAccount.user);
    _transporter = nodemailer.createTransport({
      host: testAccount.smtp.host,
      port: testAccount.smtp.port,
      secure: testAccount.smtp.secure,
      auth: { user: testAccount.user, pass: testAccount.pass },
    });
  }

  _transporterConfig = hash;
  return _transporter;
}

function renderTemplate(content, variables) {
  return content.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? '');
}

export async function sendCampaignEmail({ to, templateName, templateContent, variables = {} }) {
  // Suppression gate — defense-in-depth even on this legacy/unused direct-send path.
  if (isEmailSuppressed(to)) {
    throw new Error(`refusing to send: ${to} is suppressed (unsubscribed)`);
  }

  let tmpl;
  if (templateContent) {
    tmpl = { subject: templateContent.subject || '', html: templateContent.html || '', txt: templateContent.txt || '' };
  } else {
    tmpl = db.prepare('SELECT * FROM templates WHERE name = ?').get(templateName || 'welcome');
    if (!tmpl) throw new Error(`Template "${templateName}" not found`);
  }

  const cfg = db.prepare('SELECT * FROM smtp_config WHERE id = 1').get();

  // Use the same token-based unsubscribe mechanism as the node pipeline: resolve
  // the contact by email → signed URL with no PII. (This direct-send path is
  // legacy/unused, but must never regenerate the old email-in-URL / mailto form.)
  const contact = db.prepare('SELECT id FROM contacts WHERE email = ?').get(String(to).toLowerCase());
  const unsubscribeUrl = contact ? buildUnsubscribeUrl(contact.id) : null;
  const mergedVars = {
    bonusAmount: '100',
    promoCode: 'WELCOME100',
    unsubscribeLink: unsubscribeUrl || '',
    ...variables,
  };

  const renderedSubject = renderTemplate(tmpl.subject, mergedVars);
  const renderedHtml    = renderTemplate(tmpl.html,    mergedVars);
  const renderedTxt     = renderTemplate(tmpl.txt,     mergedVars);

  const transporter = await getTransporter();
  const info = await transporter.sendMail({
    from: `"${cfg.fromName}" <${cfg.fromAddr}>`,
    to,
    replyTo: cfg.fromAddr,
    subject: renderedSubject,
    text:    renderedTxt,
    html:    renderedHtml,
    // HTTPS RFC 8058 one-click only. No mailto: (unroutable), no X-Mailer (spam signal).
    headers: unsubscribeUrl ? {
      'List-Unsubscribe':      `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    } : {},
  });

  const previewUrl = nodemailer.getTestMessageUrl(info) || null;
  if (previewUrl) console.log(`Preview for ${to}: ${previewUrl}`);
  return { info, previewUrl, subject: renderedSubject, html: renderedHtml };
}

export async function testSmtpConnection(cfg) {
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port),
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  await transport.verify();
}
