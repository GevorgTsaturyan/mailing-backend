// Template groups — CRUD + membership (keyed by template name).
// In-memory DB; bare Express apps mounting the template-groups + templates routers.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.DB_PATH ||= ':memory:';

const db                    = (await import('./db.js')).default;
const templateGroupsRouter  = (await import('./routes/template-groups.js')).default;
const templatesRouter       = (await import('./routes/templates.js')).default;

const app = express();
app.use(express.json());
app.use('/api/template-groups', templateGroupsRouter);
app.use('/api/templates', templatesRouter);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const req = async (method, path, body) => {
  const opts = { method };
  if (body !== undefined) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

async function mkTemplate(name) {
  const r = await req('POST', '/api/templates', { name, subject: 'S' });
  assert.equal(r.status, 201);
  return name;
}

test('TG-A: create, list, rename, and reject duplicate names', async () => {
  const c = await req('POST', '/api/template-groups', { name: 'Onboarding' });
  assert.equal(c.status, 201);
  assert.equal(c.body.name, 'Onboarding');
  assert.equal(c.body.memberCount, 0);

  const dup = await req('POST', '/api/template-groups', { name: 'Onboarding' });
  assert.equal(dup.status, 409);

  const upd = await req('PUT', `/api/template-groups/${c.body.id}`, { name: 'Onboarding v2' });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.name, 'Onboarding v2');

  const empty = await req('POST', '/api/template-groups', { name: '   ' });
  assert.equal(empty.status, 400);
});

test('TG-B: add/remove members (only existing templates), reflected in list', async () => {
  await mkTemplate('welcome');
  await mkTemplate('promo');
  const g = (await req('POST', '/api/template-groups', { name: 'Marketing' })).body;

  // valid + non-existent → only the valid one is added
  const add = await req('POST', `/api/template-groups/${g.id}/members`, { templateNames: ['welcome', 'ghost'] });
  assert.equal(add.status, 200);
  assert.equal(add.body.added, 1);
  assert.deepEqual(add.body.group.templates, ['welcome']);

  const list = await req('GET', '/api/template-groups');
  const marketing = list.body.find(x => x.id === g.id);
  assert.deepEqual(marketing.templates, ['welcome']);
  assert.equal(marketing.memberCount, 1);

  const rm = await req('DELETE', `/api/template-groups/${g.id}/members`, { templateNames: ['welcome'] });
  assert.equal(rm.status, 200);
  assert.equal(rm.body.removed, 1);
  assert.equal(rm.body.group.memberCount, 0);
});

test('TG-C: deleting a template removes it from its groups', async () => {
  await mkTemplate('bye');
  const g = (await req('POST', '/api/template-groups', { name: 'Temp' })).body;
  await req('POST', `/api/template-groups/${g.id}/members`, { templateNames: ['bye'] });
  assert.equal((await req('GET', `/api/template-groups/${g.id}`)).body.memberCount, 1);

  const del = await req('DELETE', '/api/templates/bye');
  assert.equal(del.status, 200);
  assert.equal((await req('GET', `/api/template-groups/${g.id}`)).body.memberCount, 0);
});

test('TG-D: deleting a group keeps the templates but drops membership', async () => {
  await mkTemplate('keep');
  const g = (await req('POST', '/api/template-groups', { name: 'Disposable' })).body;
  await req('POST', `/api/template-groups/${g.id}/members`, { templateNames: ['keep'] });

  const del = await req('DELETE', `/api/template-groups/${g.id}`);
  assert.equal(del.status, 200);
  assert.equal((await req('GET', `/api/template-groups/${g.id}`)).status, 404);

  // the template itself still exists
  assert.equal((await req('GET', '/api/templates/keep')).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM template_group_members WHERE template_name=?').get('keep').c, 0);
});
