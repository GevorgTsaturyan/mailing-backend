import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
process.env.DB_PATH ||= ':memory:';
const db = (await import('./db.js')).default;
const { default: router, splitAB } = await import('./routes/scheduled-sends.js');

const app = express(); app.use(express.json()); app.use('/api/scheduled-sends', router);
const server = app.listen(0); after(() => server.close());
const url = `http://127.0.0.1:${server.address().port}/api/scheduled-sends`;
const post = (body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

db.prepare("INSERT INTO templates (name, subject, html, txt, content_type) VALUES ('TA','s','','t','text'), ('TB','s','<p>h</p>','t','html')").run();
const ids = Array.from({ length: 9 }, (_, i) => Number(db.prepare("INSERT INTO contacts (firstName,lastName,email) VALUES ('a','b',?)").run(`ab${i}@x.com`).lastInsertRowid));

test('splitAB: disjoint random halves covering everyone (A gets the odd one)', () => {
  const { a, b } = splitAB(ids);
  assert.equal(a.length, 5); assert.equal(b.length, 4);
  assert.deepEqual([...a, ...b].sort((x, y) => x - y), [...ids].sort((x, y) => x - y));
});

test('POST with abTemplateName creates two linked scheduled sends with own content types', async () => {
  const r = await post({ label: 'AB run', contactIds: ids, templateName: 'TA', abTemplateName: 'TB', scheduledAt: '2030-01-01T00:00:00Z' });
  assert.equal(r.status, 201);
  const body = await r.json();
  const [A, B] = body.abTest.variants;
  assert.equal(A.ab_test_id, B.ab_test_id);
  assert.deepEqual([A.ab_variant, B.ab_variant], ['A', 'B']);
  assert.deepEqual([A.templateName, B.templateName], ['TA', 'TB']);
  assert.deepEqual([A.content_type, B.content_type], ['text', 'html']);
  assert.equal(A.label, 'AB run'); assert.equal(B.label, 'AB run');
  const all = [...A.contactIds, ...B.contactIds];
  assert.equal(new Set(all).size, ids.length, 'no one gets both versions');
});

test('A/B validation errors', async () => {
  assert.equal((await post({ contactIds: ids, templateName: 'TA', abTemplateName: 'TA', scheduledAt: '2030-01-01T00:00:00Z' })).status, 400);
  assert.equal((await post({ contactIds: [ids[0]], templateName: 'TA', abTemplateName: 'TB', scheduledAt: '2030-01-01T00:00:00Z' })).status, 400);
  assert.equal((await post({ contactIds: ids, templateName: 'TA', abTemplateName: 'nope', scheduledAt: '2030-01-01T00:00:00Z' })).status, 400);
});
