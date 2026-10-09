import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { skip, startKernel, type Harness, type Client } from './harness.js';

describe('personal data and the audit trail (ADR 0001)', { skip }, () => {
  let k: Harness;
  let admin: Client, analyst: Client;
  let db: typeof import('../../src/db.js');
  let audit: typeof import('../../src/audit.js');

  before(async () => {
    process.env.KERNEL_SECRET_KEY = 'privacy-test-key-0123456789abcdefghijklm';
    k = await startKernel();
    [admin, analyst] = await Promise.all([k.login('admin'), k.login('analyst')]);
    db = await import('../../src/db.js');
    audit = await import('../../src/audit.js');
  });
  after(async () => {
    delete process.env.KERNEL_SECRET_KEY;
    await k?.close();
  });

  test('new entries hold ids, codes and keyed digests – no names, emails, IPs or free text', async () => {
    await admin.post('/api/users', { username: 'karin', display_name: 'Karin Svensson', email: 'karin@example.com', role: 'analyst', password: 'four quiet harbour lamps' });
    const p = (await analyst.post('/api/problems', { title: 'Printer jams', description: 'Karin Svensson reports it every morning' })).body;
    await analyst.post(`/api/problems/${p.ref}/transition`, { to: 'analysis' });
    const rows = (await db.query("SELECT * FROM audit_log WHERE at > now() - interval '5 minutes'")).rows;
    const text = JSON.stringify(rows);
    for (const secret of ['Karin Svensson', 'karin@example.com', 'every morning', 'Printer jams', '127.0.0.1']) assert.ok(!text.includes(secret), `"${secret}" is not in audit_log`);
    assert.ok(rows.every((r: any) => r.actor_name === '' && r.ip === ''));
    const status = rows.find((r: any) => r.entity_ref === p.ref && r.action === 'status');
    assert.deepEqual([status.changes.from, status.changes.to], ['new', 'analysis'], 'codes stay readable');
    const created = rows.find((r: any) => r.entity_type === 'user' && r.action === 'create');
    assert.match(created.entity_ref, /^#\d+$/);
    assert.match(created.changes.email.digest, /^hmac-sha256:/);
    assert.notEqual(created.changes.email.digest, `sha256:${createHash('sha256').update('karin@example.com').digest('hex')}`, 'not a plain, reversible hash');
    assert.ok((await db.query('SELECT count(*)::int AS n FROM audit_context WHERE ip IS NOT NULL')).rows[0].n > 0, 'IPs are kept outside the chain');
    const shown = (await admin.get(`/api/audit?entity_ref=${p.ref}`)).body[0];
    assert.equal(shown.actor_name, 'Analyst', 'names are joined for display');
  });

  test('erasing a user keeps the chain valid and leaves no name behind', async () => {
    const id = (await admin.get('/api/users')).body.find((u: any) => u.username === 'karin').id;
    assert.equal((await admin.post(`/api/users/${id}/erase`, { reason: 'Left the company, request from karin@example.com' })).status, 400, 'no personal data in reasons');
    assert.equal((await admin.post(`/api/users/${id}/erase`, { reason: 'Left the company (erasure request #12)' })).status, 200);
    const u = (await db.query('SELECT username, display_name, email FROM users WHERE id = $1', [id])).rows[0];
    assert.deepEqual(u, { username: `deleted-${id}`, display_name: `Deleted user #${id}`, email: '' });
    assert.equal((await audit.verifyChain()).ok, true);
    const all = JSON.stringify((await db.query("SELECT * FROM audit_log WHERE at > now() - interval '5 minutes'")).rows);
    assert.ok(!all.includes('Karin'));
    const sec = (await admin.get('/api/admin/security')).body.checks.find((c: any) => c.id === 'audit_personal_data');
    assert.equal(sec.ok, true);
  });
});
