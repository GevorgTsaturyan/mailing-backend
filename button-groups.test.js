import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH ||= ':memory:';
await import('./db.js');
const G = await import('./services/ButtonGroupRepository.js');
const Buttons = await import('./services/ButtonRepository.js');

test('button groups: create, add/remove members (existing buttons only), list, delete', () => {
  const b1 = Buttons.create({ internal_name: 'A', text: 'Go', destination_url: 'https://a.example/' });
  const b2 = Buttons.create({ internal_name: 'B', text: 'Go', destination_url: 'https://b.example/' });
  const g = G.create({ name: 'Brand A' });
  assert.equal(G.addMembers(g.id, [b1.id, b2.id, b2.id, 99999]), 2);
  assert.deepEqual(G.get(g.id).buttonIds, [b1.id, b2.id]);
  assert.equal(G.removeMembers(g.id, [b2.id]), 1);
  assert.deepEqual(G.list().find(x => x.id === g.id).buttonIds, [b1.id]);
  G.removeButtonFromAllGroups(b1.id);
  assert.equal(G.get(g.id).memberCount, 0);
  assert.equal(G.remove(g.id), 1);
  assert.equal(G.get(g.id), null);
});
