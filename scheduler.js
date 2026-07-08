import cron from 'node-cron';
import db from './db.js';
import { sendCampaignEmail } from './mailer.js';

// ─── Shared send utility ────────────────────────────────────────────────────

async function sendToContact(contact, templateName, templateContent) {
  const logEntry = {
    date:       new Date().toISOString(),
    contactId:  contact.id,
    name:       `${contact.firstName} ${contact.lastName}`,
    email:      contact.email,
    template:   templateName || '(custom)',
    status:     'failed',
    previewUrl: null,
    error:      null,
  };

  try {
    const { previewUrl } = await sendCampaignEmail({
      to: contact.email,
      templateName,
      templateContent,
      variables: { firstName: contact.firstName, lastName: contact.lastName },
    });

    db.prepare('UPDATE contacts SET status=?, sentAt=? WHERE id=?')
      .run('sent', logEntry.date, contact.id);

    logEntry.status     = 'sent';
    logEntry.previewUrl = previewUrl;
    console.log(`Scheduler: sent to ${contact.email} at ${logEntry.date}`);
  } catch (err) {
    db.prepare("UPDATE contacts SET status='failed' WHERE id=?").run(contact.id);
    logEntry.error = err.message;
    console.error(`Scheduler: failed for ${contact.email}: ${err.message}`);
  }

  db.prepare(`
    INSERT INTO send_log (date, contactId, name, email, template, status, previewUrl, error)
    VALUES (@date, @contactId, @name, @email, @template, @status, @previewUrl, @error)
  `).run(logEntry);

  return logEntry.status;
}

// ─── Daily batch (random window) ────────────────────────────────────────────

let dayTimers = [];

function clearDayTimers() {
  dayTimers.forEach(t => clearTimeout(t));
  dayTimers = [];
}

async function sendNextPending(templateName) {
  const contact = db.prepare(
    "SELECT * FROM contacts WHERE status = 'pending' ORDER BY id LIMIT 1"
  ).get();
  if (!contact) { console.log('Scheduler: no pending contacts left'); return; }
  await sendToContact(contact, templateName, null);
}

function planDaySends() {
  clearDayTimers();

  const cfg = db.prepare('SELECT * FROM schedule_config WHERE id = 1').get();
  if (!cfg.enabled || cfg.batchSize <= 0) return;

  const [startHour, startMin] = cfg.startTime.split(':').map(Number);
  const [endHour,   endMin  ] = cfg.endTime.split(':').map(Number);

  const startTotalMins = startHour * 60 + startMin;
  const endTotalMins   = endHour   * 60 + endMin;
  const rangeMinutes   = endTotalMins - startTotalMins;

  if (rangeMinutes <= 0) {
    console.log('Scheduler: startTime must be before endTime — skipping');
    return;
  }

  const numHours  = Math.ceil(rangeMinutes / 60);
  const base      = Math.floor(cfg.batchSize / numHours);
  const remainder = cfg.batchSize % numHours;

  const now      = Date.now();
  const todayUTC = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate()
  );

  let totalScheduled = 0;

  for (let h = 0; h < numHours; h++) {
    const hourStartMins  = startTotalMins + h * 60;
    const hourEndMins    = Math.min(startTotalMins + (h + 1) * 60, endTotalMins);
    const emailsThisHour = base + (h < remainder ? 1 : 0);

    for (let i = 0; i < emailsThisHour; i++) {
      const randMin  = hourStartMins + Math.floor(Math.random() * (hourEndMins - hourStartMins));
      const randSec  = Math.floor(Math.random() * 60);
      const sendTime = todayUTC + randMin * 60_000 + randSec * 1_000;
      const delay    = sendTime - now;

      if (delay <= 0) continue;

      const timer = setTimeout(() => sendNextPending(cfg.template), delay);
      dayTimers.push(timer);
      totalScheduled++;
    }
  }

  console.log(
    `Scheduler: planned ${totalScheduled} daily sends between ${cfg.startTime}–${cfg.endTime} UTC`
  );
}

// ─── Individual scheduled sends (per-minute check) ──────────────────────────

async function checkScheduledSends() {
  const now = new Date().toISOString();
  const due = db.prepare(
    "SELECT * FROM scheduled_sends WHERE status='pending' AND scheduledAt <= ?"
  ).all(now);

  for (const task of due) {
    db.prepare(
      "UPDATE scheduled_sends SET status='sent', sentAt=? WHERE id=?"
    ).run(new Date().toISOString(), task.id);

    const contactIds = JSON.parse(task.contactIds);
    const templateContent = task.subject
      ? { subject: task.subject, html: task.html || '', txt: task.txt || '' }
      : null;

    console.log(
      `Scheduled send #${task.id}: sending to ${contactIds.length} contact(s) [${task.label || 'no label'}]`
    );

    let anyFailed = false;
    for (const contactId of contactIds) {
      const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
      if (!contact) continue;
      const status = await sendToContact(contact, task.templateName, templateContent);
      if (status === 'failed') anyFailed = true;
    }

    if (anyFailed) {
      db.prepare(
        "UPDATE scheduled_sends SET status='failed' WHERE id=?"
      ).run(task.id);
    }
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

export function applyScheduleConfig() {
  planDaySends();
}

export function initScheduler() {
  planDaySends();
  cron.schedule('0 0 * * *', planDaySends,         { timezone: 'UTC' });
  cron.schedule('* * * * *', checkScheduledSends);
}
