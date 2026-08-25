import db from '../db.js';

// ─── EngagementRepository ─────────────────────────────────────────────────────
// Read-only aggregation for the unified Campaign Engagement report. All counts
// are derived from the raw click_events / open_events logs, so improving the
// classifier and reclassifying historical rows automatically flows through here.
//
// Honesty note: opens are an UPPER BOUND (image proxies / Apple MPP prefetch
// inflate them). "Likely-human opens" is best-effort and must be labelled as such
// in the UI.

// Campaign-level summary.
export function campaignSummary(campaignId) {
  const stats = db.prepare('SELECT total_jobs, total_sent, total_delivered FROM campaign_stats WHERE campaign_id = ?').get(campaignId) || {};

  // Opens are MEASURED events, not asserted human opens. raw_opens/unique_openers
  // are the reliable figures; non_prefetch_opens excludes only clearly-automated
  // fetches (still best-effort — see classifyOpen).
  const opens = db.prepare(`
    SELECT
      COUNT(*)                                                  AS raw_opens,
      COUNT(DISTINCT contact_id)                                AS unique_openers,
      SUM(CASE WHEN classification='open'     THEN 1 ELSE 0 END) AS non_prefetch_opens,
      SUM(CASE WHEN classification='prefetch' THEN 1 ELSE 0 END) AS prefetch_opens,
      MIN(opened_at)                                            AS first_open,
      MAX(opened_at)                                            AS last_open
    FROM open_events WHERE campaign_id = ?
  `).get(campaignId);

  const clicks = db.prepare(`
    SELECT
      COUNT(*)                                                              AS raw_clicks,
      SUM(CASE WHEN classification='human' THEN 1 ELSE 0 END)               AS human_clicks,
      SUM(CASE WHEN classification IN ('bot','scanner') THEN 1 ELSE 0 END)  AS bot_scanner_clicks,
      SUM(CASE WHEN classification='unknown' THEN 1 ELSE 0 END)             AS unknown_clicks,
      COUNT(DISTINCT CASE WHEN classification='human' THEN contact_id END)  AS unique_human_clickers
    FROM click_events WHERE campaign_id = ?
  `).get(campaignId);

  return {
    sent:                  stats.total_sent      ?? 0,
    delivered:             stats.total_delivered ?? 0,
    raw_opens:             opens.raw_opens          ?? 0,
    unique_openers:        opens.unique_openers     ?? 0,
    non_prefetch_opens:    opens.non_prefetch_opens ?? 0,
    prefetch_opens:        opens.prefetch_opens     ?? 0,
    first_open:            opens.first_open         ?? null,
    last_open:             opens.last_open          ?? null,
    raw_clicks:            clicks.raw_clicks           ?? 0,
    human_clicks:          clicks.human_clicks         ?? 0,
    bot_scanner_clicks:    clicks.bot_scanner_clicks   ?? 0,
    unknown_clicks:        clicks.unknown_clicks       ?? 0,
    unique_human_clickers: clicks.unique_human_clickers ?? 0,
  };
}

// Recipient-level rows: opens (raw) with first/last, and HUMAN clicks with
// first/last human click.
export function recipientRows(campaignId) {
  const opens = db.prepare(`
    SELECT contact_id,
           COUNT(*)        AS opens,
           MIN(opened_at)  AS first_open,
           MAX(opened_at)  AS last_open
    FROM open_events WHERE campaign_id = ? AND contact_id IS NOT NULL
    GROUP BY contact_id
  `).all(campaignId);

  const clicks = db.prepare(`
    SELECT contact_id,
           SUM(CASE WHEN classification='human' THEN 1 ELSE 0 END)               AS clicks,
           MIN(CASE WHEN classification='human' THEN clicked_at END)             AS first_click,
           MAX(CASE WHEN classification='human' THEN clicked_at END)             AS last_click
    FROM click_events WHERE campaign_id = ? AND contact_id IS NOT NULL
    GROUP BY contact_id
  `).all(campaignId);

  const byContact = new Map();
  for (const o of opens) byContact.set(o.contact_id, { contact_id: o.contact_id, opens: o.opens, first_open: o.first_open, last_open: o.last_open, clicks: 0, first_click: null, last_click: null });
  for (const c of clicks) {
    const row = byContact.get(c.contact_id) || { contact_id: c.contact_id, opens: 0, first_open: null, last_open: null };
    row.clicks = c.clicks || 0;
    row.first_click = c.first_click;
    row.last_click = c.last_click;
    byContact.set(c.contact_id, row);
  }

  const ids = [...byContact.keys()];
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const contacts = db.prepare(`SELECT id, firstName, lastName, email FROM contacts WHERE id IN (${placeholders})`).all(...ids);
    const cmap = new Map(contacts.map(c => [c.id, c]));
    for (const row of byContact.values()) {
      const c = cmap.get(row.contact_id);
      row.email = c?.email ?? null;
      row.name = c ? `${c.firstName} ${c.lastName}` : null;
    }
  }

  return [...byContact.values()].sort((a, b) => (b.clicks - a.clicks) || (b.opens - a.opens));
}

// Button-level performance for a campaign.
export function buttonRows(campaignId) {
  return db.prepare(`
    SELECT cb.id AS campaign_button_id, cb.button_id, cb.text, cb.destination_url,
           b.internal_name,
           COUNT(ce.id)                                                          AS raw_clicks,
           SUM(CASE WHEN ce.classification='human' THEN 1 ELSE 0 END)            AS human_clicks,
           COUNT(DISTINCT CASE WHEN ce.classification='human' THEN ce.contact_id END) AS unique_human_clickers
    FROM campaign_buttons cb
    LEFT JOIN buttons b       ON b.id = cb.button_id
    LEFT JOIN click_events ce ON ce.campaign_button_id = cb.id
    WHERE cb.campaign_id = ?
    GROUP BY cb.id
    ORDER BY human_clicks DESC
  `).all(campaignId);
}

// Campaign list for report navigation (most recent first).
export function listCampaigns(limit = 100) {
  return db.prepare(`
    SELECT c.id, c.type, c.label, c.status, c.date, c.created_at,
           s.total_sent, s.total_delivered
    FROM campaigns c
    LEFT JOIN campaign_stats s ON s.campaign_id = c.id
    ORDER BY c.id DESC
    LIMIT ?
  `).all(limit);
}
