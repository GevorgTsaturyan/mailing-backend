import cron from 'node-cron';
import db from './db.js';
import { sendCampaignEmail } from './mailer.js';

let currentTask = null;

function timeToCron(time) {
  const [hour, minute] = time.split(':').map(Number);
  return `${minute} ${hour} * * *`;
}

async function runDailyBatch() {
  const cfg = db.prepare('SELECT * FROM schedule_config WHERE id = 1').get();
  const pending = db.prepare(
    "SELECT * FROM contacts WHERE status = 'pending' ORDER BY id LIMIT ?"
  ).all(cfg.batchSize);

  console.log(`Scheduler: sending to ${pending.length} pending contact(s) with template "${cfg.template}"`);

  const insertLog = db.prepare(`
    INSERT INTO send_log (date, contactId, name, email, template, status, previewUrl, error)
    VALUES (@date, @contactId, @name, @email, @template, @status, @previewUrl, @error)
  `);

  for (const contact of pending) {
    const logEntry = {
      date: new Date().toISOString(),
      contactId: contact.id,
      name: `${contact.firstName} ${contact.lastName}`,
      email: contact.email,
      template: cfg.template,
      status: 'failed',
      previewUrl: null,
      error: null,
    };

    try {
      const { previewUrl } = await sendCampaignEmail({
        to: contact.email,
        templateName: cfg.template,
        variables: { firstName: contact.firstName, lastName: contact.lastName },
      });

      db.prepare('UPDATE contacts SET status=?, sentAt=? WHERE id=?')
        .run('sent', logEntry.date, contact.id);

      logEntry.status = 'sent';
      logEntry.previewUrl = previewUrl;
    } catch (err) {
      db.prepare("UPDATE contacts SET status='failed' WHERE id=?").run(contact.id);
      logEntry.error = err.message;
    }

    insertLog.run(logEntry);
  }
}

export function applyScheduleConfig(schedule) {
  if (currentTask) { currentTask.stop(); currentTask = null; }
  if (!schedule.enabled) return;
  currentTask = cron.schedule(timeToCron(schedule.time), runDailyBatch);
  console.log(`Scheduler: enabled, runs daily at ${schedule.time}, batch=${schedule.batchSize}`);
}

export function initScheduler() {
  const cfg = db.prepare('SELECT * FROM schedule_config WHERE id = 1').get();
  applyScheduleConfig({ ...cfg, enabled: cfg.enabled === 1 });
}
