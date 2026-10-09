import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { skip, startKernel, type Client, type Harness } from './harness.js';

describe('API rate limit per caller (#66)', { skip }, () => {
  let k: Harness;
  let analyst: Client, viewer: Client;
  before(async () => {
    process.env.KERNEL_RATE_LIMIT_PER_MINUTE = '15';
    k = await startKernel();
    [analyst, viewer] = await Promise.all([k.login('analyst'), k.login('viewer')]);
  });
  after(async () => {
    delete process.env.KERNEL_RATE_LIMIT_PER_MINUTE;
    await k?.close();
  });

  test('one caller is throttled without affecting others, and health checks are never limited', async () => {
    let last = 0;
    for (let n = 0; n < 20; n++) last = (await analyst.get('/api/problems')).status;
    assert.equal(last, 429);
    const r = await analyst.get('/api/problems');
    assert.ok(r.body.retry_after_seconds > 0);
    assert.equal((await viewer.get('/api/problems')).status, 200, 'another session has its own budget');
    for (let n = 0; n < 20; n++) assert.equal((await fetch(`${k.base}/healthz`)).status, 200);
  });
});
