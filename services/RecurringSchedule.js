// ─── RecurringSchedule — start date + per-weekday send ranges ─────────────────
//
// Pure helpers (no I/O) for the optional scheduling fields on recurring_campaigns.
// A campaign with start_date = NULL and weekly_schedule = NULL behaves exactly as
// before: one startTime–endTime window, every day, starting immediately.
//
//   weekly_schedule JSON: { "0": [{start:"HH:MM", end:"HH:MM"}, ...], ..., "6": [...] }
//   Keys are weekdays (0 = Sunday … 6 = Saturday). Times are in the campaign's
//   timezone. A weekday with no ranges is a non-sending day.

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const toMins = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// Parse the stored JSON. Returns null for NULL/invalid (→ legacy behaviour).
export function parseWeeklySchedule(raw) {
  if (!raw) return null;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

// Validate an incoming weekly schedule. Returns { error } or { value } where value
// is the normalised object (ranges sorted by start). null/undefined → { value: null }.
export function validateWeeklySchedule(input) {
  if (input == null) return { value: null };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'weeklySchedule must be an object keyed by weekday 0-6' };
  const out = {};
  let total = 0;
  for (const [key, ranges] of Object.entries(input)) {
    if (!/^[0-6]$/.test(key)) return { error: `weeklySchedule: invalid weekday "${key}" (use 0=Sunday … 6=Saturday)` };
    if (!Array.isArray(ranges)) return { error: `weeklySchedule[${key}] must be an array of ranges` };
    const clean = [];
    for (const r of ranges) {
      if (!r || !HHMM.test(r.start) || !HHMM.test(r.end)) return { error: 'Each time range needs start and end as HH:MM' };
      if (toMins(r.end) <= toMins(r.start)) return { error: `Time range ${r.start}–${r.end}: end must be after start` };
      clean.push({ start: r.start, end: r.end });
    }
    clean.sort((a, b) => toMins(a.start) - toMins(b.start));
    for (let i = 1; i < clean.length; i++) {
      if (toMins(clean[i].start) < toMins(clean[i - 1].end)) return { error: `Time ranges ${clean[i - 1].start}–${clean[i - 1].end} and ${clean[i].start}–${clean[i].end} overlap` };
    }
    if (clean.length) out[key] = clean;
    total += clean.length;
  }
  if (total === 0) return { error: 'Select at least one day with a time range' };
  return { value: out };
}

export function validateStartDate(input) {
  if (input == null || input === '') return { value: null };
  if (!DATE.test(input) || isNaN(new Date(input + 'T00:00:00Z').getTime())) return { error: 'startDate must be YYYY-MM-DD' };
  return { value: input };
}

// The send ranges (campaign-local "HH:MM") for the given UTC day 'YYYY-MM-DD'.
// Returns [] when the campaign must not send that day (before start date, or a
// weekday without ranges). Legacy campaigns → [{startTime, endTime}].
export function rangesForDay(campaign, dayUTC) {
  if (campaign.start_date && dayUTC < campaign.start_date) return [];
  const weekly = parseWeeklySchedule(campaign.weekly_schedule);
  if (!weekly) return [{ start: campaign.startTime, end: campaign.endTime }];
  const weekday = new Date(dayUTC + 'T12:00:00Z').getUTCDay();
  return Array.isArray(weekly[weekday]) ? weekly[weekday] : [];
}

// Split `count` evenly across `n` ranges; the remainder goes to the first ranges.
// splitCount(30, 3) → [10, 10, 10]; splitCount(10, 3) → [4, 3, 3]
export function splitCount(count, n) {
  if (n <= 0) return [];
  const base = Math.floor(count / n);
  return Array.from({ length: n }, (_, i) => base + (i < count % n ? 1 : 0));
}
