import nodemailer from 'nodemailer';
import db from './db.js';

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

  if (cfg.host && cfg.user && cfg.pass) {
    _transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure === 1,
      auth: { user: cfg.user, pass: cfg.pass },
    });
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

export async function sendCampaignEmail({ to, templateName = 'welcome', variables = {} }) {
  const tmpl = db.prepare('SELECT * FROM templates WHERE name = ?').get(templateName);
  if (!tmpl) throw new Error(`Template "${templateName}" not found`);

  const cfg = db.prepare('SELECT * FROM smtp_config WHERE id = 1').get();

  const mergedVars = {
    bonusAmount: '100',
    promoCode: 'WELCOME100',
    unsubscribeLink: `http://localhost:3001/unsubscribe?email=${encodeURIComponent(to)}`,
    ...variables,
  };

  const transporter = await getTransporter();
  const info = await transporter.sendMail({
    from: `"${cfg.fromName}" <${cfg.fromAddr}>`,
    to,
    replyTo: cfg.fromAddr,
    subject: renderTemplate(tmpl.subject, mergedVars),
    text: renderTemplate(tmpl.txt, mergedVars),
    html: renderTemplate(tmpl.html, mergedVars),
    headers: {
      'List-Unsubscribe': `<mailto:unsubscribe@example.com>, <http://localhost:3001/unsubscribe?email=${encodeURIComponent(to)}>`,
      'X-Mailer': 'MailCampaignManager/2.0',
    },
  });

  const previewUrl = nodemailer.getTestMessageUrl(info) || null;
  if (previewUrl) console.log(`Preview for ${to}: ${previewUrl}`);
  return { info, previewUrl };
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
