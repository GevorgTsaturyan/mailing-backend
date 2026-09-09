import express from 'express';
import db from '../db.js';
import { findOrCreateManual } from '../services/CampaignRepository.js';
import { findOrCreate as findOrCreateStats, incrementJobs } from '../services/CampaignStatsRepository.js';
import { queueCanonicalJobForContact } from '../scheduler.js';
import { isContactSuppressed } from '../services/SuppressionService.js';
import { identitySendable } from '../services/JobRepository.js';
import { assertTemplateButtonsValid } from '../services/CampaignBodyCompiler.js';
import { hasButtonPlaceholder } from '../services/BodyCompiler.js';
import * as Groups from '../services/GroupRepository.js';

const router = express.Router();

// POST /api/send
// Creates send_jobs (queued) for the given contacts instead of sending directly.
// A mail-node will poll, claim, and execute them via its local Postfix.
// contentType: 'html' (default) | 'text' — controls which MIME part the node sends.
//
// Recipients = union of explicit contactIds + members of any groupIds, DISTINCT.
// The union is de-duplicated ONLY within this operation (no historical dedup);
// the in-flight guard below still prevents queueing a contact that already has a
// pending/in-progress job. When groupIds is absent this is identical to before.
router.post('/', (req, res) => {
  const { contactIds, groupIds, templateName, subject, html, txt, senderIdentityId, contentType } = req.body;

  const fromGroups = groupIds?.length ? Groups.contactIdsInGroups(groupIds) : [];
  const effectiveIds = [...new Set([...(Array.isArray(contactIds) ? contactIds : []), ...fromGroups])];

  if (effectiveIds.length === 0) {
    return res.status(400).json({ error: 'contactIds or groupIds must resolve to at least one recipient' });
  }
  if (!templateName && !subject) {
    return res.status(400).json({ error: 'templateName or subject is required' });
  }
  if (contentType != null && contentType !== 'html' && contentType !== 'text') {
    return res.status(400).json({ error: "contentType must be 'html' or 'text'" });
  }

  // Pre-fetch template content so the job row has everything the node needs
  let resolvedSubject     = subject     || null;
  let resolvedHtml        = html        || null;
  let resolvedTxt         = txt         || null;
  let resolvedContentType = contentType || 'html';

  if (templateName && !subject) {
    const tmpl = db.prepare('SELECT * FROM templates WHERE name=?').get(templateName);
    if (!tmpl) return res.status(404).json({ error: `Template "${templateName}" not found` });
    resolvedSubject     = tmpl.subject;
    resolvedHtml        = tmpl.html;
    resolvedTxt         = tmpl.txt;
    resolvedContentType = contentType || tmpl.content_type || 'html';
  }

  // Pick identity: use provided, or fall back to first sendable (active + READY).
  let identityId = senderIdentityId || null;
  if (!identityId) {
    const first = db.prepare(
      "SELECT id FROM sender_identities WHERE status='active' AND verificationStatus='READY' ORDER BY id LIMIT 1"
    ).get();
    identityId = first?.id || null;
  }

  // Provisioning gate — refuse to queue for an identity whose owning node has not
  // proven it can send it. Prevents wrong-IP/HELO/unsigned-DKIM sends up front.
  if (identityId && !identitySendable(identityId)) {
    return res.status(409).json({
      error: 'Sending identity is not provisioning-verified (READY) — cannot send',
      identityId,
    });
  }

  const now     = new Date().toISOString();
  const results = [];

  if (process.env.USE_CANONICAL_QUEUE === 'true' && identityId) {
    // ── Canonical path: jobs table + delivery tracking ──────────────────────────
    // Hard-fail up front (before creating any job) if the template references a
    // missing/inactive button — never send a campaign with a broken CTA.
    try {
      assertTemplateButtonsValid({ html: resolvedHtml, txt: resolvedTxt });
    } catch (e) {
      return res.status(422).json({ error: e.message });
    }

    const today    = now.slice(0, 10);
    const dispatch = findOrCreateManual(today, identityId);
    findOrCreateStats(dispatch.id);

    const templateContent = { subject: resolvedSubject, html: resolvedHtml, txt: resolvedTxt, content_type: resolvedContentType };
    let jobsCreated = 0;

    for (const id of effectiveIds) {
      const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(id);
      if (!contact) {
        results.push({ id, status: 'error', error: 'Contact not found' });
        continue;
      }

      // Suppression gate — an unsubscribed/complained recipient is never queued.
      if (isContactSuppressed(id)) {
        results.push({ id, email: contact.email, status: 'skipped', note: 'Suppressed (unsubscribed)' });
        continue;
      }

      const existing = db.prepare(
        "SELECT id FROM jobs WHERE contact_id=? AND status IN ('PENDING','PROCESSING') LIMIT 1"
      ).get(id);
      if (existing) {
        results.push({ id, email: contact.email, status: 'skipped', note: 'Already queued' });
        continue;
      }

      queueCanonicalJobForContact(contact, templateName || null, templateContent, null, null, identityId, dispatch.id);
      jobsCreated++;
      results.push({ id, email: contact.email, status: 'queued' });
    }

    if (jobsCreated > 0) incrementJobs(dispatch.id, jobsCreated);
  } else {
    // ── Legacy path: send_jobs table (unchanged) ────────────────────────────────
    // Tracked buttons require the canonical queue — refuse rather than send an
    // untracked/broken CTA through the legacy pipeline (decision Z-8).
    if (hasButtonPlaceholder(resolvedHtml) || hasButtonPlaceholder(resolvedTxt)) {
      return res.status(422).json({
        error: 'This template uses tracked buttons, which require the canonical queue (USE_CANONICAL_QUEUE=true).',
      });
    }
    const insertLog = db.prepare(`
      INSERT INTO send_log (date, contactId, name, email, template, status, subject, body, senderIdentityId)
      VALUES (@date, @contactId, @name, @email, @template, @status, @subject, @body, @senderIdentityId)
    `);
    const insertJob = db.prepare(`
      INSERT INTO send_jobs
        (senderIdentityId, contactId, email, firstName, lastName,
         templateName, subject, html, txt, content_type, status, createdAt, sendLogId)
      VALUES
        (@senderIdentityId, @contactId, @email, @firstName, @lastName,
         @templateName, @subject, @html, @txt, @content_type, 'queued', @createdAt, @sendLogId)
    `);

    db.transaction(() => {
      for (const id of effectiveIds) {
        const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(id);
        if (!contact) {
          results.push({ id, status: 'error', error: 'Contact not found' });
          continue;
        }

        // Suppression gate — an unsubscribed/complained recipient is never queued.
        if (isContactSuppressed(id)) {
          results.push({ id, email: contact.email, status: 'skipped', note: 'Suppressed (unsubscribed)' });
          continue;
        }

        // Skip if already queued or in-flight
        const existing = db.prepare(
          "SELECT id FROM send_jobs WHERE contactId=? AND status IN ('queued','claimed') LIMIT 1"
        ).get(id);
        if (existing) {
          results.push({ id, email: contact.email, status: 'skipped', note: 'Already queued' });
          continue;
        }

        const logRow = insertLog.run({
          date: now, contactId: contact.id,
          name: `${contact.firstName} ${contact.lastName}`,
          email: contact.email,
          template: templateName || '(custom)',
          status: 'queued',
          subject: resolvedSubject,
          body: resolvedHtml,
          senderIdentityId: identityId,
        });

        const jobRow = insertJob.run({
          senderIdentityId: identityId,
          contactId: contact.id,
          email: contact.email,
          firstName: contact.firstName,
          lastName: contact.lastName,
          templateName: templateName || null,
          subject: resolvedSubject,
          html: resolvedHtml,
          txt: resolvedTxt,
          content_type: resolvedContentType,
          createdAt: now,
          sendLogId: logRow.lastInsertRowid,
        });

        db.prepare('UPDATE send_log SET sendJobId=? WHERE id=?')
          .run(jobRow.lastInsertRowid, logRow.lastInsertRowid);

        // Mark contact so the scheduler doesn't re-pick it for other campaigns
        db.prepare("UPDATE contacts SET status='queued' WHERE id=?").run(id);

        results.push({ id, email: contact.email, status: 'queued', jobId: jobRow.lastInsertRowid });
      }
    })();
  }

  const noIdentity = !identityId;
  res.json({ results, noIdentity });
});

// GET /api/send/jobs — job queue overview for the UI
router.get('/jobs', (req, res) => {
  const { status, limit = 100 } = req.query;
  const where = status ? "WHERE j.status=?" : "";
  const args  = status ? [status, Number(limit)] : [Number(limit)];
  const rows = db.prepare(`
    SELECT j.id, j.email, j.status, j.scheduledFor, j.sentAt, j.deliveredAt,
           j.reasonCategory, j.reasonDetail, j.queueId,
           si.domain, si.ip, si.fromAddr,
           sl.label AS serverLabel, p.name AS providerName
    FROM send_jobs j
    LEFT JOIN sender_identities si ON si.id = j.senderIdentityId
    LEFT JOIN servers sl ON sl.id = si.serverId
    LEFT JOIN providers p ON p.id = sl.providerId
    ${where}
    ORDER BY j.id DESC
    LIMIT ?
  `).all(...args);
  res.json(rows);
});

export default router;
