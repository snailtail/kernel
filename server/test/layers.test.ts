import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// The layering rules of #175, checked on the source like savepoints.test.ts: no extra lint dependency, and it runs in
// CI with the unit tests.
const SRC = new URL('../src/', import.meta.url).pathname;
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));
const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
const imports = (f: string) => [...code(f).matchAll(/^import [^;]*? from '([^']+)';/gm)].map((m) => m[1]);
const rel = (f: string) => f.slice(SRC.length);

test('routes and MCP tools are thin: they call services, never the database', () => {
  const offenders = files(SRC)
    .filter((f) => rel(f).startsWith('routes/') || rel(f).startsWith('mcp/'))
    .filter((f) => imports(f).includes('../db.js'))
    .map(rel);
  assert.deepEqual(offenders, [], 'move the SQL into the domain service and call that');
});

test('core/ does not import the domains', () => {
  // Infrastructure that #176 moves into core/; until then core/ may import it from the top level.
  const infrastructure = ['../config.js', '../context.js', '../db.js', '../errors.js', '../log.js'];
  const offenders = files(join(SRC, 'core'))
    .flatMap((f) => imports(f).filter((m) => m.startsWith('../') && !infrastructure.includes(m)).map((m) => `${rel(f)} imports ${m}`));
  assert.deepEqual(offenders, [], 'a domain fills a hook in core/hooks.ts instead');
});

test('no import cycle is hidden behind a dynamic import', () => {
  // Telemetry loads OpenTelemetry only when it is switched on.
  const offenders = files(SRC)
    .filter((f) => rel(f) !== 'telemetry.ts' && /\bawait import\(/.test(code(f)))
    .map(rel);
  assert.deepEqual(offenders, [], 'let the higher layer fill a hook (core/hooks.ts) or use the record registry');
});
