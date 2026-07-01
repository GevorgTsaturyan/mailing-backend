import nodemailer from 'nodemailer';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, 'templates');

const FROM_ADDRESS = '"Casino Rewards" <noreply@example.com>';
const REPLY_TO = 'support@example.com';
const UNSUBSCRIBE_MAILTO = 'mailto:unsubscribe@example.com';

let transporterPromise = null;

function getTransporter() {
  if (!transporterPromise) {
    transporterPromise = (async () => {
      if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
        return nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT) || 587,
          secure: false,
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
      }
      const testAccount = await nodemailer.createTestAccount();
      console.log('Using auto-generated Ethereal test account:', testAccount.user);
      return nodemailer.createTransport({
        host: testAccount.smtp.host,
        port: testAccount.smtp.port,
        secure: testAccount.smtp.secure,
        auth: { user: testAccount.user, pass: testAccount.pass },
      });
    })();
  }
  return transporterPromise;
}

function renderTemplate(content, variables) {
  return content.replace(/\{\{(\w+)\}\}/g, (match, key) => variables[key] ?? match);
}

export async function loadTemplate(name) {
  const html = await fs.readFile(path.join(TEMPLATES_DIR, `${name}.html`), 'utf-8');
  const text = await fs.readFile(path.join(TEMPLATES_DIR, `${name}.txt`), 'utf-8');
  return { html, text };
}

export async function listTemplates() {
  const files = await fs.readdir(TEMPLATES_DIR);
  const names = new Set(
    files.filter((f) => f.endsWith('.html') || f.endsWith('.txt')).map((f) => f.replace(/\.(html|txt)$/, ''))
  );
  return [...names];
}

export async function sendCampaignEmail({ to, templateName = 'welcome', variables = {} }) {
  const { html, text } = await loadTemplate(templateName);

  const mergedVariables = {
    bonusAmount: '100',
    promoCode: 'WELCOME100',
    unsubscribeLink: '#unsubscribe',
    ...variables,
  };

  const renderedHtml = renderTemplate(html, mergedVariables);
  const renderedText = renderTemplate(text, mergedVariables);

  const transporter = await getTransporter();

  const info = await transporter.sendMail({
    from: FROM_ADDRESS,
    to,
    replyTo: REPLY_TO,
    subject: 'Your Welcome Bonus Has Arrived',
    text: renderedText,
    html: renderedHtml,
    headers: {
      'List-Unsubscribe': `<${UNSUBSCRIBE_MAILTO}>`,
      'X-Mailer': 'MailCampaignManager/1.0',
    },
  });

  const previewUrl = nodemailer.getTestMessageUrl(info);
  if (previewUrl) {
    console.log(`Preview URL for ${to}: ${previewUrl}`);
  }

  return { info, previewUrl };
}
