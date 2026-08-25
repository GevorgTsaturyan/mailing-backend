import db from '../db.js';

// ─── ButtonRepository ─────────────────────────────────────────────────────────
// DB layer + validation for the reusable CTA `buttons` library.
//
// internal_name is admin-only and never shown to recipients. Style is a small,
// whitelisted, email-safe property set (NOT a free-form CSS editor).

const STYLE_KEYS = new Set([
  'background_color', 'text_color', 'font_size', 'font_weight',
  'border_radius', 'padding_x', 'padding_y', 'align', 'width',
]);
const ALIGN   = new Set(['left', 'center', 'right']);
const WIDTH   = new Set(['auto', 'full']);
const WEIGHTS = new Set(['normal', 'bold', '400', '600', '700']);
const HEX     = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// Validate + normalize the style object. Unknown keys are dropped; values are
// clamped/whitelisted so nothing unsafe reaches the rendered email.
export function validateStyle(input = {}) {
  const s = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (!STYLE_KEYS.has(k)) continue;
    s[k] = v;
  }
  if (s.background_color != null && !HEX.test(s.background_color)) throw new Error('background_color must be a hex color');
  if (s.text_color       != null && !HEX.test(s.text_color))       throw new Error('text_color must be a hex color');
  if (s.font_weight      != null && !WEIGHTS.has(String(s.font_weight))) throw new Error('invalid font_weight');
  if (s.align            != null && !ALIGN.has(s.align))           throw new Error('align must be left|center|right');
  if (s.width            != null && !WIDTH.has(s.width))           throw new Error('width must be auto|full');
  for (const num of ['font_size', 'border_radius', 'padding_x', 'padding_y']) {
    if (s[num] != null) {
      const n = Number(s[num]);
      if (!Number.isFinite(n) || n < 0 || n > 200) throw new Error(`${num} must be a number between 0 and 200`);
      s[num] = n;
    }
  }
  return s;
}

function validateUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { throw new Error('destination_url must be a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('destination_url must be http(s)');
  return u.toString();
}

function validate({ internal_name, text, destination_url, status }) {
  if (!internal_name?.trim()) throw new Error('internal_name is required');
  if (!text?.trim())          throw new Error('text is required');
  if (!destination_url?.trim()) throw new Error('destination_url is required');
  if (status != null && status !== 'active' && status !== 'inactive') throw new Error("status must be 'active' or 'inactive'");
}

export function list() {
  return db.prepare('SELECT * FROM buttons ORDER BY internal_name').all()
    .map(r => ({ ...r, style: safeParse(r.style) }));
}

export function findById(id) {
  const r = db.prepare('SELECT * FROM buttons WHERE id = ?').get(id);
  return r ? { ...r, style: safeParse(r.style) } : null;
}

export function create({ internal_name, text, destination_url, style, status }) {
  validate({ internal_name, text, destination_url, status });
  const url  = validateUrl(destination_url);
  const st   = validateStyle(style);
  const now  = new Date().toISOString();
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO buttons (internal_name, text, destination_url, style, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(internal_name.trim(), text.trim(), url, JSON.stringify(st), status || 'active', now);
  return findById(lastInsertRowid);
}

export function update(id, { internal_name, text, destination_url, style, status }) {
  const existing = db.prepare('SELECT * FROM buttons WHERE id = ?').get(id);
  if (!existing) return null;
  const next = {
    internal_name:   internal_name   ?? existing.internal_name,
    text:            text            ?? existing.text,
    destination_url: destination_url ?? existing.destination_url,
    status:          status          ?? existing.status,
  };
  validate(next);
  const url = validateUrl(next.destination_url);
  const st  = style !== undefined ? validateStyle(style) : safeParse(existing.style);
  db.prepare(`
    UPDATE buttons
    SET internal_name=?, text=?, destination_url=?, style=?, status=?, updated_at=?
    WHERE id=?
  `).run(next.internal_name.trim(), next.text.trim(), url, JSON.stringify(st), next.status,
         new Date().toISOString(), id);
  return findById(id);
}

// Soft-delete: buttons referenced by a campaign snapshot must never hard-delete
// (the snapshot is independent, but we keep provenance). Inactivate instead.
export function remove(id) {
  const r = db.prepare("UPDATE buttons SET status='inactive', updated_at=? WHERE id=?")
    .run(new Date().toISOString(), id);
  return r.changes > 0;
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
