import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { refPattern } from '../src/records/records.js';

// Refs grow past six digits after 999 999 (#229): every ref pattern is built from REF_DIGITS in records.ts, checked
// on the source like layers.test.ts.
const SRC = new URL('../src/', import.meta.url).pathname;
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));
const rel = (f: string) => f.slice(SRC.length);
// Six digits that are not refs: one-time codes and personal identity numbers.
const NOT_REFS = ['records/records.ts', 'security/mfa.ts', 'security/totp.ts', 'security/scanner.ts'];

test('no ref pattern is written with exactly six digits outside records.ts', () => {
  const offenders = files(SRC)
    .filter((f) => !NOT_REFS.includes(rel(f)) && /\\d\{6\}/.test(readFileSync(f, 'utf8')))
    .map(rel);
  assert.deepEqual(offenders, [], "build the pattern from REF_DIGITS or refPattern('INC') in records/records.ts");
});

test('a ref has six digits, or seven or more without a leading zero', () => {
  const inc = refPattern('INC');
  for (const ref of ['INC000001', 'INC999999', 'INC1000000', 'INC12345678']) assert.ok(inc.test(ref), ref);
  for (const ref of ['INC00001', 'INC0010001', 'PRB000001', 'INC000001x']) assert.ok(!inc.test(ref), ref);
});
