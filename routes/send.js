import express from 'express';
import db from '../db.js';

const router = express.Router();

// POST /api/send
// Creates send_jobs (queued) for the given contacts instead of sending directly.
// A mail-node will poll, claim, and execute them via its local Postfix.
router.post('/', (req, res) => {
  const { contactIds, templateName, subject, html, txt, senderIdentityId } = req.body;

  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return res.status(400).json({ error: 'contactIds must be a non-empty array' });
  }
  if (!templateName && !subject) {
    return res.status(400).json({ error: 'templateName or subject is required' });
  }

  // Pre-fetch template content so the job row has everything the node needs
  let resolvedSubject = subject || null;
  let resolvedHtml    = html    || null;
  let resolvedTxt     = txt     || null;

  if (templateName && !subject) {
    const tmpl = db.prepare('SELECT * FROM templates WHERE name=?').get(templateName);
    if (!tmpl) return res.status(404).json({ error: `Template "${templateName}" not found` });
    resolvedSubject = tmpl.subject;
    resolvedHtml    = tmpl.html;
    resolvedTxt     = tmpl.txt;
  }

  // Pick identity: use provided, or fall back to first active
  let identityId = senderIdentityId || null;
  if (!identityId) {
    const first = db.prepare("SELECT id FROM sender_identities WHERE status='active' ORDER BY id LIMIT 1").get();
    identityId = first?.id || null;
  }

  const now = new Date().toISOString();
  const results = [];

  const insertLog = db.prepare(`
    INSERT INTO send_log (date, contactId, name, email, template, status, subject, body, senderIdentityId)
    VALUES (@date, @contactId, @name, @email, @template, @status, @subject, @body, @senderIdentityId)
  `);
  const insertJob = db.prepare(`
    INSERT INTO send_jobs
      (senderIdentityId, contactId, email, firstName, lastName,
       templateName, subject, html, txt, status, createdAt, sendLogId)
    VALUES
      (@senderIdentityId, @contactId, @email, @firstName, @lastName,
       @templateName, @subject, @html, @txt, 'queued', @createdAt, @sendLogId)
  `);

  for (const id of contactIds) {
    const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(id);
    if (!contact) {
      results.push({ id, status: 'error', error: 'Contact not found' });
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
      createdAt: now,
      sendLogId: logRow.lastInsertRowid,
    });

    db.prepare('UPDATE send_log SET sendJobId=? WHERE id=?')
      .run(jobRow.lastInsertRowid, logRow.lastInsertRowid);

    // Mark contact so the scheduler doesn't re-pick it for other campaigns
    db.prepare("UPDATE contacts SET status='queued' WHERE id=?").run(id);

    results.push({ id, email: contact.email, status: 'queued', jobId: jobRow.lastInsertRowid });
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
