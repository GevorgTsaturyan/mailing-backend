import db from '../db.js';
import * as Groups from './GroupRepository.js';

// ─── CrossBrandService — "already emailed by another brand?" check ───────────
//
// Advisory only (never blocks): before a manual / scheduled send, the UI asks
// which recipients were already emailed by a DIFFERENT sender identity (brand)
// and shows a confirmation popup. One person receiving near-identical mail from
// several brands is a strong snowshoe signal to Gmail, so the operator should do
// it deliberately, not by accident.
//
// "Emailed by" = a canonical job that reached status SENT, or a legacy send_log
// row with status sent/delivered, for that contact and identity.

// Same identity the send would actually use: explicit, else first active+READY
// (mirrors routes/send.js).
export function resolveIdentityId(identityId) {
  if (identityId) return Number(identityId);
  return db.prepare(
    "SELECT id FROM sender_identities WHERE status='active' AND verificationStatus='READY' ORDER BY id LIMIT 1"
  ).get()?.id ?? null;
}

export function check({ identityId = null, contactIds = [], groupIds = [] } = {}) {
  const fromGroups = groupIds?.length ? Groups.contactIdsInGroups(groupIds) : [];
  const ids = [...new Set([...(Array.isArray(contactIds) ? contactIds : []), ...fromGroups].map(Number).filter(Number.isInteger))];
  const iid = resolveIdentityId(identityId);
  const identity = iid ? db.prepare('SELECT id, domain, fromAddr FROM sender_identities WHERE id = ?').get(iid) : null;
  if (!ids.length || !identity) return { identity, total: ids.length, conflicts: [] };

  const byContact = new Map();
  const CHUNK = 500; // stay well under SQLite's bound-parameter limit
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const ph = part.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT x.contact_id, si.domain FROM (
        SELECT contact_id, identity_id FROM jobs
         WHERE status = 'SENT' AND contact_id IN (${ph})
        UNION
        SELECT contactId AS contact_id, senderIdentityId AS identity_id FROM send_log
         WHERE status IN ('sent', 'delivered') AND senderIdentityId IS NOT NULL AND contactId IN (${ph})
      ) x
      JOIN sender_identities si ON si.id = x.identity_id
      WHERE x.identity_id <> ?
    `).all(...part, ...part, identity.id);
    for (const r of rows) {
      if (!byContact.has(r.contact_id)) byContact.set(r.contact_id, new Set());
      byContact.get(r.contact_id).add(r.domain);
    }
  }
  if (!byContact.size) return { identity, total: ids.length, conflicts: [] };

  const cids = [...byContact.keys()];
  const emails = new Map();
  for (let i = 0; i < cids.length; i += CHUNK) {
    const part = cids.slice(i, i + CHUNK);
    for (const c of db.prepare(`SELECT id, email FROM contacts WHERE id IN (${part.map(() => '?').join(',')})`).all(...part)) emails.set(c.id, c.email);
  }
  const conflicts = cids
    .map((id) => ({ contactId: id, email: emails.get(id) || '', brands: [...byContact.get(id)].sort() }))
    .sort((a, b) => a.email.localeCompare(b.email));
  return { identity, total: ids.length, conflicts };
}
