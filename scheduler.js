import cron from 'node-cron';
import db from './db.js';
import * as CampaignRepo from './services/CampaignRepository.js';
import { findOrCreate as findOrCreateStats, incrementJobs } from './services/CampaignStatsRepository.js';
import { isContactSuppressed } from './services/SuppressionService.js';
import { identitySendable } from './services/JobRepository.js';

// ─── Feature flag ─────────────────────────────────────────────────────────────
// When USE_CANONICAL_QUEUE=true, the scheduler creates `jobs` rows instead of
// `send_jobs` rows. The legacy pipeline continues draining any existing send_jobs
// until they naturally reach zero. Set to false (or omit) for legacy behaviour.

function useCanonicalQueue() {
  return process.env.USE_CANONICAL_QUEUE === 'true';
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function pickActiveIdentity() {
  return db.prepare("SELECT id FROM sender_identities WHERE status='active' ORDER BY id LIMIT 1").get()?.id || null;
}

function resolveTemplate(templateName, templateContent) {
  if (templateContent?.subject) return templateContent;
  if (templateName) {
    const t = db.prepare('SELECT subject, html, txt, content_type FROM templates WHERE name=?').get(templateName);
    if (t) return t;
  }
  return { subject: null, html: null, txt: null, content_type: 'html' };
}

// ─── Legacy queue path ────────────────────────────────────────────────────────
// Creates a send_jobs row + send_log row. Unchanged from Milestone 4.

// Returns true if a job was created, false if the contact was suppressed (skipped).
function queueJobForContact(contact, templateName, templateContent, scheduledFor = null, scheduledSendId = null, senderIdentityId = null) {
  // Central suppression guard — last line of defense at creation for every legacy
  // caller (daily batch, recurring, scheduled sends).
  if (isContactSuppressed(contact.id)) return false;

  const identityId  = senderIdentityId ?? pickActiveIdentity();
  // Provisioning gate (parity with the canonical path): never create a legacy job
  // for an identity whose owning node hasn't proven it can send it.
  if (!identitySendable(identityId)) return false;
  const tmpl        = resolveTemplate(templateName, templateContent);
  const contentType = tmpl.content_type || 'html';
  const now         = new Date().toISOString();

  db.transaction(() => {
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
         templateName, subject, html, txt, content_type, status, scheduledFor, createdAt, sendLogId, scheduledSendId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
    `).run(
      identityId,
      contact.id, contact.email, contact.firstName, contact.lastName,
      templateName || null, tmpl.subject, tmpl.html, tmpl.txt, contentType,
      scheduledFor, now, logRow.lastInsertRowid, scheduledSendId
    );

    db.prepare('UPDATE send_log SET sendJobId=? WHERE id=?')
      .run(jobRow.lastInsertRowid, logRow.lastInsertRowid);

    db.prepare("UPDATE contacts SET status='queued' WHERE id=?").run(contact.id);
  })();
  return true;
}

// ─── Canonical queue path ─────────────────────────────────────────────────────
// Creates a jobs row + send_log row. Daily limit enforcement happens at the
// planner level (see getIdentityRemainingCapacity), so this function trusts that
// the caller has already validated capacity.

// Returns true if a job was created, false if skipped (suppressed or no identity).
export function queueCanonicalJobForContact(contact, templateName, templateContent, scheduledFor = null, scheduledSendId = null, senderIdentityId = null, campaignId = null) {
  // Central suppression guard — last line of defense at creation for every canonical
  // caller (manual send, daily batch, recurring, scheduled sends).
  if (isContactSuppressed(contact.id)) return false;

  const identityId  = senderIdentityId ?? pickActiveIdentity();
  if (!identityId) return false;
  // Provisioning gate — never create a canonical job for an identity whose owning
  // node has not proven it can send it (active + verificationStatus='READY').
  if (!identitySendable(identityId)) return false;

  const tmpl        = resolveTemplate(templateName, templateContent);
  const contentType = tmpl.content_type || 'html';
  // Store the relevant content body based on mode: text jobs use txt, html jobs use html.
  const body        = contentType === 'text' ? (tmpl.txt || '') : (tmpl.html || '');
  const now         = new Date().toISOString();

  db.transaction(() => {
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

    db.prepare(`
      INSERT INTO jobs
        (status, identity_id, recipient, subject, body, content_type,
         scheduled_for, contact_id, send_log_id, campaign_id, created_at)
      VALUES ('PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      identityId,
      contact.email,
      tmpl.subject || '',
      body,
      contentType,
      scheduledFor,
      contact.id,
      logRow.lastInsertRowid,
      campaignId,
      now
    );

    db.prepare("UPDATE contacts SET status='queued' WHERE id=?").run(contact.id);
  })();
  return true;
}

// ─── Daily limit enforcement (canonical queue only) ───────────────────────────
// Resets dailySentCount if the calendar day has rolled over, then returns how
// many more sends the identity can absorb today.  This moves enforcement from
// poll-time (legacy pipeline) to creation-time so the queue only holds
// dispatchable jobs.

function getIdentityRemainingCapacity(identityId) {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    UPDATE sender_identities SET dailySentCount = 0, lastResetDate = ?
    WHERE id = ? AND (lastResetDate IS NULL OR lastResetDate != ?)
  `).run(today, identityId, today);

  const row = db.prepare('SELECT dailyLimit, dailySentCount FROM sender_identities WHERE id=?').get(identityId);
  return row ? Math.max(0, row.dailyLimit - row.dailySentCount) : 0;
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

  if (useCanonicalQueue()) {
    const identityId = pickActiveIdentity();
    if (!identityId) return;

    const capacity = getIdentityRemainingCapacity(identityId);
    const count    = Math.min(cfg.batchSize, capacity);
    if (count <= 0) {
      console.log('Daily batch (canonical): no remaining capacity for today');
      return;
    }

    const times    = randomTimesInWindow(cfg.startTime, cfg.endTime, count);
    const contacts = db.prepare(
      "SELECT * FROM contacts WHERE status='pending' ORDER BY id LIMIT ?"
    ).all(times.length);

    if (contacts.length === 0) {
      console.log('Daily batch (canonical): no pending contacts');
      return;
    }

    const todayUTC = new Date().toISOString().slice(0, 10);
    const dispatch = CampaignRepo.create({
      type: 'daily_batch', date: todayUTC, identity_id: identityId,
      label: `Daily batch – ${todayUTC}`,
    });
    findOrCreateStats(dispatch.id);

    let created = 0;
    for (let i = 0; i < contacts.length; i++) {
      if (queueCanonicalJobForContact(contacts[i], cfg.template, null, times[i], null, identityId, dispatch.id)) created++;
    }
    if (created > 0) incrementJobs(dispatch.id, created);

    console.log(`Daily batch (canonical): queued ${created} jobs (${cfg.startTime}–${cfg.endTime} UTC)`);
  } else {
    const times    = randomTimesInWindow(cfg.startTime, cfg.endTime, cfg.batchSize);
    const contacts = db.prepare(
      "SELECT * FROM contacts WHERE status='pending' ORDER BY id LIMIT ?"
    ).all(times.length);

    for (let i = 0; i < contacts.length; i++) {
      queueJobForContact(contacts[i], cfg.template, null, times[i]);
    }

    console.log(`Daily batch: queued ${contacts.length} jobs (${cfg.startTime}–${cfg.endTime} UTC)`);
  }
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

    const requestedCount = nextCount(campaign);
    const templateContent = campaign.subject
      ? { subject: campaign.subject, html: campaign.html || '', txt: campaign.txt || '', content_type: campaign.content_type || 'html' }
      : null;

    if (useCanonicalQueue()) {
      const identityId = pickActiveIdentity();
      if (!identityId) continue;

      const capacity = getIdentityRemainingCapacity(identityId);
      const count    = Math.min(requestedCount, capacity);

      if (count <= 0) {
        console.log(`Recurring "${campaign.name}": no remaining capacity`);
        continue;
      }

      const times    = randomTimesInWindow(campaign.startTime, campaign.endTime, count);
      const contacts = db.prepare(
        "SELECT * FROM contacts WHERE status='pending' ORDER BY id LIMIT ?"
      ).all(times.length);

      if (contacts.length === 0) {
        console.log(`Recurring "${campaign.name}": no pending contacts — completed`);
        db.prepare("UPDATE recurring_campaigns SET status='completed' WHERE id=?").run(campaign.id);
        continue;
      }

      const dispatch = CampaignRepo.create({
        type: 'recurring', date: todayUTC,
        recurring_campaign_id: campaign.id,
        label: campaign.name,
      });
      findOrCreateStats(dispatch.id);

      let created = 0;
      for (let i = 0; i < contacts.length; i++) {
        if (queueCanonicalJobForContact(contacts[i], campaign.templateName, templateContent, times[i], null, identityId, dispatch.id)) created++;
      }
      if (created > 0) incrementJobs(dispatch.id, created);

      db.prepare('UPDATE recurring_campaigns SET lastRunDate=?, currentDay=? WHERE id=?')
        .run(todayUTC, campaign.currentDay + 1, campaign.id);

      console.log(`Recurring "${campaign.name}" (day ${campaign.currentDay + 1}, canonical): queued ${created} jobs`);
    } else {
      const times    = randomTimesInWindow(campaign.startTime, campaign.endTime, requestedCount);
      const contacts = db.prepare(
        "SELECT * FROM contacts WHERE status='pending' ORDER BY id LIMIT ?"
      ).all(times.length);

      if (contacts.length === 0) {
        console.log(`Recurring "${campaign.name}": no pending contacts — completed`);
        db.prepare("UPDATE recurring_campaigns SET status='completed' WHERE id=?").run(campaign.id);
        continue;
      }

      for (let i = 0; i < contacts.length; i++) {
        queueJobForContact(contacts[i], campaign.templateName, templateContent, times[i]);
      }

      db.prepare('UPDATE recurring_campaigns SET lastRunDate=?, currentDay=? WHERE id=?')
        .run(todayUTC, campaign.currentDay + 1, campaign.id);

      console.log(`Recurring "${campaign.name}" (day ${campaign.currentDay + 1}): queued ${contacts.length} jobs`);
    }
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
    const contactIds = JSON.parse(task.contactIds);
    const templateContent = task.subject
      ? { subject: task.subject, html: task.html || '', txt: task.txt || '', content_type: task.content_type || 'html' }
      : null;

    console.log(`Scheduled send #${task.id}: queuing ${contactIds.length} job(s)`);

    db.transaction(() => {
      db.prepare("UPDATE scheduled_sends SET status='sent', sentAt=? WHERE id=?")
        .run(new Date().toISOString(), task.id);

      if (useCanonicalQueue()) {
        const identityId = pickActiveIdentity();
        let capacity = identityId ? getIdentityRemainingCapacity(identityId) : 0;

        const todayUTC = new Date().toISOString().slice(0, 10);
        const dispatch = CampaignRepo.create({
          type: 'scheduled_send', date: todayUTC,
          scheduled_send_id: task.id,
          label: task.label ?? null,
        });
        findOrCreateStats(dispatch.id);
        let jobsQueued = 0;

        for (const contactId of contactIds) {
          if (capacity <= 0) break;
          const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(contactId);
          if (!contact) continue;
          // Suppressed recipients are skipped without consuming daily capacity.
          if (!queueCanonicalJobForContact(contact, task.templateName, templateContent, null, task.id, identityId, dispatch.id)) continue;
          capacity--;
          jobsQueued++;
        }
        if (jobsQueued > 0) incrementJobs(dispatch.id, jobsQueued);
      } else {
        for (const contactId of contactIds) {
          const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(contactId);
          if (!contact) continue;
          queueJobForContact(contact, task.templateName, templateContent, null, task.id);
        }
      }
    })();
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
