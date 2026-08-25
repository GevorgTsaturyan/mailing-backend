// ─── BodyCompiler (pure) ──────────────────────────────────────────────────────
//
// Transforms a template body into the final per-recipient body that is stored in
// the job row at QUEUE TIME. Two transformations:
//   1. Expand {{button:ID}} placeholders → email-safe bulletproof table buttons
//      (HTML) / "TEXT: url" (plain text), using a per-recipient tracking URL.
//   2. Inject a single 1x1 open-tracking pixel (HTML only) — ONLY when open
//      tracking is effectively enabled (a null pixelUrl means "do not inject").
//
// This module is PURE: it performs no DB access, holds no token secret, and makes
// no network calls. The caller injects:
//   • resolveSnapshot(buttonId) → { id, text, destination_url, style }  (THROWS on
//     a missing/inactive button — the caller must hard-fail the send, never emit a
//     broken CTA)
//   • clickUrl(campaignButtonSnapshotId) → tracking URL string
//   • pixelUrl → tracking pixel URL string, or null to inject no pixel
//
// {{firstName}}-style variables are intentionally left intact; the mail-node
// resolves them at send time. Tracking URLs never contain {{...}}.

const BUTTON_RE = /\{\{\s*button:(\d+)\s*\}\}/g;

export function hasButtonPlaceholder(str) {
  if (!str) return false;
  BUTTON_RE.lastIndex = 0;
  return BUTTON_RE.test(str);
}

export function extractButtonIds(str) {
  const ids = new Set();
  if (str) {
    for (const m of str.matchAll(BUTTON_RE)) ids.add(Number(m[1]));
  }
  return [...ids];
}

// All button ids referenced by either the HTML or the text body.
export function referencedButtonIds({ html, txt } = {}) {
  return [...new Set([...extractButtonIds(html), ...extractButtonIds(txt)])];
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

const DEFAULT_STYLE = {
  background_color: '#2563eb',
  text_color:      '#ffffff',
  font_size:       16,
  font_weight:     'bold',
  border_radius:   6,
  padding_x:       28,
  padding_y:       12,
  align:           'center',
  width:           'auto', // 'auto' | 'full'
};

function normalizeStyle(style) {
  let s = style;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch { s = {}; } }
  return { ...DEFAULT_STYLE, ...(s || {}) };
}

// Bulletproof, email-client-safe table button with inline styles only. No <style>
// block, no JavaScript. border-radius degrades gracefully where unsupported.
export function renderButtonHtml(style, text, url) {
  const s = normalizeStyle(style);
  const bg   = escapeHtml(s.background_color);
  const fg   = escapeHtml(s.text_color);
  const fs   = Number(s.font_size)     || DEFAULT_STYLE.font_size;
  const fw   = escapeHtml(s.font_weight);
  const br   = Number(s.border_radius) || 0;
  const px   = Number(s.padding_x)     || 0;
  const py   = Number(s.padding_y)     || 0;
  const align = ['left', 'center', 'right'].includes(s.align) ? s.align : 'center';
  const full  = s.width === 'full';
  const label = escapeHtml(text);
  const href  = escapeHtml(url);

  const tableWidth = full ? 'width:100%;' : '';
  const linkBlock  = full ? 'display:block;text-align:center;' : 'display:inline-block;';

  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" ` +
    `style="${tableWidth}border-collapse:separate;margin:16px 0;" align="${align}">` +
    `<tr><td align="${align}" bgcolor="${bg}" ` +
    `style="border-radius:${br}px;background-color:${bg};">` +
    `<a href="${href}" target="_blank" ` +
    `style="${linkBlock}background-color:${bg};color:${fg};` +
    `font-family:Arial,Helvetica,sans-serif;font-size:${fs}px;font-weight:${fw};` +
    `text-decoration:none;padding:${py}px ${px}px;border-radius:${br}px;">` +
    `${label}</a></td></tr></table>`
  );
}

export function renderButtonText(text, url) {
  return `${text}: ${url}`;
}

const PIXEL_RE = /<\/body\s*>/i;

function pixelImg(url) {
  return `<img src="${escapeHtml(url)}" width="1" height="1" alt="" style="display:block;border:0" />`;
}

// injectPixel(html, pixelUrl) → html with a single tracking pixel appended just
// before </body> (or at the very end if there is no </body>). No hiding tricks.
export function injectPixel(html, pixelUrl) {
  if (!pixelUrl) return html;
  const img = pixelImg(pixelUrl);
  if (html && PIXEL_RE.test(html)) return html.replace(PIXEL_RE, `${img}</body>`);
  return `${html || ''}${img}`;
}

function expand(str, kind, { resolveSnapshot, clickUrl }) {
  if (!str) return str;
  return str.replace(BUTTON_RE, (_m, idStr) => {
    const snap = resolveSnapshot(Number(idStr)); // THROWS on missing/inactive
    const url  = clickUrl(snap.id);
    return kind === 'html'
      ? renderButtonHtml(snap.style, snap.text, url)
      : renderButtonText(snap.text, url);
  });
}

// compile({ html, txt }, { resolveSnapshot, clickUrl, pixelUrl }) → { html, txt }
//
// Expands button placeholders in both parts and (when pixelUrl is non-null)
// appends the open pixel to the HTML part only. Plain-text stays pixel-free so
// text-only sends remain text-only and multipart/alternative is preserved.
export function compile({ html, txt } = {}, { resolveSnapshot, clickUrl, pixelUrl = null } = {}) {
  const outHtml = expand(html, 'html', { resolveSnapshot, clickUrl });
  const outTxt  = expand(txt,  'text', { resolveSnapshot, clickUrl });
  return {
    html: injectPixel(outHtml, pixelUrl),
    txt:  outTxt,
  };
}
