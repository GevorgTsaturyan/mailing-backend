import 'dotenv/config';

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set. Generate one with: openssl rand -hex 64');
  process.exit(1);
}

import express from 'express';
import cors from 'cors';
import db from './db.js';
import { seedDevData } from './seed.js';

import authRouter               from './routes/auth.js';
import contactsRouter           from './routes/contacts.js';
import failedMailsRouter         from './routes/failed-mails.js';
import groupsRouter             from './routes/groups.js';
import templatesRouter          from './routes/templates.js';
import sendRouter               from './routes/send.js';
import scheduleRouter           from './routes/schedule.js';
import scheduledSendsRouter     from './routes/scheduled-sends.js';
import recurringCampaignsRouter from './routes/recurring-campaigns.js';
import logRouter                from './routes/log.js';
import smtpRouter               from './routes/smtp.js';
import providersRouter          from './routes/providers.js';
import serversRouter            from './routes/servers.js';
import senderIdentitiesRouter   from './routes/sender-identities.js';
import adminRouter               from './routes/admin.js';
import nodesRouter              from './routes/nodes.js';
import jobsRouter               from './routes/jobs.js';
import unsubscribeRouter        from './routes/unsubscribe.js';
import trackRouter              from './routes/track.js';
import buttonsRouter            from './routes/buttons.js';
import engagementRouter         from './routes/engagement.js';
import inboxRouter              from './routes/inbox.js';
import dashboardRouter          from './routes/dashboard.js';
import { cancelOutstandingJobsForContact } from './services/SuppressionService.js';
import { requireAuth } from './middleware/auth.js';
import { initScheduler } from './scheduler.js';
import { runBackfillOnce } from './services/SendLedger.js';
import { startOfflineWatcher } from './services/HeartbeatService.js';
import { startReadinessWatcher } from './services/TrackingHostReadiness.js';
import { startUnsubscribeReadinessWatcher } from './services/UnsubscribeHostReadiness.js';
import { startProvisioningRetryService } from './services/ProvisioningRetryService.js';

const app = express();
const PORT = 3001;

// Trusted-proxy configuration so req.ip reflects the real client (the hop our own
// reverse proxy appended) and a client-supplied X-Forwarded-For cannot spoof it.
// Default 'loopback' = trust only a local nginx (controller sits behind local
// nginx per TRACKING.md/UNSUBSCRIBE.md). Override with TRUST_PROXY (number of
// proxies, a boolean, or a subnet list) for other topologies.
function parseTrustProxy(v) {
  if (v == null || v === '') return 'loopback';
  if (v === 'true')  return true;
  if (v === 'false') return false;
  const n = Number(v);
  return Number.isInteger(n) ? n : v;
}
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
];
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '10mb' }));

// Public routes
app.use('/api/auth', authRouter);

// Node agent routes — no JWT, authenticated by per-server apiKey
app.use('/api/nodes', nodesRouter);

// Job queue API — registered before requireAuth so node endpoints use apiKey auth.
// POST /api/jobs (create) applies requireAuth internally via the router.
app.use('/api/jobs', jobsRouter);

// Token-based unsubscribe (RFC 8058 one-click + visible-body flow) — public.
// Recipient-facing routes: GET/POST /u/:token   (see routes/unsubscribe.js)
app.use(unsubscribeRouter);

// Public click/open tracking — no JWT. Recipient-facing routes served under
// click.<sending-domain>: GET /c/:token (302 redirect) + GET /o/:token.gif (pixel).
// Mounted before requireAuth, exactly like the unsubscribe routes. (see routes/track.js)
app.use(trackRouter);

// ── Legacy unsubscribe compatibility shim (deprecated) ────────────────────────
// Emails sent before the token system used `/unsubscribe?email=<addr>`. Those
// links must keep working, but the GET must NOT mutate (link scanners/prefetchers
// would otherwise unsubscribe engaged users). GET now renders a confirmation
// page; the POST performs the change. New emails never use this path.
app.get('/unsubscribe', express.urlencoded({ extended: false }), (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).send('Missing email');
  const safe = String(email).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  res.send(`
    <html><body style="font-family:system-ui,sans-serif;text-align:center;padding:60px">
      <h2>Unsubscribe from our emails?</h2>
      <p>Confirm to stop receiving campaigns at <strong>${safe}</strong>.</p>
      <form method="POST" action="/unsubscribe">
        <input type="hidden" name="email" value="${safe}">
        <button type="submit" style="font-size:16px;padding:12px 28px;border:0;border-radius:6px;background:#d33;color:#fff;cursor:pointer">Unsubscribe</button>
      </form>
    </body></html>
  `);
});
app.post('/unsubscribe', express.urlencoded({ extended: false }), (req, res) => {
  const email = req.body?.email || req.query.email;
  if (!email) return res.status(400).send('Missing email');
  const norm = String(email).toLowerCase();
  const contact = db.prepare('SELECT id FROM contacts WHERE email=?').get(norm);
  db.prepare("UPDATE contacts SET status='unsubscribed' WHERE email=? AND status!='unsubscribed'").run(norm);
  // Cancel any jobs queued before this unsubscribe.
  if (contact) cancelOutstandingJobsForContact(contact.id, 'unsubscribed');
  res.status(200).send(`
    <html><body style="font-family:system-ui,sans-serif;text-align:center;padding:60px">
      <h2>You have been unsubscribed</h2>
      <p>You will no longer receive campaigns at this address.</p>
    </body></html>
  `);
});

// All API routes below require a valid JWT
app.use('/api', requireAuth);
app.use('/api/contacts',             contactsRouter);
app.use('/api/failed-mails',         failedMailsRouter);
app.use('/api/groups',               groupsRouter);
app.use('/api/templates',            templatesRouter);
app.use('/api/send',                 sendRouter);
app.use('/api/schedule',             scheduleRouter);
app.use('/api/scheduled-sends',      scheduledSendsRouter);
app.use('/api/recurring-campaigns',  recurringCampaignsRouter);
app.use('/api/log',                  logRouter);
app.use('/api/smtp',                 smtpRouter);
app.use('/api/providers',            providersRouter);
app.use('/api/servers',              serversRouter);
app.use('/api/sender-identities',    senderIdentitiesRouter);
app.use('/api/admin',                adminRouter);
app.use('/api/buttons',              buttonsRouter);
app.use('/api/engagement',           engagementRouter);
app.use('/api/inbox',                inboxRouter);
app.use('/api/dashboard',            dashboardRouter);

seedDevData();

app.listen(PORT, () => {
  console.log(`[startup] Database initialized`);
  console.log(`[startup] Queue mode: ${process.env.USE_CANONICAL_QUEUE === 'true' ? 'Canonical' : 'Legacy'}`);
  console.log(`[startup] Backend listening on http://localhost:${PORT}`);
  // One-time Phase 3 ledger backfill — MUST run before the scheduler can plan any
  // sends, so existing recurring campaigns / daily batch do not resend contacts
  // they already handled once selection moved off status='pending'. Guarded +
  // atomic (see SendLedger.runBackfillOnce): runs exactly once, never re-seeds
  // after post-migration sends.
  try {
    const { ran, seeded } = runBackfillOnce();
    if (ran) console.log(`[startup] Ledger backfill complete: seeded ${seeded} ledger row(s)`);
    else     console.log('[startup] Ledger backfill already applied — skipping');
  } catch (err) {
    console.error('[startup] Ledger backfill FAILED — halting to avoid unsafe resends:', err.message);
    process.exit(1);
  }
  initScheduler();
  console.log('[startup] Scheduler initialized');
  startOfflineWatcher();
  startReadinessWatcher();
  console.log('[startup] Tracking-host readiness watcher started');
  startUnsubscribeReadinessWatcher();
  console.log('[startup] Unsubscribe-host readiness watcher started (campaign dispatch gated until verified)');
  startProvisioningRetryService();
  console.log('[startup] Provisioning retry service started');
});
