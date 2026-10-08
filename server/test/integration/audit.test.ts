import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, skip, startKernel, type Harness } from './harness.js';

describe('audit trail', { skip }, () => {
  let k: Harness;
  let admin: Client, analyst: Client;

  before(async () => {
    k = await startKernel();
    [admin, analyst] = await Promise.all([k.login('admin'), k.login('analyst')]);
  });
  after(() => k?.close());

  test('records process changes with actor, channel and before/after', async () => {
    const p = (await analyst.post('/api/problems', { title: 'Audited', impact: 3 })).body;
    await analyst.patch(`/api/problems/${p.ref}`, { impact: 1 });
    const token = (await analyst.post('/api/tokens', { name: 'script', scopes: ['read', 'write'] })).body.token;
    await new Client(k.base, token).post(`/api/problems/${p.ref}/comments`, { body: 'via API' });

    const entries = (await admin.get(`/api/audit?entity_type=problem&entity_ref=${p.ref}`)).body;
    const update = entries.find((e: any) => e.action === 'update');
    assert.equal(update.actor_name, 'analyst');
    assert.equal(update.actor_type, 'user');
    assert.equal(update.channel, 'web');
    assert.deepEqual(update.changes.impact, { from: 3, to: 1 });
    const comment = entries.find((e: any) => e.action === 'comment');
    assert.equal(comment.actor_type, 'api_token');
    assert.match(comment.token_prefix, /^kernel_pat_/);
    assert.ok(entries.some((e: any) => e.action === 'created'));
  });

  test('records administration, sign-ins and tokens; sensitive actions need a reason', async () => {
    const created = await admin.post('/api/users', { username: 'auditee', display_name: 'Auditee', role: 'viewer', password: 'a fine long passphrase' });
    assert.equal((await admin.patch(`/api/users/${created.body.id}`, { role: 'analyst' })).status, 400);
    assert.equal((await admin.patch(`/api/users/${created.body.id}`, { role: 'analyst', reason: 'Joined the problem team' })).status, 200);
    const userEntries = (await admin.get('/api/audit?entity_type=user&entity_ref=auditee')).body;
    const roleChange = userEntries.find((e: any) => e.action === 'update');
    assert.deepEqual(roleChange.changes.role, { from: 'viewer', to: 'analyst' });
    assert.equal(roleChange.reason, 'Joined the problem team');
    assert.ok(userEntries.some((e: any) => e.action === 'create'));

    const logins = (await admin.get('/api/audit?entity_type=session&action=login')).body;
    assert.ok(logins.some((e: any) => e.entity_ref === 'analyst' && e.actor_name === 'analyst'));
    const tokens = (await admin.get('/api/audit?entity_type=api_token')).body;
    assert.ok(tokens.some((e: any) => e.action === 'create' && e.changes.scopes));
    assert.equal((await analyst.get('/api/audit')).status, 403);
  });

  test('is append-only and tamper-evident', async () => {
    const { pool } = await import('../../src/db.js');
    await assert.rejects(pool.query("UPDATE audit_log SET actor_name = 'someone else'"), /append-only/);
    await assert.rejects(pool.query('DELETE FROM audit_log'), /append-only/);
    assert.equal((await admin.get('/api/audit/verify')).body.ok, true);

    // Simulate tampering by an attacker with superuser rights: bypass the trigger and change a row.
    await pool.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
    await pool.query("UPDATE audit_log SET reason = 'forged' WHERE id = (SELECT min(id) + 1 FROM audit_log)");
    await pool.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');
    const verify = (await admin.get('/api/audit/verify')).body;
    assert.equal(verify.ok, false);
    assert.ok(verify.broken_at);
  });

  test('exports are audited too', async () => {
    const res = await fetch(`${k.base}/api/audit.csv?entity_type=user`, { headers: { Cookie: admin.cookie! } });
    assert.match(await res.text(), /^id,at,actor_name/);
    const exports = (await admin.get('/api/audit?entity_type=audit_log')).body;
    assert.equal(exports[0].action, 'export');
  });
});
