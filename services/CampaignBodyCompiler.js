import db from '../db.js';
import * as CampaignButtonRepository from './CampaignButtonRepository.js';
import * as TrackingConfig from './TrackingConfigRepository.js';
import * as TrackingHostReadiness from './TrackingHostReadiness.js';
import { buildClickUrl, buildOpenPixelUrl } from './trackingToken.js';
import {
  compile, referencedButtonIds, hasButtonPlaceholder, renderButtonText,
} from './BodyCompiler.js';

// Log the readiness-gate suppression once per (campaign, domain) per process so an
// operator sees WHY open tracking is not being applied — never silent.
const warnedReadiness = new Set();
function warnReadinessOnce(campaignId, domain) {
  const key = `${campaignId}:${domain}`;
  if (warnedReadiness.has(key)) return;
  warnedReadiness.add(key);
  console.warn(`[tracking] open tracking is enabled but click.${domain} is not ready — suppressing pixel for campaign #${campaignId} to avoid shipping a broken pixel. Provision the tracking host (see TRACKING.md).`);
}

// ─── CampaignBodyCompiler ─────────────────────────────────────────────────────
// Glue between the pure BodyCompiler and the DB (button snapshots, tracking
// config, per-recipient token URLs). This is where campaign-specific tracking
// transformations happen — centrally, at queue time — so the mail-node stays
// unaware of buttons/pixels/tokens.

export function templateUsesButtons(tmpl) {
  return hasButtonPlaceholder(tmpl?.html) || hasButtonPlaceholder(tmpl?.txt);
}

function identityDomain(identityId) {
  const row = db.prepare('SELECT domain FROM sender_identities WHERE id = ?').get(identityId);
  if (!row?.domain) throw new Error(`Sender identity #${identityId} has no domain — cannot build tracking URLs`);
  return row.domain;
}

// Pre-validate every button a template references, BEFORE any job is created, so a
// missing/inactive button aborts the whole campaign cleanly (no partially-queued
// send). Campaign-independent (no snapshot yet — snapshots happen lazily in
// compileForContact). THROWS an actionable error naming the offending button.
export function assertTemplateButtonsValid(tmpl) {
  const ids = referencedButtonIds({ html: tmpl?.html, txt: tmpl?.txt });
  CampaignButtonRepository.assertButtonsValid(ids);
  return ids;
}

// compileForContact({ campaign, contact, identityId, tmpl })
//   → { body, bodyText } for the canonical job, or null when no compilation is
//     needed (no buttons AND open tracking disabled) — the caller then uses the
//     untouched template body and existing send behaviour is preserved.
//   THROWS on a missing/inactive button (hard-fail — never emit a broken CTA).
export function compileForContact({ campaign, contact, identityId, tmpl }) {
  const contentType = tmpl.content_type || 'html';
  const usesButtons = templateUsesButtons(tmpl);
  // Intent (admin setting) vs. effective injection. The pixel is injected only
  // when intent is ON *and* the sending domain's tracking host is provisioned/
  // ready — otherwise we'd ship a broken pixel. Not ready ⇒ send clean, no pixel.
  const openIntent  = contentType !== 'text' && TrackingConfig.isOpenTrackingEnabled(campaign);

  if (!usesButtons && !openIntent) return null;

  const domain     = identityDomain(identityId);
  const campaignId = campaign.id;
  const contactId  = contact.id;

  const openReady = openIntent && TrackingHostReadiness.isReady(domain);
  if (openIntent && !openReady) warnReadinessOnce(campaignId, domain);

  // If open tracking was the only reason to compile and the host isn't ready,
  // there is nothing to inject → leave the body unchanged.
  if (!usesButtons && !openReady) return null;

  const resolveSnapshot = (buttonId) => CampaignButtonRepository.findOrCreate(campaignId, buttonId);
  const clickUrl        = (cbId)     => buildClickUrl(domain, { campaignId, contactId, campaignButtonId: cbId });
  const pixelUrl        = openReady ? buildOpenPixelUrl(domain, { campaignId, contactId }) : null;

  const compiled = compile(
    { html: tmpl.html || '', txt: tmpl.txt || '' },
    { resolveSnapshot, clickUrl, pixelUrl },
  );

  if (contentType === 'text') {
    return { body: compiled.txt, bodyText: null };
  }

  // HTML email: body = compiled HTML; bodyText = a usable plain-text alternative.
  let bodyText = compiled.txt;
  if (usesButtons && !bodyText.trim()) {
    // The template has no text body — synthesise one so the plain-text part still
    // carries each CTA as "TEXT: url" (never a stripped, link-less button).
    bodyText = referencedButtonIds({ html: tmpl.html }).map(id => {
      const snap = resolveSnapshot(id);
      return renderButtonText(snap.text, clickUrl(snap.id));
    }).join('\n');
  }
  return { body: compiled.html, bodyText: bodyText || null };
}
