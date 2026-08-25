import db from '../db.js';

// ─── CampaignButtonRepository ─────────────────────────────────────────────────
// The per-campaign FROZEN snapshot of a button. Created once per (campaign,
// button) at queue time. The click redirect ALWAYS resolves its destination from
// here, so editing/deleting the underlying button never changes an already-queued
// campaign's links (historical consistency).
//
// HARD-FAIL contract: findOrCreate throws an actionable error if the referenced
// button is missing or inactive. Callers must abort the send — a campaign must
// never go out with a missing/broken CTA (approved decision Z-7).

export function findByCampaign(campaignId) {
  return db.prepare('SELECT * FROM campaign_buttons WHERE campaign_id = ?').all(campaignId)
    .map(r => ({ ...r, style: safeParse(r.style) }));
}

export function findById(id) {
  const r = db.prepare('SELECT * FROM campaign_buttons WHERE id = ?').get(id);
  return r ? { ...r, style: safeParse(r.style) } : null;
}

// findOrCreate(campaignId, buttonId) → snapshot row { id, text, destination_url, style }
// Idempotent per (campaign, button). Throws on missing/inactive button.
export function findOrCreate(campaignId, buttonId) {
  const existing = db.prepare(
    'SELECT * FROM campaign_buttons WHERE campaign_id = ? AND button_id = ?'
  ).get(campaignId, buttonId);
  if (existing) return { ...existing, style: safeParse(existing.style) };

  const button = db.prepare('SELECT * FROM buttons WHERE id = ?').get(buttonId);
  if (!button) {
    throw new Error(`Button #${buttonId} referenced by the template no longer exists — remove it from the template or recreate the button before sending`);
  }
  if (button.status !== 'active') {
    throw new Error(`Button "${button.internal_name}" (#${buttonId}) is inactive — activate it or remove it from the template before sending`);
  }

  const now = new Date().toISOString();
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO campaign_buttons (campaign_id, button_id, text, destination_url, style, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(campaignId, buttonId, button.text, button.destination_url, button.style, now);
  return findById(lastInsertRowid);
}

// Validate every button referenced by a template body BEFORE any job is created,
// so a bad button aborts the whole campaign cleanly (no partially-queued send).
// Snapshots are created as a side effect (idempotent). Throws on the first bad one.
export function snapshotAll(campaignId, buttonIds) {
  for (const id of buttonIds) findOrCreate(campaignId, id);
}

// Campaign-independent validity check (no snapshot). Throws an actionable error on
// the first missing/inactive button — used to pre-validate a template before a
// campaign/dispatch even exists.
export function assertButtonsValid(buttonIds) {
  for (const id of buttonIds) {
    const b = db.prepare('SELECT internal_name, status FROM buttons WHERE id = ?').get(id);
    if (!b) {
      throw new Error(`Button #${id} referenced by the template no longer exists — remove it from the template or recreate the button before sending`);
    }
    if (b.status !== 'active') {
      throw new Error(`Button "${b.internal_name}" (#${id}) is inactive — activate it or remove it from the template before sending`);
    }
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
