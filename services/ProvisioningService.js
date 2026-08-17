import db from '../db.js';

// ─── ProvisioningService — apply node-reported identity readiness ─────────────
//
// A mail node proves it is locally provisioned to send an identity (DKIM key,
// OpenDKIM tables, Postfix transport/bind/HELO) and that the identity's DNS
// (FCrDNS + DKIM public key) is correct. It POSTs the result per identity; the
// controller records only safe metadata here — never keys, secrets, or raw config.
//
// SECURITY (task §10–12): the authenticated server (resolved from the apiKey by
// the route) is authoritative. A report is only applied to an identity that
// BELONGS to that server. A node cannot verify — or claim — another node's
// identity, nor supply a serverId; ownership comes from authentication.
//
// Statuses:  'unverified' (initial) | 'READY' | 'NOT_READY' | 'DNS_UNAVAILABLE'

const VALID_STATUSES = new Set(['READY', 'NOT_READY', 'DNS_UNAVAILABLE']);

const findIdentity = db.prepare(
  'SELECT id, serverId, verificationStatus FROM sender_identities WHERE id = ?'
);

const updateVerification = db.prepare(`
  UPDATE sender_identities
  SET verificationStatus = ?, lastVerifiedAt = ?, verificationReasons = ?,
      verifiedIpv4 = ?, verifiedHostname = ?, verifiedDkimSelector = ?
  WHERE id = ?
`);

// applyReports(serverId, reports[]) → { applied, rejected }
//   report: { identityId, domain?, ip?, selector?, hostname?, status, reasons? }
// Idempotent: re-posting the same report yields the same stored state.
export function applyReports(serverId, reports) {
  const applied = [];
  const rejected = [];
  const now = new Date().toISOString();

  for (const r of Array.isArray(reports) ? reports : []) {
    const identity = r?.identityId != null ? findIdentity.get(r.identityId) : null;

    // Ownership enforcement: identity must exist AND belong to the authenticated node.
    if (!identity || identity.serverId !== serverId) {
      rejected.push({ identityId: r?.identityId ?? null, reason: 'not owned by authenticated node' });
      continue;
    }
    if (!VALID_STATUSES.has(r.status)) {
      rejected.push({ identityId: identity.id, reason: `invalid status: ${r.status}` });
      continue;
    }

    // Transition rule (task §24): a transient DNS failure must NOT downgrade an
    // identity that is already proven READY. Only a definite NOT_READY (config
    // failure) or a fresh READY changes a currently-READY identity.
    let newStatus = r.status;
    if (r.status === 'DNS_UNAVAILABLE' && identity.verificationStatus === 'READY') {
      newStatus = 'READY';
    }

    // Store only safe metadata — never keys/paths/secrets.
    const reasons = Array.isArray(r.reasons) ? r.reasons.slice(0, 20).join('; ').slice(0, 1000) : null;
    updateVerification.run(
      newStatus, now, reasons,
      r.ip ?? null, r.hostname ?? null, r.selector ?? null,
      identity.id
    );
    applied.push({ identityId: identity.id, status: newStatus });
  }

  return { applied, rejected };
}

// Readiness snapshot for an identity (safe metadata only).
export function getIdentityVerification(identityId) {
  return db.prepare(`
    SELECT id, domain, ip, dkimSelector, status,
           verificationStatus, lastVerifiedAt, verificationReasons,
           verifiedIpv4, verifiedHostname, verifiedDkimSelector
    FROM sender_identities WHERE id = ?
  `).get(identityId) ?? null;
}
