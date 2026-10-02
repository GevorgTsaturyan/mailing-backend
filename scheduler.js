import cron from 'node-cron';
import db from './db.js';
import * as CampaignRepo from './services/CampaignRepository.js';
import { findOrCreate as findOrCreateStats, incrementJobs } from './services/CampaignStatsRepository.js';
import { isContactSuppressed } from './services/SuppressionService.js';
import { identitySendable } from './services/JobRepository.js';
import { compileForContact, assertTemplateButtonsValid } from './services/CampaignBodyCompiler.js';
import { hasButtonPlaceholder } from './services/BodyCompiler.js';
import { purgeOldEvents, retentionDays } from './services/EventRetention.js';
import * as SendLedger from './services/SendLedger.js';
import { DAILY_BATCH_SOURCE_ID } from './services/SendLedger.js';

// Pre-validate a template before queueing a campaign's jobs. Returns true when
// safe to proceed. On a problem it logs an actionable error and returns false so
// the caller skips the campaign — never sends a broken CTA, never partially queues.
//   • tracked buttons on the legacy pipeline → hard-fail (buttons require canonical)
//   • missing/inactive button                → hard-fail (decision Z-7/Z-8)
function campaignBodyOkOrSkip(tmpl, label) {
  try {
    if (!useCanonicalQueue() && (hasButtonPlaceholder(tmpl.html) || hasButtonPlaceholder(tmpl.txt))) {
      throw new Error('template uses tracked buttons, which require the canonical queue (USE_CANONICAL_QUEUE=true)');
    }
    assertTemplateButtonsValid(tmpl);
    return true;
  } catch (e) {
    console.error(`${label}: ${e.message} — skipping.`);
    return false;
  }
}

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

// Returns true if a job was created, false if skipped (suppressed, no sendable
// identity, or already committed to this ledger source).
// `ledger` (optional) = { sourceType, sourceId } — when provided, a ledger claim
// is inserted FIRST inside the same transaction; if the contact was already
// committed to that source (PK collision) no job is created. This keeps ledger
// row and job strictly atomic. Manual/scheduled callers pass no ledger → unchanged.
function queueJobForContact(contact, templateName, templateContent, scheduledFor = null, scheduledSendId = null, senderIdentityId = null, ledger = null) {
  // Central suppression guard — last line of defense at creation for every legacy
  // caller (daily batch, recurring, scheduled sends).
  if (isContactSuppressed(contact.id)) return false;

  const identityId  = senderIdentityId ?? pickActiveIdentity();
  // Provisioning gate (parity with the canonical path): never create a legacy job
  // for an identity whose owning node hasn't proven it can send it.
  if (!identitySendable(identityId)) return false;
  const tmpl        = resolveTemplate(templateName, templateContent);
  // Button/open tracking requires the canonical queue (it needs a campaign_id for
  // per-recipient snapshots and attribution). Fail clearly rather than silently
  // sending an untracked/broken CTA through the legacy pipeline (decision Z-8).
  if (hasButtonPlaceholder(tmpl.html) || hasButtonPlaceholder(tmpl.txt)) {
    throw new Error('This template uses tracked buttons, which require the canonical queue (USE_CANONICAL_QUEUE=true). Refusing to send via the legacy pipeline.');
  }
  const contentType = tmpl.content_type || 'html';
  const now         = new Date().toISOString();

  let queued = false;
  db.transaction(() => {
    // Ledger-first: claim the (source, contact) before creating any job. If the
    // claim is a no-op the contact was already committed → do not queue.
    if (ledger && !SendLedger.record(ledger.sourceType, ledger.sourceId, contact.id, now)) return;

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
    queued = true;
  })();
  return queued;
}

// ─── Canonical queue path ─────────────────────────────────────────────────────
// Creates a jobs row + send_log row. Daily limit enforcement happens at the
// planner level (see getIdentityRemainingCapacity), so this function trusts that
// the caller has already validated capacity.

// Returns true if a job was created, false if skipped (suppressed, no identity,
// or already committed to this ledger source).
// `ledger` (optional) = { sourceType, sourceId } — see queueJobForContact. The
// claim is inserted ledger-first inside the same transaction as the job, so the
// two are atomic. Manual send passes no ledger → behaviour unchanged.
export function queueCanonicalJobForContact(contact, templateName, templateContent, scheduledFor = null, scheduledSendId = null, senderIdentityId = null, campaignId = null, ledger = null) {
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
  let body          = contentType === 'text' ? (tmpl.txt || '') : (tmpl.html || '');
  let bodyText      = null;
  const now         = new Date().toISOString();

  // Campaign-specific tracking transforms (buttons + open pixel) happen HERE, at
  // queue time, centrally — so the mail-node stays unaware. Returns null when the
  // template uses no buttons and open tracking is disabled (body unchanged).
  const campaign = campaignId ? CampaignRepo.findById(campaignId) : null;
  if (campaign) {
    const compiled = compileForContact({ campaign, contact, identityId, tmpl });
    if (compiled) { body = compiled.body; bodyText = compiled.bodyText; }
  }

  let queued = false;
  db.transaction(() => {
    // Ledger-first: claim the (source, contact) before creating any job. If the
    // claim is a no-op the contact was already committed → do not queue.
    if (ledger && !SendLedger.record(ledger.sourceType, ledger.sourceId, contact.id, now)) return;

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
        (status, identity_id, recipient, subject, body, body_text, content_type,
         scheduled_for, contact_id, send_log_id, campaign_id, created_at)
      VALUES ('PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      identityId,
      contact.email,
      tmpl.subject || '',
      body,
      bodyText,
      contentType,
      scheduledFor,
      contact.id,
      logRow.lastInsertRowid,
      campaignId,
      now
    );

    db.prepare("UPDATE contacts SET status='queued' WHERE id=?").run(contact.id);
    queued = true;
  })();
  return queued;
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

// ─── Timezone-aware local→UTC conversion ─────────────────────────────────────
// Converts "HH:MM" in the given IANA timezone to "HH:MM" UTC for today.
// Uses Intl (built-in, no deps) with the probe-and-correct technique so DST is
// handled correctly on every day this runs.
// If timezone is absent or 'UTC' the input is returned unchanged.
function localHHMMtoUTC(hhmm, timezone) {
  if (!timezone || timezone === 'UTC') return hhmm;
  const [h, m] = hhmm.split(':').map(Number);
  // Today's date in the target timezone (sv locale gives "YYYY-MM-DD")
  const todayInTz = new Intl.DateTimeFormat('sv', { timeZone: timezone }).format(new Date());
  const [y, mo, d] = todayInTz.split('-').map(Number);
  // Probe: treat h:m as UTC and see what local time that gives in the timezone
  const probe = new Date(Date.UTC(y, mo - 1, d, h, m));
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(probe);
  const probeH = Number(parts.find(p => p.type === 'hour').value);
  const probeM = Number(parts.find(p => p.type === 'minute').value);
  // Shift probe by the difference so the result gives h:m in the timezone
  const diffMs = ((h * 60 + m) - (probeH * 60 + probeM)) * 60000;
  return new Date(probe.getTime() - diffMs).toISOString().slice(11, 16);
}

// ─── Random timestamps in a UTC window (returns sorted ISO strings) ───────────

function randomTimesInWindow(startTime, endTime, count) {
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  const startMins = sh * 60 + sm;
  const endMins   = eh * 60 + em;
  const rangeMins = endMins - startMins;

  if (rangeMins <= 0 || count <= 0) return [];

  const now     = new Date();
  const nowMins = now.getUTCHours() * 60 + now.getUTCMinutes();

  // If the window has already fully ended today, return nothing — the midnight
  // cron will schedule tomorrow's sends when it next runs.
  if (nowMins >= endMins) return [];

  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const nowMs    = now.getTime();
  const times    = [];

  for (let i = 0; i < count; i++) {
    const offset  = Math.floor(Math.random() * rangeMins);
    const totalM  = startMins + offset;
    const h       = Math.floor(totalM / 60);
    const m       = totalM % 60;
    const s       = Math.floor(Math.random() * 60);
    times.push(new Date(todayUTC + (h * 3600 + m * 60 + s) * 1000).toISOString());
  }

  // Drop any slots that are already in the past (partially elapsed window).
  return times.filter(t => new Date(t).getTime() > nowMs).sort();
}

// ─── Daily batch ─────────────────────────────────────────────────────────────

// Resolve a source's target audience config: its mode and (when 'groups') the
// set of targeted group ids. Empty group set stays empty — NEVER "all".
function dailyBatchGroupIds() {
  return db.prepare('SELECT group_id FROM daily_batch_groups').all().map((r) => r.group_id);
}

function planDaySends() {
  const cfg = db.prepare('SELECT * FROM schedule_config WHERE id=1').get();
  if (!cfg.enabled || cfg.batchSize <= 0) return;

  if (!campaignBodyOkOrSkip(resolveTemplate(cfg.template, null), 'Daily batch')) return;

  // Daily-batch targeting (shared by both queue paths). Ledger source is the
  // fixed daily-batch sentinel so dedup spans every daily run.
  const targetMode = cfg.target_mode || 'all';
  const groupIds   = targetMode === 'groups' ? dailyBatchGroupIds() : [];
  const dbLedger   = { sourceType: 'daily_batch', sourceId: DAILY_BATCH_SOURCE_ID };

  const batchTZ    = cfg.timezone || 'UTC';
  const batchStart = localHHMMtoUTC(cfg.startTime, batchTZ);
  const batchEnd   = localHHMMtoUTC(cfg.endTime,   batchTZ);

  if (useCanonicalQueue()) {
    const identityId = pickActiveIdentity();
    if (!identityId) return;

    const capacity = getIdentityRemainingCapacity(identityId);
    const count    = Math.min(cfg.batchSize, capacity);
    if (count <= 0) {
      console.log('Daily batch (canonical): no remaining capacity for today');
      return;
    }

    const times    = randomTimesInWindow(batchStart, batchEnd, count);
    if (times.length === 0) {
      console.log('Daily batch (canonical): send window already passed for today');
      return;
    }

    const contacts = SendLedger.eligibleContacts({
      sourceType: dbLedger.sourceType, sourceId: dbLedger.sourceId,
      targetMode, groupIds, limit: times.length,
    });

    if (contacts.length === 0) {
      console.log('Daily batch (canonical): no eligible contacts');
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
      if (queueCanonicalJobForContact(contacts[i], cfg.template, null, times[i], null, identityId, dispatch.id, dbLedger)) created++;
    }
    if (created > 0) incrementJobs(dispatch.id, created);

    console.log(`Daily batch (canonical): queued ${created} jobs (${batchStart}–${batchEnd} UTC)`);
  } else {
    const times = randomTimesInWindow(batchStart, batchEnd, cfg.batchSize);
    if (times.length === 0) {
      console.log('Daily batch: send window already passed for today');
      return;
    }

    const contacts = SendLedger.eligibleContacts({
      sourceType: dbLedger.sourceType, sourceId: dbLedger.sourceId,
      targetMode, groupIds, limit: times.length,
    });

    let created = 0;
    for (let i = 0; i < contacts.length; i++) {
      if (queueJobForContact(contacts[i], cfg.template, null, times[i], null, null, dbLedger)) created++;
    }

    console.log(`Daily batch: queued ${created} jobs (${batchStart}–${batchEnd} UTC)`);
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

    if (!campaignBodyOkOrSkip(resolveTemplate(campaign.templateName, templateContent), `Recurring "${campaign.name}"`)) continue;

    // Per-campaign targeting + ledger source. Empty group set stays empty (never all).
    const targetMode = campaign.target_mode || 'all';
    const groupIds   = targetMode === 'groups'
      ? db.prepare('SELECT group_id FROM recurring_campaign_groups WHERE recurring_campaign_id=?').all(campaign.id).map((r) => r.group_id)
      : [];
    const rcLedger   = { sourceType: 'recurring', sourceId: campaign.id };

    const rcTZ    = campaign.timezone || 'UTC';
    const rcStart = localHHMMtoUTC(campaign.startTime, rcTZ);
    const rcEnd   = localHHMMtoUTC(campaign.endTime,   rcTZ);

    if (useCanonicalQueue()) {
      const identityId = campaign.sender_identity_id || pickActiveIdentity();
      if (!identityId) continue;

      const capacity = getIdentityRemainingCapacity(identityId);
      const count    = Math.min(requestedCount, capacity);

      if (count <= 0) {
        console.log(`Recurring "${campaign.name}": no remaining capacity`);
        continue;
      }

      const times = randomTimesInWindow(rcStart, rcEnd, count);
      if (times.length === 0) {
        // Send window has already ended for today; midnight cron handles tomorrow.
        console.log(`Recurring "${campaign.name}": send window already passed for today — will run tomorrow`);
        continue;
      }

      const contacts = SendLedger.eligibleContacts({
        sourceType: rcLedger.sourceType, sourceId: rcLedger.sourceId,
        targetMode, groupIds, limit: times.length,
      });

      if (contacts.length === 0) {
        console.log(`Recurring "${campaign.name}": no eligible contacts — completed`);
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
        if (queueCanonicalJobForContact(contacts[i], campaign.templateName, templateContent, times[i], null, identityId, dispatch.id, rcLedger)) created++;
      }
      if (created > 0) incrementJobs(dispatch.id, created);

      db.prepare('UPDATE recurring_campaigns SET lastRunDate=?, currentDay=? WHERE id=?')
        .run(todayUTC, campaign.currentDay + 1, campaign.id);

      console.log(`Recurring "${campaign.name}" (day ${campaign.currentDay + 1}, canonical): queued ${created} jobs`);
    } else {
      const identityId = campaign.sender_identity_id || null;
      const times      = randomTimesInWindow(rcStart, rcEnd, requestedCount);
      if (times.length === 0) {
        // Send window has already ended for today; midnight cron handles tomorrow.
        console.log(`Recurring "${campaign.name}": send window already passed for today — will run tomorrow`);
        continue;
      }

      const contacts = SendLedger.eligibleContacts({
        sourceType: rcLedger.sourceType, sourceId: rcLedger.sourceId,
        targetMode, groupIds, limit: times.length,
      });

      if (contacts.length === 0) {
        console.log(`Recurring "${campaign.name}": no eligible contacts — completed`);
        db.prepare("UPDATE recurring_campaigns SET status='completed' WHERE id=?").run(campaign.id);
        continue;
      }

      let created = 0;
      for (let i = 0; i < contacts.length; i++) {
        if (queueJobForContact(contacts[i], campaign.templateName, templateContent, times[i], null, identityId, rcLedger)) created++;
      }

      db.prepare('UPDATE recurring_campaigns SET lastRunDate=?, currentDay=? WHERE id=?')
        .run(todayUTC, campaign.currentDay + 1, campaign.id);

      console.log(`Recurring "${campaign.name}" (day ${campaign.currentDay + 1}): queued ${created} jobs`);
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

    // Fail the task clearly (rather than looping forever) if its buttons are
    // invalid or it needs the canonical queue but the legacy pipeline is active.
    if (!campaignBodyOkOrSkip(resolveTemplate(task.templateName, templateContent), `Scheduled send #${task.id}`)) {
      db.prepare("UPDATE scheduled_sends SET status='failed' WHERE id=?").run(task.id);
      continue;
    }

    console.log(`Scheduled send #${task.id}: queuing ${contactIds.length} job(s)`);

    db.transaction(() => {
      db.prepare("UPDATE scheduled_sends SET status='sent', sentAt=? WHERE id=?")
        .run(new Date().toISOString(), task.id);

      if (useCanonicalQueue()) {
        const identityId = task.sender_identity_id || pickActiveIdentity();
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
  // Daily retention sweep for raw tracking events (bounds growth + privacy).
  cron.schedule('30 3 * * *', () => {
    try {
      const r = purgeOldEvents();
      console.log(`[retention] purged tracking events older than ${retentionDays()}d: ${r.clicksDeleted} clicks, ${r.opensDeleted} opens`);
    } catch (err) {
      console.error('[retention] purge failed:', err.message);
    }
  }, { timezone: 'UTC' });
}
