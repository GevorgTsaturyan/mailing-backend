import cron from 'node-cron';
import db from './db.js';
import { sendCampaignEmail } from './mailer.js';

// ─── Shared send utility ────────────────────────────────────────────────────

async function sendToContact(contact, templateName, templateContent, scheduledSendId = null) {
  const logEntry = {
    date:            new Date().toISOString(),
    contactId:       contact.id,
    name:            `${contact.firstName} ${contact.lastName}`,
    email:           contact.email,
    template:        templateName || '(custom)',
    status:          'failed',
    previewUrl:      null,
    error:           null,
    subject:         null,
    body:            null,
    scheduledSendId: scheduledSendId,
  };

  try {
    const { previewUrl, subject, html } = await sendCampaignEmail({
      to: contact.email,
      templateName,
      templateContent,
      variables: { firstName: contact.firstName, lastName: contact.lastName },
    });

    db.prepare('UPDATE contacts SET status=?, sentAt=? WHERE id=?')
      .run('sent', logEntry.date, contact.id);

    logEntry.status     = 'sent';
    logEntry.previewUrl = previewUrl;
    logEntry.subject    = subject;
    logEntry.body       = html;
    console.log(`Scheduler: sent to ${contact.email} at ${logEntry.date}`);
  } catch (err) {
    db.prepare("UPDATE contacts SET status='failed' WHERE id=?").run(contact.id);
    logEntry.error = err.message;
    console.error(`Scheduler: failed for ${contact.email}: ${err.message}`);
  }

  db.prepare(`
    INSERT INTO send_log (date, contactId, name, email, template, status, previewUrl, error, subject, body, scheduledSendId)
    VALUES (@date, @contactId, @name, @email, @template, @status, @previewUrl, @error, @subject, @body, @scheduledSendId)
  `).run(logEntry);

  return logEntry.status;
}

// ─── Random-window planner (shared by daily batch + recurring campaigns) ─────

function scheduleRandomWindow(startTime, endTime, count, onFire) {
  const [startHour, startMin] = startTime.split(':').map(Number);
  const [endHour,   endMin  ] = endTime.split(':').map(Number);

  const startTotalMins = startHour * 60 + startMin;
  const endTotalMins   = endHour   * 60 + endMin;
  const rangeMinutes   = endTotalMins - startTotalMins;

  if (rangeMinutes <= 0 || count <= 0) return [];

  const numHours  = Math.ceil(rangeMinutes / 60);
  const base      = Math.floor(count / numHours);
  const remainder = count % numHours;

  const now      = Date.now();
  const todayUTC = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate()
  );

  const timers = [];

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
      timers.push(setTimeout(onFire, delay));
    }
  }

  return timers;
}

// ─── Daily batch ─────────────────────────────────────────────────────────────

let dayTimers = [];

function planDaySends() {
  dayTimers.forEach(t => clearTimeout(t));
  dayTimers = [];

  const cfg = db.prepare('SELECT * FROM schedule_config WHERE id = 1').get();
  if (!cfg.enabled || cfg.batchSize <= 0) return;

  const sendFn = () => {
    const contact = db.prepare(
      "SELECT * FROM contacts WHERE status='pending' ORDER BY id LIMIT 1"
    ).get();
    if (!contact) { console.log('Daily batch: no pending contacts'); return; }
    sendToContact(contact, cfg.template, null);
  };

  dayTimers = scheduleRandomWindow(cfg.startTime, cfg.endTime, cfg.batchSize, sendFn);
  console.log(`Daily batch: planned ${dayTimers.length} sends (${cfg.startTime}–${cfg.endTime} UTC)`);
}

// ─── Recurring campaigns ──────────────────────────────────────────────────────

const campaignTimers = {}; // id → [timer, ...]

function nextCount(campaign) {
  return Math.max(1, Math.round(
    campaign.initialCount * Math.pow(1 + campaign.increasePercent / 100, campaign.currentDay)
  ));
}

function planRecurringCampaigns() {
  const todayUTC = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  // Clear timers for campaigns that are no longer active
  const activeIds = new Set(
    db.prepare("SELECT id FROM recurring_campaigns WHERE status='active'").all().map(r => r.id)
  );
  for (const [idStr, timers] of Object.entries(campaignTimers)) {
    if (!activeIds.has(Number(idStr))) {
      timers.forEach(t => clearTimeout(t));
      delete campaignTimers[idStr];
    }
  }

  for (const campaign of db.prepare("SELECT * FROM recurring_campaigns WHERE status='active'").all()) {
    // Already planned today
    if (campaign.lastRunDate === todayUTC) continue;

    const count = nextCount(campaign);

    // Mark as planned for today before scheduling (so restart doesn't double-plan)
    db.prepare(
      'UPDATE recurring_campaigns SET lastRunDate=?, currentDay=? WHERE id=?'
    ).run(todayUTC, campaign.currentDay + 1, campaign.id);

    const templateContent = campaign.subject
      ? { subject: campaign.subject, html: campaign.html || '', txt: campaign.txt || '' }
      : null;

    const sendFn = () => {
      const c = db.prepare("SELECT * FROM contacts WHERE status='pending' ORDER BY id LIMIT 1").get();
      if (!c) {
        console.log(`Recurring "${campaign.name}": no more pending contacts — marking completed`);
        db.prepare("UPDATE recurring_campaigns SET status='completed' WHERE id=?").run(campaign.id);
        return;
      }
      sendToContact(c, campaign.templateName, templateContent);
    };

    const timers = scheduleRandomWindow(campaign.startTime, campaign.endTime, count, sendFn);
    campaignTimers[campaign.id] = timers;

    console.log(`Recurring "${campaign.name}" (day ${campaign.currentDay + 1}): planned ${timers.length} sends (${campaign.startTime}–${campaign.endTime} UTC)`);
  }
}

export function applyRecurringCampaigns() {
  planRecurringCampaigns();
}

// ─── One-off scheduled sends (per-minute check) ───────────────────────────────

async function checkScheduledSends() {
  const now = new Date().toISOString();
  const due = db.prepare(
    "SELECT * FROM scheduled_sends WHERE status='pending' AND scheduledAt <= ?"
  ).all(now);

  for (const task of due) {
    db.prepare("UPDATE scheduled_sends SET status='sent', sentAt=? WHERE id=?")
      .run(new Date().toISOString(), task.id);

    const contactIds    = JSON.parse(task.contactIds);
    const templateContent = task.subject
      ? { subject: task.subject, html: task.html || '', txt: task.txt || '' }
      : null;

    console.log(`Scheduled send #${task.id}: sending to ${contactIds.length} contact(s)`);

    let anyFailed = false;
    for (const contactId of contactIds) {
      const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(contactId);
      if (!contact) continue;
      if (await sendToContact(contact, task.templateName, templateContent, task.id) === 'failed')
        anyFailed = true;
    }

    if (anyFailed)
      db.prepare("UPDATE scheduled_sends SET status='failed' WHERE id=?").run(task.id);
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export function applyScheduleConfig() {
  planDaySends();
}

export function initScheduler() {
  planDaySends();
  planRecurringCampaigns();
  cron.schedule('0 0 * * *', () => { planDaySends(); planRecurringCampaigns(); }, { timezone: 'UTC' });
  cron.schedule('* * * * *', checkScheduledSends);
}
