import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// Long text and instants come from core/fields.ts (#241), so a limit is changed in one place; checked on the source
// like ref-digits.test.ts.
const SRC = new URL('../src/', import.meta.url).pathname;
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));
const rel = (f: string) => f.slice(SRC.length);

test('long text and instants are not written by hand outside core/fields.ts', () => {
  const offenders = files(SRC)
    .filter((f) => rel(f) !== 'core/fields.ts' && /z\.string\(\)\.max\(20000\)|z\.iso\.datetime\(\{ offset: true \}\)/.test(readFileSync(f, 'utf8')))
    .map(rel);
  assert.deepEqual(offenders, [], 'import longText or instant from core/fields.ts');
});
