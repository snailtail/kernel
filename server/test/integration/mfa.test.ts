import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { codeAt, counterNow } from '../../src/totp.js';
import { Client, PASSWORD, skip, startKernel, type Harness } from './harness.js';

describe('two-factor authentication and step-up', { skip }, () => {
  let k: Harness;
  let admin: Client;

  before(async () => {
    process.env.KERNEL_SECRET_KEY = 'test-secret-key-0123456789abcdefghijklmnop';
    k = await startKernel();
    admin = await k.login('admin');
  });
  after(() => k?.close());

  const login = async (c: Client, username: string, password = PASSWORD) => c.post('/api/auth/login', { username, password });

  test('enrol, sign in with TOTP (no replay) and with a recovery code', async () => {
    const a = await k.login('analyst');
    const setup = (await a.post('/api/auth/mfa/setup')).body;
    assert.match(setup.otpauth_url, /^otpauth:\/\/totp\/Kernel%3Aanalyst\?secret=/);
    assert.match(setup.qr, /^data:image\/png;base64,/);
    assert.equal((await a.post('/api/auth/mfa/enable', { code: '000000' })).status, 400);
    const step = counterNow();
    const enabled = await a.post('/api/auth/mfa/enable', { code: codeAt(setup.secret, step) });
    assert.equal(enabled.body.recovery_codes.length, 10);
    assert.equal((await a.get('/api/auth/mfa')).body.enabled, true);

    const c = new Client(k.base);
    const first = await login(c, 'analyst');
    assert.equal(first.body.mfa_required, true);
    assert.equal(c.cookies.get('kernel_session'), undefined, 'no session before the second factor');
    assert.equal((await c.post('/api/auth/login/mfa', { mfa_token: first.body.mfa_token, code: codeAt(setup.secret, step) })).status, 401, 'replayed code');
    const ok = await c.post('/api/auth/login/mfa', { mfa_token: first.body.mfa_token, code: codeAt(setup.secret, step + 1) });
    assert.equal(ok.status, 200);
    assert.equal((await c.get('/api/auth/me')).body.username, 'analyst');

    // Changing the password needs a code when 2FA is on.
    const noCode = await c.post('/api/auth/password', { current: PASSWORD, password: 'another long passphrase' });
    assert.equal(noCode.body.code_required, true);

    const r = new Client(k.base);
    const second = await login(r, 'analyst');
    const recovery = enabled.body.recovery_codes[0];
    assert.equal((await r.post('/api/auth/login/mfa', { mfa_token: second.body.mfa_token, code: recovery })).status, 200);
    const third = await login(new Client(k.base), 'analyst');
    assert.equal((await new Client(k.base).post('/api/auth/login/mfa', { mfa_token: third.body.mfa_token, code: recovery })).status, 401, 'recovery codes are single use');
  });

  test('a login challenge ends after five wrong codes', async () => {
    const c = new Client(k.base);
    const first = (await login(c, 'analyst')).body;
    for (let i = 0; i < 5; i++) await c.post('/api/auth/login/mfa', { mfa_token: first.mfa_token, code: '000000' });
    const after5 = await c.post('/api/auth/login/mfa', { mfa_token: first.mfa_token, code: '000000' });
    assert.match(after5.body.error ?? '', /expired|Too many/);
  });

  test('sensitive actions need a recent re-authentication and are not available to tokens', async () => {
    const pm = await k.login('pm');
    const token = (await pm.post('/api/tokens', { name: 'automation', expires_in_days: 1 })).body.token;
    const bearer = new Client(k.base, token);
    const viaToken = await bearer.post('/api/tokens', { name: 'minted by a token' });
    assert.equal(viaToken.status, 403);

    const { pool } = await import('../../src/db.js');
    await pool.query("UPDATE sessions SET reauth_at = now() - interval '1 hour'");
    const stale = await pm.post('/api/tokens', { name: 'later' });
    assert.equal(stale.status, 403);
    assert.equal(stale.body.reauth_required, true);
    assert.equal((await pm.post('/api/auth/reauth', { password: 'wrong' })).status, 401);
    assert.equal((await pm.post('/api/auth/reauth', { password: PASSWORD })).status, 200);
    assert.equal((await pm.post('/api/tokens', { name: 'later' })).status, 200);
    admin = await k.login('admin');
  });

  test('roles can be required to use two-factor authentication', async () => {
    assert.equal((await admin.put('/api/admin/mfa-policy', { required_roles: ['viewer'] })).status, 200);
    const v = await k.login('viewer');
    assert.equal((await v.get('/api/auth/me')).body.mfa_enrollment_required, true);
    const blocked = await v.get('/api/problems');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.mfa_enrollment_required, true);
    assert.equal((await v.post('/api/auth/mfa/setup')).status, 200, 'enrolment itself is allowed');
    await admin.put('/api/admin/mfa-policy', { required_roles: [] });
  });

  test('a known device can still sign in while others keep the account locked', async () => {
    const mine = new Client(k.base);
    assert.equal((await login(mine, 'analyst2')).status, 200);
    const attacker = new Client(k.base);
    for (let i = 0; i < 8; i++) await login(attacker, 'analyst2', 'wrong');
    assert.equal((await login(new Client(k.base), 'analyst2')).status, 429, 'new devices are locked out');
    mine.cookies.delete('kernel_session');
    assert.equal((await login(mine, 'analyst2')).status, 200, 'the known device is not');
  });
});
