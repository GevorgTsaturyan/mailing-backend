import * as NodeRepository from './NodeRepository.js';

export function register(body) {
  const { apiKey, node_id, hostname, version, ip, public_ip, os, uptime, capabilities } = body;

  const server = NodeRepository.findByApiKey(apiKey);
  if (!server) {
    return { error: 'Invalid apiKey. Create the server in the controller UI first.', status: 401 };
  }

  NodeRepository.updateRegistration(server.id, {
    node_id,
    hostname,
    version,
    ip,
    public_ip,
    os_info: os,
    capabilities,
  });

  const identities = NodeRepository.getActiveIdentities(server.id);
  return { ok: true, serverId: server.id, identities };
}
