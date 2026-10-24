import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LIST_KEYS, SHORTCUTS } from '../src/nav.js';

const src = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('every list column can be hidden: styles/base.css has a rule per column key (#110)', () => {
  const keys = [...src('components/list/columns.tsx').match(/COLUMN_KEYS = \[([^\]]+)\]/)![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(keys.length > 10);
  const css = src('styles/base.css');
  for (const k of keys) assert.ok(css.includes(`[data-hide~="${k}"] [data-col="${k}"]`), `no rule hides column ${k}`);
});

test('list keys are unique and do not take a global shortcut', () => {
  const keys = Object.values(LIST_KEYS).map((k) => k.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const k of keys) assert.ok(!['n', '/', '?', 'g'].includes(k), `${k} is a global shortcut`);
  // "g" + key goes somewhere; the toolkit ignores the key after "g", so overlapping letters are fine but must exist.
  assert.ok(Object.keys(SHORTCUTS).length > 0);
});
