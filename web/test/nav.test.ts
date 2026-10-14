import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Meta, User } from '../src/api.js';
import { FOOTER, HOME, NAV, PALETTE_ONLY, SHORTCUTS, navFor, newItems } from '../src/nav.js';

const routes = [...readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8').matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]);
const all = [HOME, ...NAV.flatMap((g) => g.items), ...FOOTER, ...PALETTE_ONLY];
const user = (role: User['role']) => ({ id: 1, role, preferences: {} }) as unknown as User;
const meta = (modules: Partial<Meta['modules']>) => ({ modules: { incident: true, change: true, event: true, cmdb: true, sla: true, knowledge: true, ...modules } }) as unknown as Meta;

test('every menu and palette destination is a real page', () => {
  for (const item of all) assert.ok(routes.includes(item.to.split('?')[0]), `${item.label}: no route for ${item.to}`);
});

test('the g-shortcuts are unique and come from the menu definition', () => {
  const keys = all.filter((i) => i.key).map((i) => i.key);
  assert.equal(new Set(keys).size, keys.length, 'no key twice');
  assert.equal(Object.keys(SHORTCUTS).length, keys.length);
});

test('the groups follow the process: respond, improve, learn, then the directory', () => {
  assert.deepEqual(NAV.map((g) => g.id), ['respond', 'improve', 'learn', 'directory']);
  const order = NAV.flatMap((g) => g.items.map((i) => i.to));
  for (const [a, b] of [['/events', '/incidents'], ['/incidents', '/candidates'], ['/candidates', '/problems'], ['/problems', '/kedb'], ['/kedb', '/changes'], ['/changes', '/actions'], ['/actions', '/knowledge']]) {
    assert.ok(order.indexOf(a) < order.indexOf(b), `${a} before ${b}`);
  }
});

test('with only problem management on, the menu shows Improve and Learn', () => {
  const groups = navFor(user('analyst'), meta({ incident: false, change: false, event: false, cmdb: false, sla: false, knowledge: false }));
  assert.deepEqual(groups.map((g) => g.id), ['improve', 'learn']);
  assert.ok(!groups.flatMap((g) => g.items).some((i) => i.to === '/changes'));
});

test('"+ New" offers what the role may create', () => {
  assert.deepEqual(newItems(user('viewer'), meta({})), []);
  assert.equal(newItems(user('problem_manager'), meta({}))[0].label, 'Problem');
  assert.equal(newItems(user('analyst'), meta({}))[0].label, 'Incident');
  assert.deepEqual(newItems(user('analyst'), meta({ incident: false, change: false, knowledge: false })).map((i) => i.label), ['Problem']);
});
