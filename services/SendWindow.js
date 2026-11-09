// ─── SendWindow — daily sending hours for campaign mail ──────────────────────
//
// Campaign/contact jobs are only handed to mail nodes inside a daily window in
// a given timezone (e.g. 18:00–21:00 Europe/Brussels, when recipients read
// email). Outside it the queue simply pauses and resumes at the next window —
// nothing is cancelled. Raw jobs (Inbox replies) are not windowed.
//
// Env: SEND_WINDOW_START / SEND_WINDOW_END ("HH:MM", 24h) and SEND_WINDOW_TZ
// (IANA zone, default UTC). Unset/invalid → no window (always allowed).
// While a window is active, the per-provider pacing spreads each identity's
// daily limit over the window's length (see WarmupService.spreadHours).

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = (s) => { const m = HHMM.exec(String(s || '').trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

export function windowConfig() {
  const start = toMin(process.env.SEND_WINDOW_START), end = toMin(process.env.SEND_WINDOW_END);
  if (start == null || end == null || start === end) return null;
  const tz = process.env.SEND_WINDOW_TZ || 'UTC';
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); } catch { return null; }
  return { start, end, tz };
}

// Minutes since local midnight in `tz`.
export function localMinutes(now, tz) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  return Number(p.find(x => x.type === 'hour').value) * 60 + Number(p.find(x => x.type === 'minute').value);
}

export function isOpen(now = new Date(), cfg = windowConfig()) {
  if (!cfg) return true;
  const m = localMinutes(now, cfg.tz);
  return cfg.start < cfg.end ? m >= cfg.start && m < cfg.end : m >= cfg.start || m < cfg.end; // supports overnight windows
}

export function lengthHours(cfg = windowConfig()) {
  if (!cfg) return null;
  const mins = cfg.start < cfg.end ? cfg.end - cfg.start : 1440 - cfg.start + cfg.end;
  return mins / 60;
}
