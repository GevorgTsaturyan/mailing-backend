// ─── ProvisioningPhaseStore ───────────────────────────────────────────────────
// Shared helpers for reading/writing the provisioningPhases JSON blob on
// sender_identities.  Kept in one place so nodes.js, ProvisioningRetryService,
// and the sender-identities route all use the same serialisation logic.

import db from '../db.js';

// Read the current phases blob for an identity (parsed).
export function getPhases(identityId) {
  const row = db.prepare('SELECT provisioningPhases FROM sender_identities WHERE id=?').get(identityId);
  if (!row?.provisioningPhases) return {};
  try { return JSON.parse(row.provisioningPhases); } catch { return {}; }
}

// Deep-merge `update` into the existing phases blob and write back.
// Top-level keys in `update` overwrite their counterpart in the stored blob.
export function mergePhases(identityId, update) {
  const current = getPhases(identityId);
  const merged  = { ...current, ...update, updatedAt: new Date().toISOString() };
  db.prepare('UPDATE sender_identities SET provisioningPhases=? WHERE id=?')
    .run(JSON.stringify(merged), identityId);
}

// Overwrite the full phases blob (used on initial task creation).
export function setPhases(identityId, phases) {
  db.prepare('UPDATE sender_identities SET provisioningPhases=? WHERE id=?')
    .run(JSON.stringify({ ...phases, updatedAt: new Date().toISOString() }), identityId);
}

// ─── nginx output parser ─────────────────────────────────────────────────────
// Converts provision-identity-hosts.sh stdout into a structured phases object
// suitable for storage in provisioningPhases.nginx.phases.
//
// The script emits section headers like "── unsubscribe.example.com ──────" to
// identify which subdomain each log line belongs to.

export function parseNginxOutput(stdout) {
  const phases = {
    unsubscribe:     null,
    click:           null,
    tls_unsubscribe: null,
    tls_click:       null,
  };

  let current = null;

  for (const line of stdout.split('\n')) {
    // Section header: "── <subdomain> ──────"
    if (line.includes('──') && line.includes('.')) {
      if (line.toLowerCase().includes('unsubscribe')) current = 'unsubscribe';
      else if (line.toLowerCase().includes('click'))  current = 'click';
      else current = null;
      continue;
    }

    if (!current) continue;

    // nginx config
    if (line.includes('[nginx]')) {
      if (line.includes('Writing HTTP config') || line.includes('Enabling site')) {
        phases[current] = { status: 'OK', message: 'nginx config written' };
      } else if (line.includes('already exists') || line.includes('already enabled')) {
        phases[current] = phases[current] || { status: 'SKIPPED', message: 'nginx config already exists' };
      }
    }

    // TLS cert
    if (line.includes('[cert]')) {
      const tlsKey = `tls_${current}`;
      if (line.includes('Certificate issued') || line.includes('already exists')) {
        phases[tlsKey] = { status: 'OK', message: 'TLS certificate active' };
      } else if (line.includes('WARN') || line.includes('certbot failed')) {
        phases[tlsKey] = { status: 'PENDING', message: 'certbot failed — DNS not yet propagated; re-run once DNS resolves' };
      }
    }
  }

  // Parse final health-probe lines (after "── Health probes ──" section)
  const healthSection = stdout.split('Health probes')[1] || '';
  for (const line of healthSection.split('\n')) {
    const sub = line.includes('unsubscribe.') ? 'unsubscribe'
              : line.includes('click.')       ? 'click'
              : null;
    if (!sub) continue;
    const tlsKey = `tls_${sub}`;
    if (line.includes('✓')) {
      phases[tlsKey] = { status: 'OK', message: 'TLS health probe passed' };
    } else if (line.includes('✗') && phases[tlsKey]?.status !== 'OK') {
      phases[tlsKey] = phases[tlsKey] || { status: 'PENDING', message: 'Not yet reachable' };
    }
  }

  // Fill nulls with PENDING
  for (const key of Object.keys(phases)) {
    if (phases[key] === null) phases[key] = { status: 'PENDING', message: 'Not yet run' };
  }

  return phases;
}
