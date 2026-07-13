import cron from 'node-cron';
import db from './db.js';

// ─── Queue utility ────────────────────────────────────────────────────────────
// Instead of calling Nodemailer directly, we insert a send_job row.
// A mail-node polls GET /api/nodes/jobs and handles actual delivery.

function pickActiveIdentity() {
  return db.prepare("SELECT id FROM sender_identities WHERE status='active' ORDER BY id LIMIT 1").get()?.id || null;
}

function resolveTemplate(templateName, templateContent) {
  if (templateContent?.subject) return templateContent;
  if (templateName) {
    const t = db.prepare('SELECT subject, html, txt FROM templates WHERE name=?').get(templateName);
    if (t) return t;
  }
  return { subject: null, html: null, txt: null };
}

function queueJobForContact(contact, templateName, templateContent, scheduledFor = null, scheduledSendId = null, senderIdentityId = null) {
  const identityId = senderIdentityId ?? pickActiveIdentity();
  const tmpl = resolveTemplate(templateName, templateContent);
  const now  = new Date().toISOString();

  const logRow = db.prepare(`
    INSERT INTO send_log (date, contactId, name, email, template, status, subject, body, scheduledSendId, senderIdentityId)
    VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
  `).run(
    now, contact.id,
    `${contact.firstName} ${contact.lastName}`,
    contact.email,
    templateName || '(custom)',
    tmpl.subject, tmpl.html,
    scheduledSendId, identityId
  );

  const jobRow = db.prepare(`
    INSERT INTO send_jobs
      (senderIdentityId, contactId, email, firstName, lastName,
       templateName, subject, html, txt, status, scheduledFor, createdAt, sendLogId, scheduledSendId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
  `).run(
    identityId,
    contact.id, contact.email, contact.firstName, contact.lastName,
    templateName || null, tmpl.subject, tmpl.html, tmpl.txt,
    scheduledFor, now, logRow.lastInsertRowid, scheduledSendId
  );

  db.prepare('UPDATE send_log SET sendJobId=? WHERE id=?')
    .run(jobRow.lastInsertRowid, logRow.lastInsertRowid);

  db.prepare("UPDATE contacts SET status='queued' WHERE id=?").run(contact.id);
}

// ─── Random timestamps in a UTC window (returns sorted ISO strings) ───────────

function randomTimesInWindow(startTime, endTime, count) {
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  const startMins = sh * 60 + sm;
  const endMins   = eh * 60 + em;
  const rangeMins = endMins - startMins;

  if (rangeMins <= 0 || count <= 0) return [];

  const now      = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const times    = [];

  for (let i = 0; i < count; i++) {
    const offset  = Math.floor(Math.random() * rangeMins);
    const totalM  = startMins + offset;
    const h       = Math.floor(totalM / 60);
    const m       = totalM % 60;
    const s       = Math.floor(Math.random() * 60);
    times.push(new Date(todayUTC + (h * 3600 + m * 60 + s) * 1000).toISOString());
  }

  return times.sort();
}

// ─── Daily batch ─────────────────────────────────────────────────────────────

function planDaySends() {
  const cfg = db.prepare('SELECT * FROM schedule_config WHERE id=1').get();
  if (!cfg.enabled || cfg.batchSize <= 0) return;

  const times    = randomTimesInWindow(cfg.startTime, cfg.endTime, cfg.batchSize);
  const contacts = db.prepare(
    "SELECT * FROM contacts WHERE status='pending' ORDER BY id LIMIT ?"
  ).all(times.length);

  for (let i = 0; i < contacts.length; i++) {
    queueJobForContact(contacts[i], cfg.template, null, times[i]);
  }

  console.log(`Daily batch: queued ${contacts.length} jobs (${cfg.startTime}–${cfg.endTime} UTC)`);
}

// ─── Recurring campaigns ──────────────────────────────────────────────────────

function nextCount(campaign) {
  return Math.max(1, Math.round(
    campaign.initialCount * Math.pow(1 + campaign.increasePercent / 100, campaign.currentDay)
  ));
}

function planRecurringCampaigns() {
  const todayUTC = new Date().toISOString().split('T')[0];

  for (const campaign of db.prepare("SELECT * FROM recurring_campaigns WHERE status='active'").all()) {
    if (campaign.lastRunDate === todayUTC) continue;

    const count = nextCount(campaign);
    const times = randomTimesInWindow(campaign.startTime, campaign.endTime, count);

    const contacts = db.prepare(
      "SELECT * FROM contacts WHERE status='pending' ORDER BY id LIMIT ?"
    ).all(times.length);

    if (contacts.length === 0) {
      console.log(`Recurring "${campaign.name}": no pending contacts — completed`);
      db.prepare("UPDATE recurring_campaigns SET status='completed' WHERE id=?").run(campaign.id);
      continue;
    }

    const templateContent = campaign.subject
      ? { subject: campaign.subject, html: campaign.html || '', txt: campaign.txt || '' }
      : null;

    for (let i = 0; i < contacts.length; i++) {
      queueJobForContact(contacts[i], campaign.templateName, templateContent, times[i]);
    }

    db.prepare('UPDATE recurring_campaigns SET lastRunDate=?, currentDay=? WHERE id=?')
      .run(todayUTC, campaign.currentDay + 1, campaign.id);

    console.log(`Recurring "${campaign.name}" (day ${campaign.currentDay + 1}): queued ${contacts.length} jobs`);
  }
}

export function applyRecurringCampaigns() {
  planRecurringCampaigns();
}

// ─── One-off scheduled sends (per-minute check) ───────────────────────────────

function checkScheduledSends() {
  const now = new Date().toISOString();
  const due = db.prepare(
    "SELECT * FROM scheduled_sends WHERE status='pending' AND scheduledAt <= ?"
  ).all(now);

  for (const task of due) {
    db.prepare("UPDATE scheduled_sends SET status='sent', sentAt=? WHERE id=?")
      .run(new Date().toISOString(), task.id);

    const contactIds = JSON.parse(task.contactIds);
    const templateContent = task.subject
      ? { subject: task.subject, html: task.html || '', txt: task.txt || '' }
      : null;

    console.log(`Scheduled send #${task.id}: queuing ${contactIds.length} job(s)`);

    for (const contactId of contactIds) {
      const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(contactId);
      if (!contact) continue;
      queueJobForContact(contact, task.templateName, templateContent, null, task.id);
    }
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export function applyScheduleConfig() {
  planDaySends();
}

export function initScheduler() {
  planDaySends();
  planRecurringCampaigns();
  cron.schedule('0 0 * * *', () => { planDaySends(); planRecurringCampaigns(); }, { timezone: 'UTC' });
  cron.schedule('* * * * *', checkScheduledSends);
}
