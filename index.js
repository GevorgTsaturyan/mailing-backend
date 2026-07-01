import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import contactsRouter from './routes/contacts.js';
import templatesRouter from './routes/templates.js';
import sendRouter from './routes/send.js';
import scheduleRouter from './routes/schedule.js';
import logRouter from './routes/log.js';
import { initScheduler } from './scheduler.js';

const app = express();
const PORT = 3001;

app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:5174'] }));
app.use(express.json());

app.use('/api/contacts', contactsRouter);
app.use('/api/templates', templatesRouter);
app.use('/api/send', sendRouter);
app.use('/api/schedule', scheduleRouter);
app.use('/api/log', logRouter);

app.listen(PORT, async () => {
  console.log(`Mail Campaign Manager backend running on http://localhost:${PORT}`);
  await initScheduler();
});
