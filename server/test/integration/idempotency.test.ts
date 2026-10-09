import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client, skip, startKernel, type Harness } from './harness.js';

describe('Idempotency-Key (#77)', { skip }, () => {
  let k: Harness;
  let admin: Client, analyst: Client;

  before(async () => {
    process.env.KERNEL_SECRET_KEY = 'idem-test-key-0123456789abcdefghijklmnop';
    k = await startKernel();
    [admin, analyst] = await Promise.all([k.login('admin'), k.login('analyst')]);
  });
  after(() => k?.close());

  const rows = async () => {
    const { pool } = await import('../../src/db.js');
    return (await pool.query('SELECT route, body::text AS body FROM idempotency_keys')).rows;
  };

  test('routes returning secrets ignore the key and store nothing', async () => {
    const a = await analyst.request('POST', '/api/tokens', { name: 't1' }, { 'Idempotency-Key': 'secret-1' });
    const b = await analyst.request('POST', '/api/tokens', { name: 't1' }, { 'Idempotency-Key': 'secret-1' });
    assert.notEqual(a.body.token, b.body.token, 'a new token each time, never a replay');
    await analyst.request('POST', '/api/auth/mfa/setup', {}, { 'Idempotency-Key': 'secret-2' });
    const stored = await rows();
    assert.ok(!stored.some((r) => /tokens|mfa/.test(r.route)));
    assert.ok(!stored.some((r) => /kernel_pat_|otpauth/.test(r.body ?? '')));
  });

  test('the body must match the original request', async () => {
    const first = await analyst.request('POST', '/api/problems', { title: 'Original' }, { 'Idempotency-Key': 'fp-1' });
    assert.equal(first.status, 201);
    const changed = await analyst.request('POST', '/api/problems', { title: 'Something else' }, { 'Idempotency-Key': 'fp-1' });
    assert.equal(changed.status, 422);
  });

  test('a stored response is not replayed to a caller who may no longer act', async () => {
    const user = await admin.post('/api/users', { username: 'demoted', display_name: 'Demoted', role: 'analyst', password: 'a long enough passphrase' });
    const c = new Client(k.base);
    await c.post('/api/auth/login', { username: 'demoted', password: 'a long enough passphrase' });
    assert.equal((await c.request('POST', '/api/problems', { title: 'Before demotion' }, { 'Idempotency-Key': 'role-1' })).status, 201);
    await admin.patch(`/api/users/${user.body.id}`, { role: 'viewer', reason: 'Test demotion' });
    await c.post('/api/auth/login', { username: 'demoted', password: 'a long enough passphrase' });
    const replay = await c.request('POST', '/api/problems', { title: 'Before demotion' }, { 'Idempotency-Key': 'role-1' });
    assert.equal(replay.status, 403);
  });

  test('abandoned in-flight keys can be taken over', async () => {
    const { pool } = await import('../../src/db.js');
    const me = (await analyst.get('/api/auth/me')).body;
    const res1 = await analyst.request('POST', '/api/problems', { title: 'Crashed' }, { 'Idempotency-Key': 'crash-1' });
    // Simulate a crash after claiming: make the key in-flight and old.
    await pool.query("UPDATE idempotency_keys SET status = NULL, body = NULL, created_at = now() - interval '5 minutes' WHERE user_id = $1 AND key = 'crash-1'", [me.id]);
    const retry = await analyst.request('POST', '/api/problems', { title: 'Crashed' }, { 'Idempotency-Key': 'crash-1' });
    assert.equal(retry.status, 201);
    assert.notEqual(retry.body.ref, res1.body.ref);
  });

  test('MCP create tools accept an idempotency key', async () => {
    const mcp = new McpClient({ name: 'idem', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    const call = async () => JSON.parse(((await mcp.callTool({ name: 'create_problem', arguments: { title: 'MCP once', idempotency_key: 'mcp-1' } })) as any).content[0].text);
    const a = await call();
    const b = await call();
    assert.equal(a.ref, b.ref);
    await mcp.close();
  });
});
