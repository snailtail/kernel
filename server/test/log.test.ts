import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { createLogger } from '../src/log.js';

function capture(format: string, dataset?: string) {
  const lines: any[] = [];
  const destination = new Writable({ write(chunk, _enc, cb) { lines.push(JSON.parse(chunk.toString())); cb(); } });
  return { logger: createLogger({ format, level: 'info', destination, dataset }), lines };
}

test('ECS format writes Elastic Common Schema fields', () => {
  const { logger, lines } = capture('ecs', 'kernel.problem');
  logger.info({ event: { action: 'problem.created' }, problem: { ref: 'PRB000001' } }, 'Logged');
  const line = lines[0];
  assert.ok(line['@timestamp']);
  assert.equal(line['log.level'], 'info');
  assert.ok(line['ecs.version']);
  assert.equal(line.message, 'Logged');
  assert.equal(line['event.dataset'], 'kernel.problem');
  assert.equal(line.event.action, 'problem.created');
  assert.equal(line['service.name'], 'kernel');
  assert.equal(line.problem.ref, 'PRB000001');
});

test('default format is plain pino JSON', () => {
  const { logger, lines } = capture('json');
  logger.info('hello');
  assert.equal(lines[0].msg, 'hello');
  assert.equal(lines[0]['ecs.version'], undefined);
});

test('credentials never reach the log', () => {
  for (const format of ['ecs', 'json']) {
    const { logger, lines } = capture(format);
    logger.info({
      req: { method: 'GET', url: '/api/auth/me', headers: { cookie: 'kernel_session=SECRET1', authorization: 'Bearer krn_SECRET2' } },
      res: { statusCode: 200, headers: { 'set-cookie': 'kernel_session=SECRET3' } },
      headers: { authorization: 'Bearer krn_SECRET4' },
      user: { password: 'SECRET5' },
      token: 'krn_SECRET6',
    }, 'request completed');
    const out = JSON.stringify(lines);
    assert.doesNotMatch(out, /SECRET/, `${format}: ${out}`);
    assert.match(out, /\/api\/auth\/me/);
  }
});
