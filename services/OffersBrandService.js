// ─── OffersBrandService — per-identity brand offers site ─────────────────────
//
// When an identity is provisioned, the controller (best-effort, never blocks
// sending):
//   1. registers the brand with the offers site (offers-site
//      POST /api/internal/brands) — the offers site generates a UNIQUE design,
//      copy and offer order for that domain on first registration and keeps it
//      stable afterwards;
//   2. creates a reusable CTA button "<Brand> Offers" → https://offers.<domain>/
//      so templates for that identity link to the SAME domain as the From
//      address (deliverability: no cross-domain or direct-casino links).
// DNS (CloudflareService a_offers) and nginx/TLS (provision-identity-hosts.sh)
// for offers.<domain> are handled by the existing pipeline when
// OFFERS_SITE_PORT is set.
//
// Env: OFFERS_SITE_PORT (enables the feature), OFFERS_SITE_INTERNAL_URL
// (default http://127.0.0.1:<OFFERS_SITE_PORT>), OFFERS_SITE_INTERNAL_KEY
// (shared secret; must equal INTERNAL_API_KEY in the offers-site .env).

import * as Buttons from './ButtonRepository.js';

export function isEnabled() {
  return Boolean(process.env.OFFERS_SITE_PORT && process.env.OFFERS_SITE_INTERNAL_KEY);
}

export function brandName(identity) {
  const n = String(identity.fromName || '').trim();
  if (n && !/^(support|info|team|newsletter|no-?reply|mail)$/i.test(n)) return n;
  const label = String(identity.domain || '').split('.')[0] || 'Offers';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function offersUrl(domain) {
  return `https://offers.${domain}/`;
}

export async function registerBrand(identity, fetchImpl = fetch) {
  const base = (process.env.OFFERS_SITE_INTERNAL_URL || `http://127.0.0.1:${process.env.OFFERS_SITE_PORT}`).replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/api/internal/brands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.OFFERS_SITE_INTERNAL_KEY },
    body: JSON.stringify({
      domain: identity.domain,
      site_name: brandName(identity),
      contact_email: identity.fromAddr || `support@${identity.domain}`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `offers-site HTTP ${res.status}`);
  return data;
}

// Idempotent: reuses any existing button that already targets offers.<domain>.
// The button takes the brand site's accent colour, so each brand's emails look different too.
export function ensureOffersButton(identity, brand = null) {
  const url = offersUrl(identity.domain);
  const existing = Buttons.list().find((b) => String(b.destination_url).replace(/\/+$/, '/') === url);
  if (existing) return { id: existing.id, created: false };
  const b = Buttons.create({
    internal_name: `${brandName(identity)} Offers`,
    text: 'See this week’s picks',
    destination_url: url,
    style: brand?.theme?.accent
      ? { background_color: brand.theme.accent, text_color: brand.theme.accent_text || '#ffffff', border_radius: Math.min(Number(brand.theme.button_radius ?? 8), 40) }
      : {},
    status: 'active',
  });
  return { id: b.id, created: true };
}

// Never throws. Returns a phase object for ProvisioningPhaseStore.
export async function provisionBrandSite(identity, { fetchImpl = fetch } = {}) {
  if (!isEnabled()) return { status: 'SKIPPED', message: 'OFFERS_SITE_PORT / OFFERS_SITE_INTERNAL_KEY not set' };
  try {
    const brand = await registerBrand(identity, fetchImpl);
    const btn = ensureOffersButton(identity, brand);
    return {
      status: 'OK',
      message: `${offersUrl(identity.domain)} brand "${brand.site_name}" (${brand.created ? 'new design generated' : 'existing'}); button #${btn.id}${btn.created ? ' created' : ''}`,
      buttonId: btn.id,
    };
  } catch (err) {
    return { status: 'FAILED', message: err.message };
  }
}
