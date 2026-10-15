import db from '../db.js';

// ─── TemplateGroupRepository ──────────────────────────────────────────────────
// DB layer for organising templates into named groups. Mirrors GroupRepository
// (contact groups) but membership is keyed by template NAME, since templates are
// keyed by name (templates.name is the primary key) and referenced by name
// everywhere (campaigns, scheduled sends, jobs).

// All groups, each with its member template names + count. One extra query for
// members keeps this O(1) in round-trips regardless of group count.
export function list() {
  const groups = db.prepare(`
    SELECT id, name, description, createdAt
    FROM template_groups
    ORDER BY name COLLATE NOCASE ASC
  `).all();

  const members = db.prepare(`
    SELECT group_id, template_name
    FROM template_group_members
    ORDER BY template_name COLLATE NOCASE ASC
  `).all();

  const byGroup = new Map();
  for (const m of members) {
    if (!byGroup.has(m.group_id)) byGroup.set(m.group_id, []);
    byGroup.get(m.group_id).push(m.template_name);
  }

  return groups.map(g => {
    const templates = byGroup.get(g.id) || [];
    return { ...g, templates, memberCount: templates.length };
  });
}

export function get(id) {
  const g = db.prepare('SELECT id, name, description, createdAt FROM template_groups WHERE id = ?').get(id);
  if (!g) return null;
  const templates = db.prepare(
    'SELECT template_name FROM template_group_members WHERE group_id = ? ORDER BY template_name COLLATE NOCASE ASC'
  ).all(id).map(r => r.template_name);
  return { ...g, templates, memberCount: templates.length };
}

export function getByName(name) {
  return db.prepare('SELECT * FROM template_groups WHERE name = ? COLLATE NOCASE').get(name);
}

export function create({ name, description = null }) {
  const now = new Date().toISOString();
  const info = db.prepare(
    'INSERT INTO template_groups (name, description, createdAt) VALUES (?, ?, ?)'
  ).run(name.trim(), description, now);
  return get(info.lastInsertRowid);
}

export function update(id, { name, description }) {
  const row = db.prepare('SELECT * FROM template_groups WHERE id = ?').get(id);
  if (!row) return null;
  db.prepare('UPDATE template_groups SET name = ?, description = ? WHERE id = ?').run(
    name        !== undefined ? name.trim() : row.name,
    description !== undefined ? description : row.description,
    id
  );
  return get(id);
}

// Deleting a group cascades its membership rows (ON DELETE CASCADE); templates
// themselves are never touched.
export function remove(id) {
  return db.prepare('DELETE FROM template_groups WHERE id = ?').run(id).changes;
}

// Add templates (by name) to a group. Only names that exist in `templates` are
// added; duplicates are ignored. Returns the number of rows inserted.
export function addMembers(groupId, templateNames) {
  const now    = new Date().toISOString();
  const ins    = db.prepare('INSERT OR IGNORE INTO template_group_members (group_id, template_name, addedAt) VALUES (?, ?, ?)');
  const exists = db.prepare('SELECT 1 FROM templates WHERE name = ?');
  let added = 0;
  const many = db.transaction((names) => {
    for (const n of names) {
      if (!exists.get(n)) continue;
      added += ins.run(groupId, n, now).changes;
    }
  });
  many([...new Set(templateNames)]);
  return added;
}

export function removeMembers(groupId, templateNames) {
  const del = db.prepare('DELETE FROM template_group_members WHERE group_id = ? AND template_name = ?');
  let removed = 0;
  const many = db.transaction((names) => {
    for (const n of names) removed += del.run(groupId, n).changes;
  });
  many([...new Set(templateNames)]);
  return removed;
}

// Drop a template from every group (used when the template is deleted).
export function removeTemplateFromAllGroups(templateName) {
  return db.prepare('DELETE FROM template_group_members WHERE template_name = ?').run(templateName).changes;
}
