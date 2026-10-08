import express from 'express';
import db from '../db.js';
import { getUnreadCount } from '../services/InboxRepository.js';

const router = express.Router();

// UTC date helpers — campaigns.date is stored as a UTC 'YYYY-MM-DD' string
// (new Date().toISOString().slice(0,10)), so day buckets must be computed in UTC
// to line up with how campaigns are dispatched.
function utcDay(offset = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

router.get('/', (req, res) => {
  const today      = utcDay(0);
  const yesterday  = utcDay(-1);
  const TREND_DAYS = 14;
  const since      = utcDay(-(TREND_DAYS - 1));   // inclusive 14-day window

  // ── Contact counts ────────────────────────────────────────────────────────
  const contacts = db.prepare(`
    SELECT
      COUNT(*)                                          AS total,
      COUNT(CASE WHEN status='sent'         THEN 1 END) AS sent,
      COUNT(CASE WHEN status='pending'      THEN 1 END) AS pending,
      COUNT(CASE WHEN status='failed'       THEN 1 END) AS failed,
      COUNT(CASE WHEN status='unsubscribed' THEN 1 END) AS unsubscribed
    FROM contacts
  `).get();

  const failedMails = db.prepare('SELECT COUNT(*) AS n FROM failed_mails').get().n;

  // ── Sender identities (health panel) ────────────────────────────────────────
  const identities = db.prepare(`
    SELECT si.id, si.fromAddr, si.fromName, si.domain,
           si.status, si.verificationStatus, si.provisioningStatus,
           se.label AS serverLabel
    FROM sender_identities si
    LEFT JOIN servers se ON se.id = si.serverId
    ORDER BY si.id
  `).all();

  // ── All-time totals ─────────────────────────────────────────────────────────
  const stats = db.prepare(`
    SELECT COALESCE(SUM(total_sent), 0)      AS emails_sent,
           COALESCE(SUM(total_delivered), 0) AS emails_delivered,
           COALESCE(SUM(total_bounced), 0)   AS emails_bounced,
           COUNT(DISTINCT campaign_id)        AS campaign_count
    FROM campaign_stats
  `).get();
  // Globally-unique engaged contacts (distinct across ALL campaigns).
  const uniqueOpens  = db.prepare('SELECT COUNT(DISTINCT contact_id) AS n FROM open_events  WHERE contact_id IS NOT NULL').get().n;
  const uniqueClicks = db.prepare('SELECT COUNT(DISTINCT contact_id) AS n FROM click_events WHERE contact_id IS NOT NULL').get().n;
  const totals = { ...stats, unique_opens: uniqueOpens, unique_clicks: uniqueClicks };

  // ── Per-campaign rows for the last 14 days (today + yesterday + trend) ───────
  // unique_opens / unique_clicks = distinct contacts who opened / clicked.
  const windowCampaigns = db.prepare(`
    SELECT c.id, c.type, c.label, c.status, c.date,
           si.fromAddr AS identity_from, si.domain AS identity_domain,
           COALESCE(s.total_sent, 0)      AS total_sent,
           COALESCE(s.total_delivered, 0) AS total_delivered,
           COALESCE(s.total_bounced, 0)   AS total_bounced,
           (SELECT COUNT(DISTINCT oe.contact_id) FROM open_events  oe WHERE oe.campaign_id = c.id AND oe.contact_id IS NOT NULL) AS unique_opens,
           (SELECT COUNT(DISTINCT ce.contact_id) FROM click_events ce WHERE ce.campaign_id = c.id AND ce.contact_id IS NOT NULL) AS unique_clicks
    FROM campaigns c
    LEFT JOIN campaign_stats    s  ON s.campaign_id = c.id
    LEFT JOIN sender_identities si ON si.id = c.identity_id
    WHERE c.date >= ?
    ORDER BY c.id DESC
  `).all(since);

  const summarise = (rows) => rows.reduce((a, c) => ({
    campaigns_count: a.campaigns_count + 1,
    sent:            a.sent          + c.total_sent,
    delivered:       a.delivered     + c.total_delivered,
    unique_opens:    a.unique_opens  + c.unique_opens,
    unique_clicks:   a.unique_clicks + c.unique_clicks,
  }), { campaigns_count: 0, sent: 0, delivered: 0, unique_opens: 0, unique_clicks: 0 });

  const todayCampaigns     = windowCampaigns.filter(c => c.date === today);
  const yesterdayCampaigns = windowCampaigns.filter(c => c.date === yesterday);

  // ── 14-day trend (one bucket per calendar day, zero-filled) ──────────────────
  const byDate = new Map();
  for (const c of windowCampaigns) {
    if (!byDate.has(c.date)) byDate.set(c.date, { date: c.date, campaigns: 0, sent: 0, delivered: 0, unique_opens: 0, unique_clicks: 0 });
    const b = byDate.get(c.date);
    b.campaigns     += 1;
    b.sent          += c.total_sent;
    b.delivered     += c.total_delivered;
    b.unique_opens  += c.unique_opens;
    b.unique_clicks += c.unique_clicks;
  }
  const trend = [];
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    const day = utcDay(-i);
    trend.push(byDate.get(day) || { date: day, campaigns: 0, sent: 0, delivered: 0, unique_opens: 0, unique_clicks: 0 });
  }

  // ── Inbox + recent activity ──────────────────────────────────────────────────
  const inboxUnread = getUnreadCount({});
  const recentLog = db.prepare(`
    SELECT id, date, email, template, status, error, subject
    FROM send_log
    ORDER BY id DESC
    LIMIT 15
  `).all();

  res.json({
    contacts,
    failedMails,
    identities,
    totals,
    today:     { date: today,     ...summarise(todayCampaigns) },
    yesterday: { date: yesterday, ...summarise(yesterdayCampaigns) },
    todayCampaigns,
    yesterdayCampaigns,
    trend,
    inboxUnread,
    recentLog,
  });
});

export default router;
