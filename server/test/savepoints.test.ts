import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const SRC = new URL('../src/', import.meta.url).pathname;
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));

test('savepoints go through savepoint() in db.ts, so a partial rollback drops its queued audit entries (#57)', () => {
  const raw = files(SRC)
    .filter((f) => !f.endsWith('/db.ts'))
    .filter((f) => /\bSAVEPOINT\b/.test(readFileSync(f, 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')))
    .map((f) => f.slice(SRC.length));
  assert.deepEqual(raw, [], 'use savepoint(db, name, fn) instead of a raw SAVEPOINT');
});
