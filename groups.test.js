// Contact groups (Phase 1) — CRUD, membership, and group-aware CSV import.
// In-memory DB; bare Express apps mounting the groups + contacts routers.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.DB_PATH ||= ':memory:';

const db             = (await import('./db.js')).default;
const groupsRouter   = (await import('./routes/groups.js')).default;
const contactsRouter = (await import('./routes/contacts.js')).default;

const app = express();
app.use(express.json());
app.use('/api/groups', groupsRouter);
app.use('/api/contacts', contactsRouter);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

// ── helpers ─────────────────────────────────────────────────────────────────
const req = async (method, path, body, isForm = false) => {
  const opts = { method };
  if (isForm) {
    opts.body = body; // FormData
  } else if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

let seq = 0;
function newContact(status = 'pending') {
  const email = `grp-${Date.now()}-${seq++}@example.com`;
  const id = Number(db.prepare(
    "INSERT INTO contacts (firstName, lastName, email, status) VALUES ('T', 'User', ?, ?)"
  ).run(email, status).lastInsertRowid);
  return { id, email };
}

const csvForm = (csv, fields = {}) => {
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'contacts.csv');
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};

// ── CRUD ──────────────────────────────────────────────────────────────────────
test('create group + list shows member count 0', async () => {
  const c = await req('POST', '/api/groups', { name: 'VIPs', description: 'top' });
  assert.equal(c.status, 201);
  assert.equal(c.body.name, 'VIPs');
  assert.equal(c.body.memberCount, 0);

  const list = await req('GET', '/api/groups');
  assert.equal(list.status, 200);
  assert.ok(list.body.some((g) => g.name === 'VIPs'));
});

test('duplicate group name → 409', async () => {
  await req('POST', '/api/groups', { name: 'Dupes' });
  const again = await req('POST', '/api/groups', { name: 'Dupes' });
  assert.equal(again.status, 409);
});

test('create with blank name → 400', async () => {
  const r = await req('POST', '/api/groups', { name: '   ' });
  assert.equal(r.status, 400);
});

test('rename group', async () => {
  const c = await req('POST', '/api/groups', { name: 'OldName' });
  const u = await req('PUT', `/api/groups/${c.body.id}`, { name: 'NewName' });
  assert.equal(u.status, 200);
  assert.equal(u.body.name, 'NewName');
});

// ── membership ─────────────────────────────────────────────────────────────────
test('add + remove members, count reflects membership', async () => {
  const g = (await req('POST', '/api/groups', { name: 'Members' })).body;
  const a = newContact(), b = newContact();

  const add = await req('POST', `/api/groups/${g.id}/members`, { contactIds: [a.id, b.id] });
  assert.equal(add.status, 200);
  assert.equal(add.body.added, 2);
  assert.equal(add.body.group.memberCount, 2);

  // idempotent — re-adding adds nothing
  const readd = await req('POST', `/api/groups/${g.id}/members`, { contactIds: [a.id, b.id] });
  assert.equal(readd.body.added, 0);

  const rem = await req('DELETE', `/api/groups/${g.id}/members`, { contactIds: [a.id] });
  assert.equal(rem.body.removed, 1);
  assert.equal(rem.body.group.memberCount, 1);
});

test('adding a non-existent contact id creates no membership', async () => {
  const g = (await req('POST', '/api/groups', { name: 'BadIds' })).body;
  const add = await req('POST', `/api/groups/${g.id}/members`, { contactIds: [999999] });
  assert.equal(add.body.added, 0);
  assert.equal(add.body.group.memberCount, 0);
});

test('delete group cascades membership rows', async () => {
  const g = (await req('POST', '/api/groups', { name: 'ToDelete' })).body;
  const a = newContact();
  await req('POST', `/api/groups/${g.id}/members`, { contactIds: [a.id] });

  const del = await req('DELETE', `/api/groups/${g.id}`);
  assert.equal(del.status, 200);
  const orphans = db.prepare('SELECT COUNT(*) n FROM contact_group_members WHERE group_id = ?').get(g.id).n;
  assert.equal(orphans, 0);
  // the contact itself survives
  assert.ok(db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(a.id));
});

// ── import into group ───────────────────────────────────────────────────────────
test('import into a NEW group creates it and adds all rows', async () => {
  const csv = 'firstName,lastName,email\nAda,Lovelace,ada@example.com\nAlan,Turing,alan@example.com';
  const r = await req('POST', '/api/contacts/import', csvForm(csv, { newGroupName: 'Import A' }), true);
  assert.equal(r.status, 200);
  assert.equal(r.body.imported, 2);
  assert.ok(r.body.group);
  assert.equal(r.body.group.addedToGroup, 2);

  const filtered = await req('GET', `/api/contacts?groupId=${r.body.group.id}`);
  assert.equal(filtered.body.length, 2);
});

test('import into an EXISTING group also adds pre-existing contacts', async () => {
  // seed a contact that already exists in the DB
  const existing = newContact();
  const g = (await req('POST', '/api/groups', { name: 'Import B' })).body;

  // CSV references the already-existing email (by address) + one brand new row
  const csv = `firstName,lastName,email\nT,User,${existing.email}\nGrace,Hopper,grace@example.com`;
  const r = await req('POST', '/api/contacts/import', csvForm(csv, { groupId: String(g.id) }), true);
  assert.equal(r.status, 200);
  assert.equal(r.body.imported, 1);  // only the new one inserted
  assert.equal(r.body.skipped, 1);   // existing email skipped as insert
  assert.equal(r.body.group.addedToGroup, 2); // BOTH added to the group

  const filtered = await req('GET', `/api/contacts?groupId=${g.id}`);
  assert.equal(filtered.body.length, 2);
});

test('import with no group field preserves original behaviour (no group key)', async () => {
  const csv = 'firstName,lastName,email\nNo,Group,nogroup@example.com';
  const r = await req('POST', '/api/contacts/import', csvForm(csv), true);
  assert.equal(r.status, 200);
  assert.equal(r.body.imported, 1);
  assert.equal(r.body.group, undefined);
});

test('import into a non-existent groupId → 404', async () => {
  const csv = 'firstName,lastName,email\nX,Y,xy@example.com';
  const r = await req('POST', '/api/contacts/import', csvForm(csv, { groupId: '999999' }), true);
  assert.equal(r.status, 404);
});
