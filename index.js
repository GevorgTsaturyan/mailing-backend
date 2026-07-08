import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import db from './db.js';

import authRouter           from './routes/auth.js';
import contactsRouter       from './routes/contacts.js';
import templatesRouter      from './routes/templates.js';
import sendRouter           from './routes/send.js';
import scheduleRouter       from './routes/schedule.js';
import scheduledSendsRouter from './routes/scheduled-sends.js';
import logRouter            from './routes/log.js';
import smtpRouter           from './routes/smtp.js';
import { requireAuth } from './middleware/auth.js';
import { initScheduler } from './scheduler.js';

const app = express();
const PORT = 3001;

app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:5174'] }));
app.use(express.json());

// Public routes
app.use('/api/auth', authRouter);

// Unsubscribe link — public, no auth needed
app.get('/unsubscribe', (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).send('Missing email');
  db.prepare("UPDATE contacts SET status='unsubscribed' WHERE email=?").run(email.toLowerCase());
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h2>You have been unsubscribed</h2>
      <p>The email address <strong>${email}</strong> will no longer receive campaigns.</p>
    </body></html>
  `);
});

// All API routes below require a valid JWT
app.use('/api', requireAuth);
app.use('/api/contacts',        contactsRouter);
app.use('/api/templates',       templatesRouter);
app.use('/api/send',            sendRouter);
app.use('/api/schedule',        scheduleRouter);
app.use('/api/scheduled-sends', scheduledSendsRouter);
app.use('/api/log',             logRouter);
app.use('/api/smtp',            smtpRouter);

app.listen(PORT, () => {
  console.log(`Mail Campaign Manager backend on http://localhost:${PORT}`);
  initScheduler();
});
