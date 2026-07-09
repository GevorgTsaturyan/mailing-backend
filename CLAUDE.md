# Mail Campaign Manager — Project Documentation

## What this project is
A full-stack email campaign management system built by the user with Claude Code.
Sends bulk emails to a contact list using scheduled or manual campaigns.

- **Backend**: Node.js + Express + SQLite on port 3001
- **Frontend**: Vue 3 + Pinia + Tailwind CSS on port 5173
- **Email sending**: Nodemailer (Ethereal fake SMTP in dev, real SMTP in production)
- **Scheduling**: node-cron (daily batch at a configured time)
- **Auth**: JWT tokens, 7-day expiry, stored in localStorage

---

## How to run

```bash
# Backend
cd backend && npm install && node index.js

# Frontend (separate terminal)
cd frontend && npm install && npm run dev
```

Backend: http://localhost:3001  
Frontend: http://localhost:5173

---

## Project file map

```
mail-campaign-manager/
  backend/
    index.js              # Express entry: mounts all routes, unsubscribe endpoint
    db.js                 # SQLite setup (better-sqlite3), creates all tables on startup
    mailer.js             # Nodemailer: send one email, auto picks Ethereal if no SMTP configured
    scheduler.js          # node-cron: daily batch sender, reads schedule_config from DB
    create-admin.js       # CLI script to create or reset admin user password
    migrate.js            # One-time migration from JSON files to SQLite (already done)
    middleware/
      auth.js             # JWT requireAuth middleware — applied to all /api/* except /api/auth
    routes/
      auth.js             # POST /api/auth/login, GET /api/auth/me
      contacts.js         # GET/POST/PUT/DELETE /api/contacts, POST /api/contacts/import
      templates.js        # GET/POST/PUT/DELETE /api/templates, GET /api/templates/:name
      send.js             # POST /api/send — manual campaign send
      schedule.js         # GET/POST /api/schedule — read/update scheduler config
      log.js              # GET /api/log, DELETE /api/log — send history
      smtp.js             # GET /api/smtp, PUT /api/smtp, POST /api/smtp/test
    data/
      mail.db             # SQLite database (THE real database — all data lives here)
      mail.db-shm         # SQLite WAL shared memory (auto-generated)
      mail.db-wal         # SQLite WAL log (auto-generated)
      contacts.json       # LEGACY — no longer used by the app, safe to delete
      schedule.json       # LEGACY — no longer used
      sendLog.json        # LEGACY — no longer used
    templates/
      welcome.html        # Default HTML email template file (loaded into DB)
      welcome.txt         # Default plain text version

  frontend/
    src/
      main.js             # Vue app entry
      App.vue             # Root: shows NavBar + <router-view>
      style.css           # Global styles
      api/
        index.js          # Axios instance (baseURL: localhost:3001/api), JWT interceptor,
                          # 401 → auto logout. Exports: contactsApi, templatesApi,
                          # sendApi, scheduleApi, logApi, smtpApi
      router/
        index.js          # Routes: /, /login, /contacts, /templates, /scheduler,
                          # /settings, /unsubscribed. Auth guard: redirect to /login if no token.
      stores/
        auth.js           # Pinia: token, username, login(), logout()
        contacts.js       # Pinia: contacts[], fetchContacts, createContact, updateContact,
                          # deleteContact, resetStatus, importCsv
                          # Getters: total, sent, pending, failed, unsubscribed (counts)
        campaign.js       # Pinia: templates[], sendLog[], schedule{}, smtp{}
                          # Actions: fetchTemplates, sendCampaign, fetchLog, clearLog,
                          # fetchSchedule, updateSchedule, fetchSmtp, updateSmtp, testSmtp
      views/
        Login.vue         # Login form — POST /api/auth/login, saves token to localStorage
        Dashboard.vue     # Stats cards + recent send log + Send Now modal
        Contacts.vue      # Full contact list with: Add, Edit, Delete, Reset status,
                          # Download Sample CSV, Import CSV, bulk select
        Unsubscribed.vue  # List of unsubscribed contacts, Re-subscribe button
        Templates.vue     # Template list sidebar + preview/edit (tabs: preview, html, txt)
        Scheduler.vue     # Configure daily send time, batch size, template, enable/disable
        Settings.vue      # SMTP config form + Test Connection button
      components/
        NavBar.vue        # Top nav: Dashboard, Contacts, Unsubscribed, Templates,
                          # Scheduler, SMTP Settings, Logout button
        StatsCard.vue     # Single stat display (label + number + color)
        ContactTable.vue  # Table with checkboxes, status badges, Edit button
        LogTable.vue      # Send log table (date, name, email, template, status, preview link)
        TemplatePreview.vue # Renders email HTML in a sandboxed iframe with variable substitution
```

---

## Database schema (mail.db)

```sql
contacts (id, firstName, lastName, email UNIQUE, status, sentAt)
  status values: 'pending' | 'sent' | 'failed' | 'unsubscribed'

templates (name PK, subject, html, txt)

send_log (id, date, contactId, name, email, template, status, previewUrl, error)

schedule_config (id=1 only, enabled 0/1, time '09:00', batchSize, template)

smtp_config (id=1 only, host, port, secure 0/1, user, pass, fromName, fromAddr)

users (id, username UNIQUE, passwordHash)
```

---

## API reference

### Auth
| Method | Path | Body / Params | Response |
|--------|------|---------------|----------|
| POST | /api/auth/login | `{username, password}` | `{token, username}` |
| GET | /api/auth/me | — (JWT required) | `{username}` |

### Contacts
| Method | Path | Notes |
|--------|------|-------|
| GET | /api/contacts | returns all contacts ordered by id |
| POST | /api/contacts | `{firstName, lastName, email}` |
| PUT | /api/contacts/:id | partial update any field including status |
| DELETE | /api/contacts/:id | — |
| POST | /api/contacts/import | multipart `file` field, CSV with columns firstName/lastName/email |

### Templates
| Method | Path | Notes |
|--------|------|-------|
| GET | /api/templates | returns array of names |
| GET | /api/templates/:name | full template object |
| POST | /api/templates | `{name, subject, html, txt}` |
| PUT | /api/templates/:name | update subject/html/txt |
| DELETE | /api/templates/:name | — |

### Send
| Method | Path | Notes |
|--------|------|-------|
| POST | /api/send | `{contactIds: [], templateName}` OR `{contactIds: [], subject, html, txt}` — sends to given IDs, logs results |
| | | Custom mode: pass `subject` + optional `html`/`txt`. Template mode: pass `templateName`. |
| | | Both modes support `{{firstName}}`, `{{lastName}}`, `{{unsubscribeLink}}` variables. |

### Schedule
| Method | Path | Notes |
|--------|------|-------|
| GET | /api/schedule | returns schedule_config row |
| POST | /api/schedule | `{time, batchSize, template, enabled}` — saves and restarts cron |

### Log
| Method | Path | Notes |
|--------|------|-------|
| GET | /api/log | all send_log rows, newest first |
| DELETE | /api/log | clears all log entries |

### SMTP
| Method | Path | Notes |
|--------|------|-------|
| GET | /api/smtp | current config (pass field is empty for security) |
| PUT | /api/smtp | update config, blank pass = keep existing |
| POST | /api/smtp/test | verify connection with given credentials |

### Unsubscribe (public, no auth)
| Method | Path | Notes |
|--------|------|-------|
| GET | /unsubscribe?email=x | sets contact status to 'unsubscribed', shows HTML confirmation |

---

## Email sending flow

1. `mailer.js:sendCampaignEmail({ to, templateName, variables })` is called
2. Fetches template from DB, fetches smtp_config from DB
3. Merges variables: `{ bonusAmount:'100', promoCode:'WELCOME100', unsubscribeLink, ...custom }`
4. `unsubscribeLink` = `http://localhost:3001/unsubscribe?email=<encoded>` (**must change to real domain in production**)
5. Renders template: replaces `{{variableName}}` placeholders in subject/html/txt
6. If SMTP configured (host+user+pass set): uses real SMTP
7. If not configured: auto-creates Ethereal test account, prints preview URL to console
8. Adds `List-Unsubscribe` header (Gmail shows built-in unsubscribe button)

### Template variables available in every email
- `{{firstName}}` — contact's first name
- `{{lastName}}` — contact's last name
- `{{bonusAmount}}` — hardcoded "100" (customizable via variables param)
- `{{promoCode}}` — hardcoded "WELCOME100"
- `{{unsubscribeLink}}` — full unsubscribe URL for this contact

---

## Scheduler flow

`scheduler.js:planDaySends()` — called on startup and every midnight UTC:
1. Reads schedule_config (`startTime`, `endTime`, `batchSize`, `template`, `enabled`)
2. Calculates number of hours in the window: `numHours = ceil(rangeMinutes / 60)`
3. Divides batchSize evenly: `base = floor(batchSize / numHours)`, remainder spread across first hours
4. For each hour in the window, generates N random (minute, second) pairs
5. Schedules each send with `setTimeout` — fires `sendOnePendingContact(template)`
6. Each timer picks the lowest-id `pending` contact from DB and sends to it
7. Midnight cron (`0 0 * * *` UTC) calls `planDaySends()` to plan the next day

**Example**: 04:00–06:00 UTC, 20 emails → 10 random times in 04:xx, 10 random times in 05:xx

All times are UTC. The random distribution makes sends look human/manual.

---

## CSV import format

```
firstName,lastName,email
John,Smith,john@example.com
Jane,Doe,jane@example.com
```

Also accepts: `first_name`, `last_name`, `firstname`, `lastname`, `Email`, `EMAIL`  
Duplicate emails (already in DB) are silently skipped.

---

## Admin user management

```bash
cd backend
node create-admin.js <username> <password>
# creates new user or resets password if username exists
```

---

## Key decisions

- **SQLite over MySQL/PostgreSQL**: sufficient for one-user campaign manager, zero infra overhead
- **Ethereal auto-account**: no real emails sent in dev, safe to test freely
- **JWT in localStorage**: simple auth, 7-day tokens
- **`contacts.json` / `schedule.json` / `sendLog.json`**: legacy files from before SQLite migration, no longer used, safe to delete
- **`List-Unsubscribe` header**: added to every email so Gmail/Outlook show native unsubscribe button

---

## Production server

- **Provider**: Vultr VPS
- **IP**: 45.32.235.159
- **OS**: Ubuntu 22.04
- **Domain**: serawin.net — registered on GoDaddy, DNS managed in Cloudflare
- **App URL**: https://serawin.net
- **Stack**: Nginx + PM2 + Let's Encrypt SSL
- **Email**: Self-hosted Postfix + OpenDKIM (no third-party SMTP service)
- **Server path**: `/path/to/mail-campaign/` (backend and frontend are separate git repos)

### Server email setup
- Postfix configured as local send-only relay (`inet_interfaces = loopback-only`)
- OpenDKIM signs all outgoing mail with `mail._domainkey.serawin.net`
- SMTP config in DB: `host=localhost, port=25, secure=0, no auth`
- Setup script: `backend/setup-mail-server.sh` — run with `sudo bash setup-mail-server.sh` to install/reconfigure
- Vultr port 25 unblock: ticket submitted 2026-07-09, awaiting approval
- Test port 25: `telnet 142.250.27.27 25` — should show `220 mx.google.com ESMTP`

### Cloudflare DNS records (all DNS only, no proxy)
| Type | Name | Value |
|------|------|-------|
| A | serawin.net | 45.32.235.159 |
| A | mail.serawin.net | 45.32.235.159 |
| MX | @ | mail.serawin.net (priority 10) |
| TXT | @ | v=spf1 ip4:45.32.235.159 ~all |
| TXT | mail._domainkey | v=DKIM1; h=sha256; k=rsa; p=... |
| TXT | _dmarc | v=DMARC1; p=none; rua=mailto:admin@serawin.net |

### Environment variables (backend/.env — gitignored, must create manually on server)
```
JWT_SECRET=<long random string — generate with: openssl rand -hex 64>
APP_URL=https://serawin.net
```

---

## Session log

- **2026-07-09**: Production deployment + mail server setup session.
  - Fixed `mailer.js`: `unsubscribeLink` and `List-Unsubscribe` header now use `APP_URL` env var instead of hardcoded `localhost:3001`
  - Fixed `mailer.js`: SMTP transporter no longer requires `user`+`pass` — works with `host` only (needed for localhost Postfix with no auth)
  - Added `APP_URL=https://serawin.net` to `backend/.env` and `.env.example`
  - Created `backend/setup-mail-server.sh`: fully automated Postfix + OpenDKIM install/config script
  - Server: Vultr VPS (45.32.235.159, Ubuntu 22.04), domain serawin.net, DNS on Cloudflare
  - All 6 Cloudflare DNS records configured (A, MX, SPF, DKIM, DMARC — all DNS only)
  - Postfix + OpenDKIM installed and running on server
  - Vultr port 25 unblock ticket submitted, pending approval
  - Once port 25 approved: test with `telnet 142.250.27.27 25`, then send from app

- **2026-07-07**: Resumed project after gap. No prior memories existed. Set up CLAUDE.md + memory system.
  - Added "Download Sample CSV" button to Contacts page
  - Added Unsubscribed page (`/unsubscribed`) with re-subscribe action
  - Added Unsubscribed link to NavBar
  - Wrote full project documentation in this file
  - Discussed deployment plan: Hetzner VPS + GoDaddy domain + Brevo SMTP
  - Replaced single-time scheduler with random time-window scheduler:
    - DB: added `startTime` / `endTime` columns to `schedule_config`
    - Scheduler: uses `setTimeout` per email, random minute+second within each hour
    - Route: now accepts `startTime` / `endTime` instead of `time`
    - UI: new Scheduler page with start/end time pickers, UTC label, per-hour preview
  - Added "Send Email" button to Contacts page:
    - Select contacts via checkboxes → click "Send Email (N)"
    - Modal: two tabs — "Use Template" (pick from list) or "Write Custom" (subject + HTML body)
    - Custom mode supports `{{firstName}}`, `{{lastName}}`, `{{unsubscribeLink}}` variables
    - Results shown per contact with Ethereal preview links
    - Backend: `POST /api/send` now accepts either `templateName` or inline `subject/html/txt`
    - `mailer.js`: `sendCampaignEmail` now accepts `templateContent` object as alternative to `templateName`
  - Added individual scheduled sends feature:
    - New DB table: `scheduled_sends` (id, label, contactIds JSON, templateName, subject, html, txt, scheduledAt, status, createdAt, sentAt)
    - New route: `GET/POST/PUT/DELETE /api/scheduled-sends`
    - Scheduler checks every minute (`* * * * *`) for due scheduled sends and fires them
    - Contacts send modal: "Send now" vs "Schedule" radio toggle; schedule shows datetime-local + label inputs
    - Scheduler page: new "Scheduled Sends" table with edit (pending only) and delete per row
    - Edit modal: can change time, label, template or custom content
  - Added Recurring Campaigns feature:
    - DB table: `recurring_campaigns` (id, name, templateName, subject, html, txt, startTime, endTime, initialCount, increasePercent, status, currentDay, lastRunDate, createdAt)
    - Growth formula: `nextCount = round(initialCount * (1 + percent/100)^currentDay)`
    - Scheduler plans each active campaign at midnight UTC; marks lastRunDate to avoid double-planning
    - Each campaign sends to next N pending contacts (ordered by id) at random times in its window
    - When no pending contacts remain, campaign auto-completes
    - Routes: GET/POST/PUT/DELETE /api/recurring-campaigns, POST /:id/pause, POST /:id/resume
    - Scheduler.vue: new "Recurring Campaigns" section with table, create modal (name, window, day-1 count, growth %, template/custom, 5-day preview), edit/pause/resume/delete actions
