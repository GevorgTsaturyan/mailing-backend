import db from '../db.js';

export function findByApiKey(apiKey) {
  return db.prepare('SELECT * FROM servers WHERE apiKey = ?').get(apiKey);
}

export function updateRegistration(serverId, { node_id, hostname, version, ip, public_ip, os_info, capabilities }) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE servers SET
      node_id=?, hostname=?, version=?,
      mainIp=COALESCE(?, mainIp), public_ip=?, os_info=?,
      capabilities=?, status='online', lastSeenAt=?
    WHERE id=?
  `).run(
    node_id      || null,
    hostname     || null,
    version      || null,
    ip           || null,
    public_ip    || null,
    os_info      || null,
    capabilities ? JSON.stringify(capabilities) : null,
    now,
    serverId
  );
}

export function updateHeartbeat(serverId, health, openDkimHealthy = null) {
  db.prepare(`
    UPDATE servers SET status='online', lastSeenAt=?, health=?, openDkimHealthy=?
    WHERE id=?
  `).run(new Date().toISOString(), JSON.stringify(health), openDkimHealthy, serverId);
}

// Early-prevention dispatch gate: is this server's DKIM signer usable right now?
// Returns false only when the last heartbeat explicitly reported it down (0).
// Unknown (NULL) stays permissive — Postfix tempfail is the hard local guarantee.
export function isSignerHealthy(serverId) {
  const row = db.prepare('SELECT openDkimHealthy FROM servers WHERE id = ?').get(serverId);
  return !row || row.openDkimHealthy !== 0;
}

// Mark nodes offline when they haven't sent a heartbeat within thresholdMs.
// Returns the number of rows updated.
export function markStaleOffline(thresholdMs) {
  const cutoff = new Date(Date.now() - thresholdMs).toISOString();
  return db.prepare(`
    UPDATE servers SET status='offline'
    WHERE status='online' AND (lastSeenAt IS NULL OR lastSeenAt < ?)
  `).run(cutoff).changes;
}

export function getActiveIdentities(serverId) {
  return db.prepare("SELECT * FROM sender_identities WHERE serverId=? AND status='active'").all(serverId);
}
