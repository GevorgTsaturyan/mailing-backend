import db from '../db.js';

// ─── ButtonGroupRepository ────────────────────────────────────────────────────
// Organise reusable CTA buttons into named groups (e.g. one per sending brand).
// Mirrors TemplateGroupRepository, but membership is keyed by button id.

export function list() {
  const groups = db.prepare('SELECT id, name, description, createdAt FROM button_groups ORDER BY name COLLATE NOCASE ASC').all();
  const members = db.prepare('SELECT group_id, button_id FROM button_group_members ORDER BY button_id ASC').all();
  const byGroup = new Map();
  for (const m of members) {
    if (!byGroup.has(m.group_id)) byGroup.set(m.group_id, []);
    byGroup.get(m.group_id).push(m.button_id);
  }
  return groups.map(g => {
    const buttonIds = byGroup.get(g.id) || [];
    return { ...g, buttonIds, memberCount: buttonIds.length };
  });
}

export function get(id) {
  const g = db.prepare('SELECT id, name, description, createdAt FROM button_groups WHERE id = ?').get(id);
  if (!g) return null;
  const buttonIds = db.prepare('SELECT button_id FROM button_group_members WHERE group_id = ? ORDER BY button_id').all(id).map(r => r.button_id);
  return { ...g, buttonIds, memberCount: buttonIds.length };
}

export function create({ name, description = null }) {
  const info = db.prepare('INSERT INTO button_groups (name, description, createdAt) VALUES (?, ?, ?)')
    .run(name.trim(), description, new Date().toISOString());
  return get(info.lastInsertRowid);
}

export function update(id, { name, description }) {
  const row = db.prepare('SELECT * FROM button_groups WHERE id = ?').get(id);
  if (!row) return null;
  db.prepare('UPDATE button_groups SET name = ?, description = ? WHERE id = ?').run(
    name !== undefined ? name.trim() : row.name,
    description !== undefined ? description : row.description,
    id,
  );
  return get(id);
}

// Buttons themselves are never touched; memberships go too (explicit delete so it
// works regardless of the foreign_keys pragma).
export function remove(id) {
  db.prepare('DELETE FROM button_group_members WHERE group_id = ?').run(id);
  return db.prepare('DELETE FROM button_groups WHERE id = ?').run(id).changes;
}

// Only ids that exist in `buttons` are added; duplicates ignored.
export function addMembers(groupId, buttonIds) {
  const now = new Date().toISOString();
  const ins = db.prepare('INSERT OR IGNORE INTO button_group_members (group_id, button_id, addedAt) VALUES (?, ?, ?)');
  const exists = db.prepare('SELECT 1 FROM buttons WHERE id = ?');
  let added = 0;
  db.transaction((ids) => { for (const id of ids) if (exists.get(id)) added += ins.run(groupId, id, now).changes; })(
    [...new Set(buttonIds.map(Number).filter(Number.isInteger))]);
  return added;
}

export function removeMembers(groupId, buttonIds) {
  const del = db.prepare('DELETE FROM button_group_members WHERE group_id = ? AND button_id = ?');
  let removed = 0;
  db.transaction((ids) => { for (const id of ids) removed += del.run(groupId, id).changes; })(
    [...new Set(buttonIds.map(Number).filter(Number.isInteger))]);
  return removed;
}

export function removeButtonFromAllGroups(buttonId) {
  return db.prepare('DELETE FROM button_group_members WHERE button_id = ?').run(buttonId).changes;
}
