import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'data');

function readJson(file) {
  const p = path.join(DATA, file);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

// Contacts
const contacts = readJson('contacts.json');
if (contacts?.length) {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO contacts (id, firstName, lastName, email, status, sentAt)
    VALUES (@id, @firstName, @lastName, @email, @status, @sentAt)
  `);
  const many = db.transaction((rows) => rows.forEach(r => ins.run(r)));
  many(contacts);
  console.log(`Migrated ${contacts.length} contacts`);
}

// Send log
const log = readJson('sendLog.json');
if (log?.length) {
  const ins = db.prepare(`
    INSERT INTO send_log (date, contactId, name, email, template, status, previewUrl, error)
    VALUES (@date, @contactId, @name, @email, @template, @status, @previewUrl, @error)
  `);
  const many = db.transaction((rows) => rows.forEach(r => ins.run(r)));
  many(log.map(r => ({ ...r, previewUrl: r.previewUrl ?? null, error: r.error ?? null })));
  console.log(`Migrated ${log.length} log entries`);
}

// Templates — read .html/.txt files and insert into DB
const TMPL_DIR = path.join(__dirname, 'templates');
const files = fs.readdirSync(TMPL_DIR);
const names = [...new Set(files.map(f => f.replace(/\.(html|txt)$/, '')))];
const ins = db.prepare(`
  INSERT OR REPLACE INTO templates (name, subject, html, txt)
  VALUES (@name, @subject, @html, @txt)
`);
for (const name of names) {
  const htmlPath = path.join(TMPL_DIR, `${name}.html`);
  const txtPath  = path.join(TMPL_DIR, `${name}.txt`);
  ins.run({
    name,
    subject: 'Your Welcome Bonus Has Arrived',
    html: fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf-8') : '',
    txt:  fs.existsSync(txtPath)  ? fs.readFileSync(txtPath,  'utf-8') : '',
  });
  console.log(`Migrated template: ${name}`);
}

console.log('Migration complete.');
