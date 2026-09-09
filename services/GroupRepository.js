import db from '../db.js';

// ─── GroupRepository — contact groups (named lists) + membership ──────────────
//
// Phase 1: storage-facing CRUD only. Nothing here selects contacts for sending or
// consults the campaign_send_ledger — groups are purely an organisational layer
// that later phases (campaign/schedule targeting) will read from.
//
// Membership is many-to-many via contact_group_members. All writes use
// INSERT OR IGNORE so re-adding a contact already in a group is a harmless no-op
// (the composite PK enforces uniqueness).

// List every group with its current member count (one query, no N+1).
export function list() {
  return db.prepare(`
    SELECT g.id, g.name, g.description, g.createdAt,
           (SELECT COUNT(*) FROM contact_group_members m WHERE m.group_id = g.id) AS memberCount
    FROM contact_groups g
    ORDER BY g.name COLLATE NOCASE ASC
  `).all();
}

export function get(id) {
  return db.prepare(`
    SELECT g.id, g.name, g.description, g.createdAt,
           (SELECT COUNT(*) FROM contact_group_members m WHERE m.group_id = g.id) AS memberCount
    FROM contact_groups g
    WHERE g.id = ?
  `).get(id);
}

export function getByName(name) {
  return db.prepare('SELECT * FROM contact_groups WHERE name = ? COLLATE NOCASE').get(name);
}

// Throws on duplicate name (UNIQUE) — the route maps that to a 409.
export function create({ name, description = null }) {
  const now = new Date().toISOString();
  const info = db.prepare(
    'INSERT INTO contact_groups (name, description, createdAt) VALUES (?, ?, ?)'
  ).run(name.trim(), description, now);
  return get(info.lastInsertRowid);
}

// Resolve a group by name, creating it if absent. Used by the CSV import flow
// where the user types a brand-new group name. Case-insensitive match.
export function findOrCreateByName(name) {
  const existing = getByName(name.trim());
  if (existing) return get(existing.id);
  return create({ name });
}

export function update(id, { name, description }) {
  const row = db.prepare('SELECT * FROM contact_groups WHERE id = ?').get(id);
  if (!row) return null;
  db.prepare('UPDATE contact_groups SET name = ?, description = ? WHERE id = ?').run(
    name        !== undefined ? name.trim() : row.name,
    description !== undefined ? description : row.description,
    id
  );
  return get(id);
}

// Plain delete. contact_group_members rows cascade away (FK ON DELETE CASCADE).
// The "block deletion when a campaign/schedule targets this group" guard is a
// later phase — no targeting junction rows exist yet in Phase 1.
export function remove(id) {
  return db.prepare('DELETE FROM contact_groups WHERE id = ?').run(id).changes;
}

// Add contacts to a group. Returns how many memberships were newly created
// (already-present contacts are silently ignored). Only inserts memberships for
// contact ids that actually exist, so a bad id can never create a dangling row.
export function addMembers(groupId, contactIds) {
  const now = new Date().toISOString();
  const ins = db.prepare(
    'INSERT OR IGNORE INTO contact_group_members (group_id, contact_id, addedAt) VALUES (?, ?, ?)'
  );
  const exists = db.prepare('SELECT 1 FROM contacts WHERE id = ?');
  let added = 0;
  const many = db.transaction((ids) => {
    for (const cid of ids) {
      if (!exists.get(cid)) continue;
      added += ins.run(groupId, cid, now).changes;
    }
  });
  many([...new Set(contactIds)]);
  return added;
}

export function removeMembers(groupId, contactIds) {
  const ids = [...new Set(contactIds)];
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(
    `DELETE FROM contact_group_members WHERE group_id = ? AND contact_id IN (${placeholders})`
  ).run(groupId, ...ids).changes;
}

export function contactIdsInGroup(groupId) {
  return db.prepare(
    'SELECT contact_id FROM contact_group_members WHERE group_id = ? ORDER BY contact_id'
  ).all(groupId).map((r) => r.contact_id);
}

// Where is this group still USED for future targeting? Only references that could
// affect a future automated send count as blocking (decision #3):
//   • recurring campaigns in status active/paused (completed never run again)
//   • the daily batch, but only while it is in target_mode='groups'
// Returns { recurring: [{id,name,status}], dailyBatch: boolean }.
export function usages(groupId) {
  const recurring = db.prepare(`
    SELECT rc.id, rc.name, rc.status
    FROM recurring_campaign_groups g
    JOIN recurring_campaigns rc ON rc.id = g.recurring_campaign_id
    WHERE g.group_id = ? AND rc.status IN ('active','paused')
    ORDER BY rc.id
  `).all(groupId);
  const cfg          = db.prepare('SELECT target_mode FROM schedule_config WHERE id = 1').get();
  const inDailyBatch = !!db.prepare('SELECT 1 FROM daily_batch_groups WHERE group_id = ?').get(groupId);
  return { recurring, dailyBatch: inDailyBatch && cfg?.target_mode === 'groups' };
}

// Distinct union of member contact ids across several groups. Used as an extra
// recipient source by manual + one-off scheduled sends. Non-numeric or unknown
// group ids simply contribute no members (union semantics — never throws).
export function contactIdsInGroups(groupIds) {
  const ids = [...new Set((groupIds || []).map(Number).filter((n) => Number.isInteger(n)))];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(
    `SELECT DISTINCT contact_id FROM contact_group_members WHERE group_id IN (${placeholders}) ORDER BY contact_id`
  ).all(...ids).map((r) => r.contact_id);
}
