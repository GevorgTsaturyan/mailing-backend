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
  let tmpl;
  if (templateContent) {
    tmpl = { subject: templateContent.subject || '', html: templateContent.html || '', txt: templateContent.txt || '' };
  } else {
    tmpl = db.prepare('SELECT * FROM templates WHERE name = ?').get(templateName || 'welcome');
    if (!tmpl) throw new Error(`Template "${templateName}" not found`);
  }

  const cfg = db.prepare('SELECT * FROM smtp_config WHERE id = 1').get();

  const baseUrl = process.env.APP_URL || 'http://localhost:3001';
  const mergedVars = {
    bonusAmount: '100',
    promoCode: 'WELCOME100',
    unsubscribeLink: `${baseUrl}/unsubscribe?email=${encodeURIComponent(to)}`,
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
    headers: {
      'List-Unsubscribe': `<mailto:unsubscribe@example.com>, <${baseUrl}/unsubscribe?email=${encodeURIComponent(to)}>`,
      'X-Mailer': 'MailCampaignManager/2.0',
    },
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
