import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Meta, User } from '../src/api.js';
import { FOOTER, HOME, NAV, PALETTE_ONLY, SHORTCUTS, START_PAGES, focusPractice, navFor, newItems, startPath } from '../src/nav.js';

const routes = [...readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8').matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]);
const all = [HOME, ...NAV.flatMap((g) => g.items), ...FOOTER, ...PALETTE_ONLY];
const user = (role: User['role'], start: Partial<Pick<User, 'home' | 'default_new'>> = { home: 'my_work', default_new: 'incident' }) => ({ id: 1, role, preferences: {}, ...start }) as unknown as User;
const meta = (modules: Partial<Meta['modules']>) => ({ modules: { incident: true, change: true, event: true, cmdb: true, sla: true, knowledge: true, request: false, ...modules } }) as unknown as Meta;

test('every menu and palette destination is a real page', () => {
  for (const item of [...all, ...START_PAGES]) assert.ok(routes.includes(item.to.split('?')[0]), `${item.label}: no route for ${item.to}`);
});

test('the g-shortcuts are unique and come from the menu definition', () => {
  const keys = all.filter((i) => i.key).map((i) => i.key);
  assert.equal(new Set(keys).size, keys.length, 'no key twice');
  assert.equal(Object.keys(SHORTCUTS).length, keys.length);
});

test('the groups follow the process: respond, improve, learn, then the directory', () => {
  assert.deepEqual(NAV.map((g) => g.id), ['respond', 'improve', 'learn', 'directory']);
  const order = NAV.flatMap((g) => g.items.map((i) => i.to));
  for (const [a, b] of [['/events', '/incidents'], ['/incidents', '/candidates'], ['/candidates', '/problems'], ['/problems', '/kedb'], ['/kedb', '/changes'], ['/changes', '/actions'], ['/actions', '/improvements'], ['/improvements', '/knowledge']]) {
    assert.ok(order.indexOf(a) < order.indexOf(b), `${a} before ${b}`);
  }
});

test('with only problem management on, the menu shows Improve, Learn and the automation rules', () => {
  const groups = navFor(user('analyst'), meta({ incident: false, change: false, event: false, cmdb: false, sla: false, knowledge: false }));
  assert.deepEqual(groups.map((g) => g.id), ['improve', 'learn', 'directory']);
  assert.deepEqual(groups.find((g) => g.id === 'directory')!.items.map((i) => i.to), ['/rules'], 'rules apply to problems too');
  assert.ok(!groups.flatMap((g) => g.items).some((i) => i.to === '/changes'));
  assert.ok(!navFor(user('analyst'), meta({})).flatMap((g) => g.items).some((i) => i.to === '/requests'), 'service requests only when the module is on');
  assert.ok(navFor(user('analyst'), meta({ request: true })).flatMap((g) => g.items).some((i) => i.to === '/requests'));
});

test('"+ New" offers what the role may create, the person\'s default first (#171)', () => {
  assert.deepEqual(newItems(user('viewer'), meta({})), []);
  assert.equal(newItems(user('problem_manager'), meta({}))[0].label, 'Incident', 'no practice is favoured for managers');
  assert.equal(newItems(user('problem_manager', { default_new: 'problem' }), meta({}))[0].label, 'Problem');
  assert.equal(newItems(user('analyst', { default_new: 'change' }), meta({}))[0].label, 'Change');
  assert.equal(newItems(user('analyst', { default_new: 'change' }), meta({ change: false }))[0].label, 'Incident', 'a default whose module is off falls back');
  assert.deepEqual(newItems(user('analyst'), meta({ incident: false, change: false, knowledge: false })).map((i) => i.label), ['Problem', 'Improvement']);
  // On a practice's pages its own record comes first.
  assert.equal(newItems(user('problem_manager', { default_new: 'problem' }), meta({}), '/incidents/INC000004')[0].label, 'Incident');
  assert.equal(newItems(user('analyst'), meta({}), '/changes')[0].label, 'Change');
  assert.equal(newItems(user('analyst'), meta({}), '/kedb')[0].label, 'Problem');
  // Service requests (#44) are an optional module, off by default.
  assert.ok(!newItems(user('analyst'), meta({})).some((i) => i.label === 'Request'));
  assert.equal(newItems(user('analyst'), meta({ request: true }), '/requests')[0].label, 'Request');
});

test('"/" opens the person\'s start page, My work when its module is off (#171)', () => {
  assert.equal(startPath(user('analyst'), meta({})), '/my-work');
  assert.equal(startPath(user('analyst', { home: 'changes' }), meta({})), '/changes');
  assert.equal(startPath(user('analyst', { home: 'changes' }), meta({ change: false })), '/my-work');
  assert.equal(focusPractice(user('analyst', { home: 'dashboard', default_new: 'change' })), 'change', 'a non-practice start page falls to the default record');
  assert.equal(focusPractice(user('analyst', { home: 'requests', default_new: 'incident' })), 'request');
  assert.equal(focusPractice(user('analyst', { home: 'my_work', default_new: 'article' })), null);
});
