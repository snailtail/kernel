import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, PASSWORD, skip, startKernel, type Harness } from './harness.js';

describe('HTTP security', { skip }, () => {
  let k: Harness;
  let admin: Client, analyst: Client;

  before(async () => {
    k = await startKernel();
    [admin, analyst] = await Promise.all([k.login('admin'), k.login('analyst')]);
  });
  after(() => k?.close());

  test('sends security headers and a strict CSP', async () => {
    const res = await fetch(`${k.base}/api/auth/me`, { headers: { Cookie: analyst.cookie! } });
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/, 'no inline or eval scripts');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.match(res.headers.get('permissions-policy') ?? '', /camera=\(\)/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.ok(res.headers.get('strict-transport-security'));
  });

  test('rejects cross-site cookie-authenticated writes', async () => {
    const evil = await analyst.request('POST', '/api/problems', { title: 'x' }, { Origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    const crossSite = await analyst.request('POST', '/api/problems', { title: 'x' }, { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(crossSite.status, 403);
    const same = await analyst.request('POST', '/api/problems', { title: 'Same origin' }, { Origin: k.base, 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(same.status, 201);
  });

  test('accepts only JSON bodies', async () => {
    const res = await fetch(`${k.base}/api/problems`, {
      method: 'POST',
      headers: { Cookie: analyst.cookie!, 'X-Kernel-Request': '1', 'Content-Type': 'text/plain' },
      body: '{"title":"x"}',
    });
    assert.equal(res.status, 415);
  });

  test('valid large requests fit the body limits', async () => {
    const summary = 'å'.repeat(2000);
    const records = Array.from({ length: 500 }, (_, i) => ({ system: 'Big', kind: 'event', reference: `BIG-${i}`, service: 'Bulk', summary }));
    const ingest = await analyst.post('/api/integrations/records', { records });
    assert.equal(ingest.status, 200, JSON.stringify(ingest.body).slice(0, 200));
    assert.equal(ingest.body.stored, 500);

    const p = (await analyst.post('/api/problems', { title: 'Long texts' })).body;
    const long = 'ö'.repeat(20000);
    const fields = { description: long, root_cause: long, workaround: long, resolution: long, major_review: long };
    const base = { description: '', root_cause: '', workaround: '', resolution: '', major_review: '' };
    const res = await analyst.patch(`/api/problems/${p.ref}`, { ...fields, base });
    assert.equal(res.status, 200);
    const again = await analyst.patch(`/api/problems/${p.ref}`, { ...Object.fromEntries(Object.keys(fields).map((k) => [k, long.slice(1) + '!'])), base: fields });
    assert.equal(again.status, 200);
  });

  test('accepts CSP violation reports', async () => {
    const res = await fetch(`${k.base}/api/csp-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/csp-report' },
      body: JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src' } }),
    });
    assert.equal(res.status, 204);
  });

  test('a generated password must be changed first', async () => {
    const { pool } = await import('../../src/db.js');
    await pool.query("UPDATE users SET must_change_password = true WHERE username = 'viewer'");
    const viewer = await k.login('viewer');
    assert.equal((await viewer.get('/api/auth/me')).body.must_change_password, true);
    const blocked = await viewer.get('/api/problems');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.must_change_password, true);
    assert.equal((await viewer.post('/api/auth/password', { current: PASSWORD, password: PASSWORD })).status, 400, 'must differ');
    assert.equal((await viewer.post('/api/auth/password', { current: PASSWORD, password: 'a brand new passphrase' })).status, 200);
    assert.equal((await viewer.get('/api/problems')).status, 200);
  });

  test('security status is for admins', async () => {
    assert.equal((await analyst.get('/api/admin/security')).status, 403);
    const status = await admin.get('/api/admin/security');
    assert.ok(status.body.checks.some((c: any) => c.id === 'secret_key'));
  });
});
