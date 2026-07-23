import * as NodeRepository from './NodeRepository.js';

const OFFLINE_THRESHOLD_MS = 90_000;  // 90 seconds
const WATCHER_INTERVAL_MS  = 30_000;  // check every 30 seconds

export function recordHeartbeat(apiKey, metrics) {
  const server = NodeRepository.findByApiKey(apiKey);
  if (!server) return { error: 'Invalid apiKey', status: 401 };

  const health = {
    uptime:           metrics.uptime           ?? null,
    cpu:              metrics.cpu              ?? null,
    ram:              metrics.ram              ?? null,
    disk:             metrics.disk             ?? null,
    queue_size:       metrics.queue_size       ?? null,
    postfix_running:  metrics.postfix_running  ?? null,
    opendkim_running: metrics.opendkim_running ?? null,
    recordedAt:       new Date().toISOString(),
  };

  NodeRepository.updateHeartbeat(server.id, health);
  return { ok: true };
}

// Call once on backend startup. Marks any node OFFLINE if its last heartbeat
// arrived more than OFFLINE_THRESHOLD_MS ago.
export function startOfflineWatcher() {
  setInterval(() => {
    NodeRepository.markStaleOffline(OFFLINE_THRESHOLD_MS);
  }, WATCHER_INTERVAL_MS);
}
