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
import nodesRouter              from './routes/nodes.js';
import jobsRouter               from './routes/jobs.js';
import { requireAuth } from './middleware/auth.js';
import { initScheduler } from './scheduler.js';
import { startOfflineWatcher } from './services/HeartbeatService.js';

const app = express();
const PORT = 3001;

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

// Unsubscribe link — public, no auth needed
app.get('/unsubscribe', (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).send('Missing email');
  db.prepare("UPDATE contacts SET status='unsubscribed' WHERE email=?").run(email.toLowerCase());
  const safe = email.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h2>You have been unsubscribed</h2>
      <p>The email address <strong>${safe}</strong> will no longer receive campaigns.</p>
    </body></html>
  `);
});

// All API routes below require a valid JWT
app.use('/api', requireAuth);
app.use('/api/contacts',             contactsRouter);
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

seedDevData();

app.listen(PORT, () => {
  console.log(`[startup] Database initialized`);
  console.log(`[startup] Queue mode: ${process.env.USE_CANONICAL_QUEUE === 'true' ? 'Canonical' : 'Legacy'}`);
  console.log(`[startup] Backend listening on http://localhost:${PORT}`);
  initScheduler();
  console.log('[startup] Scheduler initialized');
  startOfflineWatcher();
});
