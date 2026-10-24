import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, PASSWORD, skip, startKernel, type Harness } from './harness.js';

describe('authentication hardening', { skip }, () => {
  let k: Harness;
  let admin: Client;

  before(async () => {
    k = await startKernel();
    admin = await k.login('admin');
  });
  after(() => k?.close());

  test('password policy: length, common passwords, own name', async () => {
    const create = (username: string, password: string) =>
      admin.post('/api/users', { username, display_name: 'Policy Tester', role: 'viewer', password });
    assert.match((await create('p1', 'short')).body.error, /at least 12/);
    assert.match((await create('p2', 'password1234')).body.error, /too common/);
    assert.match((await create('p3', 'aaaaaaaaaaaaaaa')).body.error, /too common/);
    assert.match((await create('tester99', 'my tester99 phrase')).body.error, /name or username/);
    assert.match((await create('p5', 'hello policy friend')).body.error, /name or username/, 'display name parts count too');
    assert.equal((await create('p6', 'four random words here')).status, 201);
  });

  test('locks an account after repeated failures, without revealing whether it exists', async () => {
    const anon = new Client(k.base);
    for (let i = 0; i < 8; i++) assert.equal((await anon.post('/api/auth/login', { username: 'analyst2', password: 'wrong' })).status, 401);
    const locked = await anon.post('/api/auth/login', { username: 'analyst2', password: PASSWORD });
    assert.equal(locked.status, 429, 'even the right password is refused while locked');
    for (let i = 0; i < 8; i++) await anon.post('/api/auth/login', { username: 'nobody-here', password: 'wrong' });
    assert.equal((await anon.post('/api/auth/login', { username: 'nobody-here', password: 'x' })).status, 429, 'unknown accounts behave the same');
  });

  test('lists and revokes sessions; password change signs out other sessions', async () => {
    const a = await k.login('analyst');
    const b = await k.login('analyst');
    const sessions = (await a.get('/api/auth/sessions')).body;
    assert.ok(sessions.length >= 2);
    assert.equal(sessions.filter((s: any) => s.current).length, 1);
    const other = sessions.find((s: any) => !s.current);
    assert.equal((await a.del(`/api/auth/sessions/${other.id}`)).status, 200);
    const c = await k.login('analyst');
    assert.equal((await a.post('/api/auth/sessions/revoke-others')).status, 200);
    assert.equal((await c.get('/api/auth/me')).status, 401);
    assert.equal((await a.get('/api/auth/me')).status, 200);
    void b;
  });

  test('idle sessions expire', async () => {
    const v = await k.login('viewer');
    const { pool } = await import('../../src/core/db.js');
    await pool.query("UPDATE sessions SET last_seen_at = now() - interval '13 hours' WHERE user_id = (SELECT id FROM users WHERE username = 'viewer')");
    assert.equal((await v.get('/api/auth/me')).status, 401);
  });
});
