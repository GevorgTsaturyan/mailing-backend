import express from 'express';
import db from '../db.js';
import { getUnreadCount } from '../services/InboxRepository.js';

const router = express.Router();

router.get('/', (req, res) => {
  // Contact counts
  const contacts = db.prepare(`
    SELECT
      COUNT(*)                                          AS total,
      COUNT(CASE WHEN status='sent'         THEN 1 END) AS sent,
      COUNT(CASE WHEN status='pending'      THEN 1 END) AS pending,
      COUNT(CASE WHEN status='failed'       THEN 1 END) AS failed,
      COUNT(CASE WHEN status='unsubscribed' THEN 1 END) AS unsubscribed
    FROM contacts
  `).get();

  // Sender identities (for health panel)
  const identities = db.prepare(`
    SELECT si.id, si.fromAddr, si.fromName, si.domain,
           si.status, si.verificationStatus, si.provisioningStatus,
           se.label AS serverLabel
    FROM sender_identities si
    LEFT JOIN servers se ON se.id = si.serverId
    ORDER BY si.id
  `).all();

  // Recent campaigns (last 6) with delivery rate
  const recentCampaigns = db.prepare(`
    SELECT c.id, c.type, c.label, c.status, c.date,
           s.total_sent, s.total_delivered,
           si.fromAddr AS identity_from, si.domain AS identity_domain
    FROM campaigns c
    LEFT JOIN campaign_stats s    ON s.campaign_id = c.id
    LEFT JOIN sender_identities si ON si.id = c.identity_id
    ORDER BY c.id DESC
    LIMIT 6
  `).all();

  // All-time totals from campaign_stats
  const totals = db.prepare(`
    SELECT COALESCE(SUM(total_sent), 0)      AS emails_sent,
           COALESCE(SUM(total_delivered), 0) AS emails_delivered,
           COUNT(DISTINCT campaign_id)        AS campaign_count
    FROM campaign_stats
  `).get();

  // Inbox unread
  const inboxUnread = getUnreadCount({});

  // Recent send log (last 15)
  const recentLog = db.prepare(`
    SELECT id, date, email, template, status, error, subject
    FROM send_log
    ORDER BY id DESC
    LIMIT 15
  `).all();

  res.json({ contacts, identities, recentCampaigns, totals, inboxUnread, recentLog });
});

export default router;
