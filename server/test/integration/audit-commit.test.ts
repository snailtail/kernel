import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, ownerQuery, skip, startKernel, type Harness } from './harness.js';

const ok = (r: { status: number; body: unknown }) => assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);

describe('audit entries are appended at commit (#57)', { skip }, () => {
  let k: Harness;
  let admin: Client, analyst: Client, viewer: Client;

  before(async () => {
    k = await startKernel();
    [admin, analyst, viewer] = await Promise.all([k.login('admin'), k.login('analyst'), k.login('viewer')]);
  });
  after(() => k?.close());

  const rows = async (ref: string) => (await ownerQuery('SELECT id FROM audit_log WHERE entity_ref = $1', [ref])).rows.length;

  test('a rolled-back transaction leaves no entry, and neither does a rolled-back savepoint', async () => {
    const { tx, savepoint } = await import('../../src/db.js');
    const { audit } = await import('../../src/audit.js');
    await assert.rejects(tx(async (db) => {
      await audit(db, { entity_type: 'setting', entity_ref: 'rolled-back', action: 'update', changes: {} });
      throw new Error('later failure');
    }), /later failure/);
    assert.equal(await rows('rolled-back'), 0);

    await tx(async (db) => {
      await audit(db, { entity_type: 'setting', entity_ref: 'kept', action: 'update', changes: {} });
      await savepoint(db, 'nested', async () => {
        await audit(db, { entity_type: 'setting', entity_ref: 'savepoint-undone', action: 'update', changes: {} });
        throw new Error('inner');
      }).catch(() => {});
    });
    assert.equal(await rows('kept'), 1);
    assert.equal(await rows('savepoint-undone'), 0);
  });

  test('a failing append rolls the change back with it', async () => {
    const { tx } = await import('../../src/db.js');
    const { audit } = await import('../../src/audit.js');
    await assert.rejects(tx(async (db) => {
      await db.query("INSERT INTO settings (key, value) VALUES ('audit_commit_test', '1')");
      // A BigInt cannot be serialised, so the append (at commit) fails.
      await audit(db, { entity_type: 'setting', entity_ref: 'audit_commit_test', action: 'create', changes: { n: 1n } });
    }), /BigInt/);
    assert.equal((await ownerQuery("SELECT 1 FROM settings WHERE key = 'audit_commit_test'")).rows.length, 0, 'no change without its trace');
    assert.equal(await rows('audit_commit_test'), 0);
  });

  test('long transactions run side by side and the chain stays valid', async () => {
    const { tx } = await import('../../src/db.js');
    const { audit } = await import('../../src/audit.js');
    const long = (n: number) => tx(async (db) => {
      await audit(db, { entity_type: 'setting', entity_ref: `parallel-${n}`, action: 'update', changes: {} });
      await db.query('SELECT pg_sleep(0.5)');
    });
    const started = Date.now();
    await Promise.all([long(1), long(2), long(3)]);
    // Holding the chain lock from the first entry to commit would serialise them (≥ 1.5 s).
    assert.ok(Date.now() - started < 1200, `took ${Date.now() - started} ms`);
    for (const n of [1, 2, 3]) assert.equal(await rows(`parallel-${n}`), 1);
    assert.equal((await admin.get('/api/audit/verify')).body.ok, true);
  });

  test('filters by actor id and token prefix', async () => {
    const me = (await analyst.get('/api/auth/me')).body;
    const token = (await analyst.post('/api/tokens', { name: 'filter test', scopes: ['read', 'write'] })).body;
    const p = (await new Client(k.base, token.token).post('/api/problems', { title: 'Made by a token' })).body;
    const byToken = (await admin.get(`/api/audit?token_prefix=${encodeURIComponent(token.prefix)}`)).body;
    assert.ok(byToken.length > 0 && byToken.every((e: any) => e.token_prefix === token.prefix));
    assert.ok(byToken.some((e: any) => e.entity_ref === p.ref));
    const byActor = (await admin.get(`/api/audit?actor_id=${me.id}`)).body;
    assert.ok(byActor.length > 0 && byActor.every((e: any) => e.actor_user_id === me.id));
  });

  test('a CI history includes the sync batches that created and updated it', async () => {
    ok(await admin.post('/api/users', { username: 'hist-sync', display_name: 'History sync', role: 'integration', password: 'four quiet harbour lamps', ci_source_systems: ['vCenter'] }));
    const c = new Client(k.base);
    await c.post('/api/auth/login', { username: 'hist-sync', password: 'four quiet harbour lamps' });
    const sync = new Client(k.base, (await c.post('/api/tokens', { name: 'sync' })).body.token);
    const item = { source_system: 'vCenter', source_id: 'vm-hist-1', name: 'hist01', ci_type: 'virtual_machine', attributes: { os: 'RHEL 9' } };
    ok(await sync.post('/api/cis/upsert', { items: [item, { ...item, source_id: 'vm-hist-2', name: 'hist02' }] }));
    ok(await sync.post('/api/cis/upsert', { items: [{ ...item, attributes: { os: 'RHEL 9.4' } }] }));
    const ci = (await analyst.get('/api/cis?q=hist01')).body.find((x: any) => x.name === 'hist01');
    const history = (await viewer.get(`/api/records/${ci.ref}/history`)).body;
    const batches = history.filter((e: any) => e.entity_type === 'ci_upsert');
    assert.equal(batches.length, 2, JSON.stringify(history));
    const other = (await analyst.get('/api/cis?q=hist02')).body.find((x: any) => x.name === 'hist02');
    assert.equal((await viewer.get(`/api/records/${other.ref}/history`)).body.filter((e: any) => e.entity_type === 'ci_upsert').length, 1, 'only batches that touched it');
    assert.ok(history.every((e: any) => !('ip' in e) && !('user_agent' in e)), 'addresses stay in the admin audit log');
  });

  test('a confidential record history hides masked values from people not working on it', async () => {
    const p = (await analyst.post('/api/problems', { title: 'Confidential history', workaround: 'Reboot' })).body;
    ok(await analyst.patch(`/api/problems/${p.ref}`, { workaround: 'Restart' }));
    ok(await analyst.put(`/api/records/${p.ref}/classification`, { classification: 'confidential', reason: 'Concerns a board member' }));
    const change = (h: any[]) => h.find((e: any) => e.action === 'update' && e.changes.workaround)?.changes.workaround;
    assert.deepEqual(change((await analyst.get(`/api/records/${p.ref}/history`)).body), { from: 'Reboot', to: 'Restart' });
    assert.deepEqual(change((await viewer.get(`/api/records/${p.ref}/history`)).body), { masked: true });
  });
});
