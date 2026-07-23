import db from '../db.js';
import { findOrCreate as findOrCreateStats, applyDeliveryEvent } from './CampaignStatsRepository.js';

// ─── DeliveryEventService ─────────────────────────────────────────────────────
// Processes delivery events reported by mail-nodes from Postfix mail.log.
//
// Each event is processed in its own db.transaction so that a bad event in a
// batch does not block the others.  The dedup_key UNIQUE constraint (via
// INSERT OR IGNORE) provides idempotency: replaying the same log line after a
// parser restart is safe — the duplicate is silently discarded.
//
// FSM: delivery_status on jobs only advances to higher-priority states.
// Priority: SMTP_PENDING(0) < SMTP_ACCEPTED(1) < DEFERRED(2) <
//           DELIVERED(3) = BOUNCED(3) = SEND_FAILED(3) < COMPLAINED(4)
//
// Both pipelines are supported:
//   canonical (jobs table):  full FSM + campaign_stats + contact updates
//   legacy    (send_jobs):   send_jobs status + send_log updates preserved

const FSM_PRIORITY = {
  SMTP_PENDING:  0,
  SMTP_ACCEPTED: 1,
  DEFERRED:      2,
  DELIVERED:     3,
  BOUNCED:       3,
  SEND_FAILED:   3,
  COMPLAINED:    4,
};

// Postfix log status → internal delivery_status (uppercase)
const EVENT_TO_STATUS = {
  sent:     'DELIVERED',
  bounced:  'BOUNCED',
  deferred: 'DEFERRED',
};

// delivery_status → send_log.deliveryStatus (lowercase — backward-compatible)
const STATUS_TO_LOG = {
  DELIVERED: 'delivered',
  BOUNCED:   'bounced',
  DEFERRED:  'deferred',
};

// ─── Prepared statements (module-level for reuse across calls) ────────────────

const lookupCanonicalJob = db.prepare(
  'SELECT id, campaign_id, delivery_status, contact_id, recipient FROM jobs WHERE queue_id = ?'
);

const lookupLegacySendJob = db.prepare(
  'SELECT id, contactId, email FROM send_jobs WHERE queueId = ?'
);

const insertDeliveryEvent = db.prepare(`
  INSERT OR IGNORE INTO delivery_events
    (job_id, sendJobId, queueId, email, eventType, dsnCode, relay, response,
     reasonCategory, reasonDetail, logTime, createdAt, dedup_key)
  VALUES
    (@job_id, @sendJobId, @queueId, @email, @eventType, @dsnCode, @relay, @response,
     @reasonCategory, @reasonDetail, @logTime, @createdAt, @dedup_key)
`);

const updateJobDeliveryStatus = db.prepare(
  'UPDATE jobs SET delivery_status = ? WHERE id = ?'
);

// Preserves existing legacy behaviour: guards against downgrading delivered/bounced
const updateSendJobStatus = db.prepare(`
  UPDATE send_jobs
  SET status = ?, dsnCode = ?, relay = ?, remoteResponse = ?,
      reasonCategory = ?, reasonDetail = ?, deliveredAt = ?
  WHERE queueId = ? AND status NOT IN ('delivered', 'bounced')
`);

const updateSendLog = db.prepare(`
  UPDATE send_log
  SET deliveryStatus = ?, dsnCode = ?, remoteMx = ?, remoteResponse = ?,
      reasonCategory = ?, reasonDetail = ?, deliveredAt = ?, lastEventAt = ?
  WHERE queueId = ?
`);

// BOUNCED → contact failed (unless already unsubscribed)
const markContactFailed = db.prepare(
  "UPDATE contacts SET status = 'failed' WHERE id = ? AND status != 'unsubscribed'"
);

// COMPLAINED → contact unsubscribed (always suppressed)
const markContactUnsubscribed = db.prepare(
  "UPDATE contacts SET status = 'unsubscribed' WHERE id = ?"
);

// ─── Core per-event processor ─────────────────────────────────────────────────

function processSingleEvent(event, now) {
  const newDeliveryStatus = EVENT_TO_STATUS[event.eventType];
  if (!newDeliveryStatus) {
    console.warn('[DeliveryEventService] unknown eventType=%s queueId=%s', event.eventType, event.queueId);
    return { skipped: true };
  }

  // dedup_key ties this specific log line to exactly one delivery_events row
  const dedupKey = `${event.queueId}_${event.eventType}_${event.logTime ?? now}`;

  return db.transaction(() => {
    // Resolve job references for both pipelines
    const canonicalJob  = lookupCanonicalJob.get(event.queueId);
    const legacySendJob = lookupLegacySendJob.get(event.queueId);

    const email = canonicalJob?.recipient
      ?? legacySendJob?.email
      ?? event.email
      ?? null;

    // ── 1. Insert delivery event (INSERT OR IGNORE = idempotent) ──────────────
    const { changes } = insertDeliveryEvent.run({
      job_id:         canonicalJob?.id  ?? null,
      sendJobId:      legacySendJob?.id ?? null,
      queueId:        event.queueId,
      email,
      eventType:      event.eventType,
      dsnCode:        event.dsnCode        ?? null,
      relay:          event.relay          ?? null,
      response:       (event.response || '').slice(0, 500),
      reasonCategory: event.reasonCategory ?? null,
      reasonDetail:   event.reasonDetail   ?? null,
      logTime:        event.logTime        ?? now,
      createdAt:      now,
      dedup_key:      dedupKey,
    });

    if (changes === 0) return { skipped: true };  // dedup_key already exists

    // ── 2. FSM priority check ─────────────────────────────────────────────────
    // For canonical jobs: read actual current delivery_status.
    // For legacy-only events: default to SMTP_PENDING so any delivery status
    // is always allowed (preserves previous behaviour).
    const priorStatus = canonicalJob?.delivery_status ?? 'SMTP_PENDING';
    const priorityOk  = (FSM_PRIORITY[newDeliveryStatus] ?? 0) >= (FSM_PRIORITY[priorStatus] ?? 0);

    const logStatus   = STATUS_TO_LOG[newDeliveryStatus];
    const deliveredAt = newDeliveryStatus === 'DELIVERED' ? now : null;

    // ── 3. Legacy send_jobs status (preserved exactly as before) ─────────────
    if (legacySendJob) {
      updateSendJobStatus.run(
        logStatus,
        event.dsnCode        ?? null,
        event.relay          ?? null,
        (event.response || '').slice(0, 500),
        event.reasonCategory ?? null,
        event.reasonDetail   ?? null,
        deliveredAt,
        event.queueId
      );
    }

    // ── 4. FSM-gated updates (only when transition is valid) ──────────────────
    if (!priorityOk) return { skipped: false };

    // send_log — covers both pipelines (matched by queueId column)
    updateSendLog.run(
      logStatus,
      event.dsnCode        ?? null,
      event.relay          ?? null,
      (event.response || '').slice(0, 500),
      event.reasonCategory ?? null,
      event.reasonDetail   ?? null,
      deliveredAt,
      now,
      event.queueId
    );

    // canonical jobs: update delivery_status
    if (canonicalJob) {
      updateJobDeliveryStatus.run(newDeliveryStatus, canonicalJob.id);
    }

    // campaign_stats: only for canonical jobs that belong to a campaign
    if (canonicalJob?.campaign_id) {
      findOrCreateStats(canonicalJob.campaign_id);
      applyDeliveryEvent(canonicalJob.campaign_id, priorStatus, newDeliveryStatus);
    }

    // contact updates on hard outcomes
    const contactId = canonicalJob?.contact_id ?? legacySendJob?.contactId ?? null;
    if (contactId) {
      if (newDeliveryStatus === 'COMPLAINED') {
        markContactUnsubscribed.run(contactId);
      } else if (newDeliveryStatus === 'BOUNCED') {
        markContactFailed.run(contactId);
      }
    }

    return { skipped: false };
  })();
}

// ─── Public API ───────────────────────────────────────────────────────────────

// processEvents(events[]) → { processed, skipped }
//
// events[] comes from POST /api/nodes/delivery-events.  Each event must have:
//   queueId, eventType ('sent'|'bounced'|'deferred'),
//   and optionally: dsnCode, relay, response, reasonCategory, reasonDetail,
//   logTime, email.
//
// Returns counts of successfully processed and skipped (duplicate or unknown)
// events.  Errors on individual events are caught so one bad event does not
// block the rest of the batch.
export function processEvents(events) {
  let processed = 0;
  let skipped   = 0;
  const now = new Date().toISOString();

  for (const event of events) {
    try {
      const result = processSingleEvent(event, now);
      if (result.skipped) skipped++;
      else processed++;
    } catch (err) {
      console.error('[DeliveryEventService] error processing event queueId=%s: %s', event.queueId, err.message);
      skipped++;
    }
  }

  return { processed, skipped };
}
