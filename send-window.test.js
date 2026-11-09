import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH ||= ':memory:';
const W = await import('./services/SendWindow.js');
const { dailyAllows, providerHourlyCap } = await import('./services/WarmupService.js');

const env = (o) => { for (const k of ['SEND_WINDOW_START','SEND_WINDOW_END','SEND_WINDOW_TZ']) delete process.env[k]; Object.assign(process.env, o); };

test('window 18:00–21:00 Europe/Brussels (UTC+1 in November)', () => {
  env({ SEND_WINDOW_START: '18:00', SEND_WINDOW_END: '21:00', SEND_WINDOW_TZ: 'Europe/Brussels' });
  assert.equal(W.isOpen(new Date('2026-11-10T16:59:00Z')), false); // 17:59 Brussels
  assert.equal(W.isOpen(new Date('2026-11-10T17:00:00Z')), true);  // 18:00
  assert.equal(W.isOpen(new Date('2026-11-10T19:59:00Z')), true);  // 20:59
  assert.equal(W.isOpen(new Date('2026-11-10T20:00:00Z')), false); // 21:00
  assert.equal(W.isOpen(new Date('2026-07-10T16:30:00Z')), true);  // summer: 18:30 Brussels (UTC+2)
  assert.equal(W.lengthHours(), 3);
});

test('pacing spreads the daily limit over the window', () => {
  env({ SEND_WINDOW_START: '18:00', SEND_WINDOW_END: '21:00', SEND_WINDOW_TZ: 'Europe/Brussels' });
  assert.equal(providerHourlyCap({ dailyLimit: 40, warmupStartedAt: null }), 14);
  assert.equal(providerHourlyCap({ dailyLimit: 25, warmupStartedAt: null }), 9);
});

test('no / invalid window config → always open', () => {
  env({});
  assert.equal(W.isOpen(new Date('2026-11-10T03:00:00Z')), true);
  env({ SEND_WINDOW_START: '25:00', SEND_WINDOW_END: '21:00' });
  assert.equal(W.isOpen(new Date('2026-11-10T03:00:00Z')), true);
});

test('dailyAllows uses today\'s count only', () => {
  const now = new Date('2026-11-10T18:00:00Z');
  assert.equal(dailyAllows({ dailyLimit: 25, dailySentCount: 25, lastResetDate: '2026-11-10' }, now), false);
  assert.equal(dailyAllows({ dailyLimit: 25, dailySentCount: 24, lastResetDate: '2026-11-10' }, now), true);
  assert.equal(dailyAllows({ dailyLimit: 25, dailySentCount: 99, lastResetDate: '2026-11-09' }, now), true, 'yesterday\'s count does not block today');
});
