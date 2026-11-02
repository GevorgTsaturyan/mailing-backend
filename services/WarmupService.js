import db from '../db.js';

// ─── WarmupService — IP/domain warm-up + per-provider throttle ────────────────
//
// Warm-up: when sender_identities.warmupStartedAt is set, the identity's
// effective daily limit follows WARMUP_SCHEDULE by week since that date, capped
// by the manually configured dailyLimit (which stays the long-term ceiling).
// warmupStartedAt NULL ⇒ dailyLimit is used unchanged (backward compatible).
//
// Provider throttle: per identity, per big mailbox provider, at most
// providerHourlyCap(identity) jobs may be STARTED in a rolling hour. This
// spreads a day's volume over ≥ PROVIDER_SPREAD_HOURS instead of a burst to
// Gmail/Microsoft/Yahoo — bursts from a young IP look like spam runs.

// Week 1..N daily limits; after the table: double weekly.
export const WARMUP_SCHEDULE = [50, 100, 200, 500, 1000, 2000];

export function warmupLimitFor(startedAt, now = new Date()) {
  if (!startedAt) return null;
  const start = new Date(startedAt);
  if (Number.isNaN(start.getTime())) return null;
  const week = Math.max(0, Math.floor((now - start) / (7 * 86_400_000)));
  if (week < WARMUP_SCHEDULE.length) return WARMUP_SCHEDULE[week];
  const extra = week - WARMUP_SCHEDULE.length + 1;
  return WARMUP_SCHEDULE[WARMUP_SCHEDULE.length - 1] * 2 ** Math.min(extra, 20);
}

export function effectiveDailyLimit(identity, now = new Date()) {
  const base = Number(identity?.dailyLimit ?? 0);
  const w = warmupLimitFor(identity?.warmupStartedAt, now);
  return w == null ? base : Math.min(base, w);
}

const PROVIDERS = {
  google:    ['gmail.com', 'googlemail.com'],
  microsoft: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'outlook.fr', 'hotmail.fr', 'hotmail.co.uk', 'live.fr'],
  yahoo:     ['yahoo.com', 'ymail.com', 'aol.com', 'yahoo.fr', 'yahoo.co.uk', 'rocketmail.com'],
  mailru:    ['mail.ru', 'inbox.ru', 'list.ru', 'bk.ru'],
  yandex:    ['yandex.ru', 'yandex.com', 'ya.ru'],
};
const DOMAIN_TO_PROVIDER = new Map(
  Object.entries(PROVIDERS).flatMap(([p, ds]) => ds.map((d) => [d, p]))
);

export function providerOf(email) {
  const d = String(email || '').split('@')[1]?.toLowerCase() || '';
  return DOMAIN_TO_PROVIDER.get(d) || null;
}

function spreadHours() {
  const n = parseInt(process.env.PROVIDER_SPREAD_HOURS ?? '8', 10);
  return Number.isFinite(n) && n > 0 ? n : 0; // 0 disables the throttle
}

export function providerHourlyCap(identity, now = new Date()) {
  const h = spreadHours();
  if (!h) return Infinity;
  return Math.max(5, Math.ceil(effectiveDailyLimit(identity, now) / h));
}

// Returns true when this job may start now under the provider throttle.
export function providerAllows(job, identity, now = new Date()) {
  const provider = providerOf(job.recipient);
  if (!provider) return true;
  const cap = providerHourlyCap(identity, now);
  if (!Number.isFinite(cap)) return true;
  const since = new Date(now.getTime() - 3_600_000).toISOString();
  const domains = PROVIDERS[provider];
  const likes = domains.map(() => 'lower(recipient) LIKE ?').join(' OR ');
  const n = db.prepare(`
    SELECT COUNT(*) n FROM jobs
    WHERE identity_id = ? AND started_at >= ? AND (${likes})
  `).get(job.identity_id, since, ...domains.map((d) => `%@${d}`)).n;
  return n < cap;
}
