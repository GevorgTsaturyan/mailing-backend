import express from 'express';
import * as Engagement from '../services/EngagementRepository.js';
import * as TrackingConfig from '../services/TrackingConfigRepository.js';
import * as Readiness from '../services/TrackingHostReadiness.js';
import { findById as findCampaign } from '../services/CampaignRepository.js';
import db from '../db.js';

const router = express.Router();

// ── Tracking-host readiness (the open-tracking provisioning gate) ──────────────
// GET returns the cached per-domain readiness (no probe). POST forces a live
// re-check of every active sending domain (DNS + TLS + nginx + endpoint).
router.get('/tracking-readiness', (req, res) => {
  res.json(Readiness.getStatus());
});
router.post('/tracking-readiness/verify', async (req, res) => {
  res.json(await Readiness.verifyAll());
});

// ── Global open-tracking config (default OFF) ──────────────────────────────────
router.get('/config', (req, res) => {
  res.json({ open_tracking_enabled: TrackingConfig.getGlobalOpenTracking() });
});

router.put('/config', (req, res) => {
  const enabled = !!req.body?.open_tracking_enabled;
  res.json({ open_tracking_enabled: TrackingConfig.setGlobalOpenTracking(enabled) });
});

// ── Per-campaign open-tracking override (null = inherit global, 0 = off, 1 = on) ─
router.put('/campaigns/:id/open-tracking', (req, res) => {
  const id = Number(req.params.id);
  if (!findCampaign(id)) return res.status(404).json({ error: 'Campaign not found' });
  let val = req.body?.override;
  if (val !== null && val !== 0 && val !== 1) return res.status(400).json({ error: 'override must be null, 0, or 1' });
  db.prepare('UPDATE campaigns SET open_tracking_override = ? WHERE id = ?').run(val, id);
  res.json({ id, open_tracking_override: val });
});

// ── Campaign list ──────────────────────────────────────────────────────────────
router.get('/campaigns', (req, res) => {
  res.json(Engagement.listCampaigns());
});

// ── Unified engagement report ──────────────────────────────────────────────────
router.get('/campaigns/:id/report', (req, res) => {
  const id = Number(req.params.id);
  if (!findCampaign(id)) return res.status(404).json({ error: 'Campaign not found' });

  // Enrich campaign row with sender identity and template name.
  // Template name source priority: scheduled_send → recurring_campaign → first job's send_log
  const campaign = db.prepare(`
    SELECT c.*,
           si.fromAddr AS identity_from,
           si.fromName AS identity_from_name,
           si.domain   AS identity_domain,
           COALESCE(
             ss.templateName,
             rc.templateName,
             (SELECT sl.template FROM jobs j
                JOIN send_log sl ON sl.id = j.send_log_id
               WHERE j.campaign_id = c.id AND j.send_log_id IS NOT NULL
               LIMIT 1)
           ) AS template_name
    FROM campaigns c
    LEFT JOIN sender_identities   si ON si.id = c.identity_id
    LEFT JOIN scheduled_sends     ss ON ss.id = c.scheduled_send_id
    LEFT JOIN recurring_campaigns rc ON rc.id = c.recurring_campaign_id
    WHERE c.id = ?
  `).get(id);

  res.json({
    campaign,
    summary:   Engagement.campaignSummary(id),
    recipients: Engagement.recipientRows(id),
    buttons:    Engagement.buttonRows(id),
    // Reminder surfaced to the UI: opens are MEASURED events, not confirmed human
    // opens. Raw Opens / Unique Openers are reliable counts of pixel requests;
    // they cannot be attributed to humans (Gmail proxies AND caches images — real
    // opens come from Google IPs and repeat opens may be cached/undercounted;
    // Apple Mail Privacy Protection pre-fetches on delivery, inflating opens).
    // "Opens (excl. prefetch)" removes only clearly-automated fetches and is still best-effort.
    opens_caveat: 'Opens are measured pixel requests, not confirmed human opens. Gmail proxies and caches images (real opens come from Google IPs; repeat opens may be undercounted) and Apple Mail Privacy Protection pre-fetches pixels on delivery. Treat opens as approximate; "excl. prefetch" removes only clearly-automated fetches.',
    clicks_caveat: 'Human Clicks is best-effort: local signals catch HEAD, prefetch, fast-timing, burst multi-button and known scanner networks, but cannot detect every GET-based security scanner. All classifications receive the same destination.',
  });
});

router.get('/campaigns/:id/buttons', (req, res) => {
  const id = Number(req.params.id);
  if (!findCampaign(id)) return res.status(404).json({ error: 'Campaign not found' });
  res.json(Engagement.buttonRows(id));
});

export default router;
