import cron from 'node-cron';
import { readJson, writeJson } from './db.js';
import { sendCampaignEmail } from './mailer.js';

let currentTask = null;

function timeToCronExpression(time) {
  const [hour, minute] = time.split(':').map(Number);
  return `${minute} ${hour} * * *`;
}

async function runDailyBatch() {
  const schedule = await readJson('schedule.json');
  const contacts = await readJson('contacts.json');
  const sendLog = await readJson('sendLog.json');

  const pending = contacts.filter((c) => c.status === 'pending').slice(0, schedule.batchSize);

  console.log(`Scheduler: sending to ${pending.length} pending contact(s)`);

  for (const contact of pending) {
    const logEntry = {
      date: new Date().toISOString(),
      contactId: contact.id,
      name: `${contact.firstName} ${contact.lastName}`,
      email: contact.email,
      template: 'welcome',
      status: 'failed',
      previewUrl: null,
      error: null,
    };

    try {
      const { previewUrl } = await sendCampaignEmail({
        to: contact.email,
        templateName: 'welcome',
        variables: { firstName: contact.firstName, lastName: contact.lastName },
      });

      contact.status = 'sent';
      contact.sentAt = logEntry.date;
      logEntry.status = 'sent';
      logEntry.previewUrl = previewUrl;
    } catch (err) {
      contact.status = 'failed';
      logEntry.error = err.message;
    }

    sendLog.push(logEntry);
  }

  await writeJson('contacts.json', contacts);
  await writeJson('sendLog.json', sendLog);
}

function scheduleTask(schedule) {
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
  }

  if (!schedule.enabled) return;

  currentTask = cron.schedule(timeToCronExpression(schedule.time), runDailyBatch);
}

export function applyScheduleConfig(schedule) {
  scheduleTask(schedule);
}

export async function initScheduler() {
  const schedule = await readJson('schedule.json');
  scheduleTask(schedule);
}
