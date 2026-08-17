import * as NodeRepository from './NodeRepository.js';

const OFFLINE_THRESHOLD_MS = 90_000;  // 90 seconds
const WATCHER_INTERVAL_MS  = 30_000;  // check every 30 seconds

// Reduce reported signer metrics to 1 (healthy) / 0 (down) / null (unknown).
// Healthy requires the OpenDKIM service running AND (if reported) the milter socket
// reachable. An explicit false on either → 0. Absent signals → null (unknown).
export function deriveSignerHealth(metrics) {
  const running  = metrics.opendkim_running;
  const socketOk = metrics.opendkim_socket_ok;
  if (running === false) return 0;
  if (running === true)  return socketOk === false ? 0 : 1;
  return null; // unknown
}

export function recordHeartbeat(apiKey, metrics) {
  const server = NodeRepository.findByApiKey(apiKey);
  if (!server) return { error: 'Invalid apiKey', status: 401 };

  const health = {
    uptime:             metrics.uptime             ?? null,
    cpu:                metrics.cpu                ?? null,
    ram:                metrics.ram                ?? null,
    disk:               metrics.disk               ?? null,
    queue_size:         metrics.queue_size         ?? null,
    postfix_running:    metrics.postfix_running    ?? null,
    opendkim_running:   metrics.opendkim_running   ?? null,
    opendkim_socket_ok: metrics.opendkim_socket_ok ?? null,
    recordedAt:         new Date().toISOString(),
  };

  NodeRepository.updateHeartbeat(server.id, health, deriveSignerHealth(metrics));
  return { ok: true };
}

// Call once on backend startup. Marks any node OFFLINE if its last heartbeat
// arrived more than OFFLINE_THRESHOLD_MS ago.
export function startOfflineWatcher() {
  setInterval(() => {
    NodeRepository.markStaleOffline(OFFLINE_THRESHOLD_MS);
  }, WATCHER_INTERVAL_MS);
}
