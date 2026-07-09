import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function seedDevData() {
  if (process.env.NODE_ENV === 'production') return;

  // ── Templates ─────────────────────────────────────────────────────────────
  // welcome — needed for any send; seed from file if missing
  if (!db.prepare("SELECT 1 FROM templates WHERE name='welcome'").get()) {
    const dir = path.join(__dirname, 'templates');
    db.prepare('INSERT OR IGNORE INTO templates (name, subject, html, txt) VALUES (?, ?, ?, ?)').run(
      'welcome',
      'Your Welcome Bonus Has Arrived',
      fs.existsSync(path.join(dir, 'welcome.html')) ? fs.readFileSync(path.join(dir, 'welcome.html'), 'utf-8') : '',
      fs.existsSync(path.join(dir, 'welcome.txt'))  ? fs.readFileSync(path.join(dir, 'welcome.txt'),  'utf-8') : '',
    );
  }

  // promo — a second template so the template list isn't empty
  if (!db.prepare("SELECT 1 FROM templates WHERE name='promo'").get()) {
    db.prepare('INSERT OR IGNORE INTO templates (name, subject, html, txt) VALUES (?, ?, ?, ?)').run(
      'promo',
      'Special Offer for {{firstName}}!',
      `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
<h2 style="color:#1a1a2e">Hi {{firstName}},</h2>
<p>We have a <strong>special offer</strong> just for you.</p>
<table width="100%" style="background:#f4f4f7;border-radius:6px;padding:20px;text-align:center">
  <tr><td>
    <p style="margin:0 0 8px;font-size:14px;color:#555">Your Bonus</p>
    <p style="font-size:28px;font-weight:bold;color:#1a1a2e;margin:0 0 12px">\${{bonusAmount}}</p>
    <p style="font-size:14px;color:#555;margin:0 0 4px">Promo Code</p>
    <p style="font-size:20px;font-weight:bold;letter-spacing:2px;color:#e94560;margin:0">{{promoCode}}</p>
  </td></tr>
</table>
<p style="margin-top:24px;font-size:12px;color:#999"><a href="{{unsubscribeLink}}">Unsubscribe</a></p>
</body></html>`,
      `Hi {{firstName}},\n\nSpecial offer — use code {{promoCode}} to claim \${{bonusAmount}}.\n\nUnsubscribe: {{unsubscribeLink}}`
    );
  }

  // ── Contacts ──────────────────────────────────────────────────────────────
  if (db.prepare('SELECT COUNT(*) as n FROM contacts').get().n === 0) {
    const ins = db.prepare(
      'INSERT OR IGNORE INTO contacts (firstName, lastName, email, status, sentAt) VALUES (?, ?, ?, ?, ?)'
    );
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    ins.run('Alice',  'Johnson', 'alice@example.com',  'sent',         twoDaysAgo);
    ins.run('Bob',    'Smith',   'bob@example.com',    'pending',      null);
    ins.run('Carol',  'Davis',   'carol@example.com',  'failed',       null);
    ins.run('David',  'Wilson',  'david@example.com',  'unsubscribed', null);
  }

  // ── Send log ──────────────────────────────────────────────────────────────
  if (db.prepare('SELECT COUNT(*) as n FROM send_log').get().n === 0) {
    const ins = db.prepare(`
      INSERT INTO send_log (date, contactId, name, email, template, status, previewUrl, error, subject, body)
      VALUES (@date, @contactId, @name, @email, @template, @status, @previewUrl, @error, @subject, @body)
    `);

    ins.run({
      date: new Date(Date.now() - 3 * 86400000).toISOString(),
      contactId: 1, name: 'Alice Johnson', email: 'alice@example.com',
      template: 'welcome', status: 'sent',
      previewUrl: 'https://ethereal.email/message/dev-preview-001',
      error: null,
      subject: 'Your Welcome Bonus Has Arrived',
      body: '<p style="font-family:Arial,sans-serif">Hi Alice,</p><p>Welcome aboard! Your <strong>$100</strong> bonus is ready. Use code <strong>WELCOME100</strong> to claim it.</p>',
    });

    ins.run({
      date: new Date(Date.now() - 2 * 86400000).toISOString(),
      contactId: 3, name: 'Carol Davis', email: 'carol@example.com',
      template: 'welcome', status: 'failed',
      previewUrl: null,
      error: 'Connection refused: SMTP server at localhost:25 not reachable',
      subject: null, body: null,
    });

    ins.run({
      date: new Date(Date.now() - 86400000).toISOString(),
      contactId: 1, name: 'Alice Johnson', email: 'alice@example.com',
      template: 'promo', status: 'sent',
      previewUrl: null, error: null,
      subject: 'Special Offer for Alice!',
      body: '<p style="font-family:Arial,sans-serif">Hi Alice,</p><p>Special offer — use code <strong>WELCOME100</strong> to claim your <strong>$100</strong> bonus.</p>',
    });
  }

  // ── Recurring campaigns ───────────────────────────────────────────────────
  if (db.prepare('SELECT COUNT(*) as n FROM recurring_campaigns').get().n === 0) {
    db.prepare(`
      INSERT INTO recurring_campaigns
        (name, templateName, subject, html, txt, startTime, endTime, initialCount, increasePercent, status, currentDay, lastRunDate, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'New User Welcome Series', 'welcome', null, null, null,
      '09:00', '17:00', 5, 10.0,
      'active', 3, null,
      new Date(Date.now() - 7 * 86400000).toISOString()
    );
  }

  // ── Scheduled sends ───────────────────────────────────────────────────────
  if (db.prepare('SELECT COUNT(*) as n FROM scheduled_sends').get().n === 0) {
    db.prepare(`
      INSERT INTO scheduled_sends (label, contactIds, templateName, subject, html, txt, scheduledAt, status, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'VIP Batch July',
      JSON.stringify([2]),
      'welcome', null, null, null,
      new Date(Date.now() + 2 * 86400000).toISOString(),
      'pending',
      new Date().toISOString()
    );
  }

  console.log('[dev] Seed data loaded');
}
