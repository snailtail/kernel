import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { Client, skip, startKernel, type Harness } from './harness.js';

/** A stand-in for the OP5 Monitor REST API. */
function mockOp5() {
  const state = { hosts: [{ name: 'web01.corp.local', address: '10.1.0.5' }, { name: 'db01', address: '10.1.0.6' }], problems: [{ 'host.name': 'db01', description: 'Disk /var', state: 2, plugin_output: 'CRITICAL - 97% used', last_state_change: Math.floor(Date.now() / 1000) - 60 }], fail: false, delay: 0 };
  const server: Server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Basic ${Buffer.from('kernel:secret-pw').toString('base64')}`) return res.writeHead(401).end();
    if (state.fail) return res.writeHead(500).end();
    if (state.delay) await new Promise((r) => setTimeout(r, state.delay));
    const q = decodeURIComponent(new URL(req.url!, 'http://x').searchParams.get('query') ?? '');
    res.setHeader('Content-Type', 'application/json');
    if (req.url!.startsWith('/api/filter/count')) return res.end(JSON.stringify({ count: state.hosts.length }));
    res.end(JSON.stringify(q.startsWith('[hosts]') ? state.hosts : state.problems));
  });
  return { state, server, listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as any).port))) };
}

describe('connector framework and push contract (#18)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client;
  const op5 = mockOp5();
  let port = 0;
  let db: typeof import('../../src/db.js');

  before(async () => {
    process.env.KERNEL_SECRET_KEY = 'connector-test-key-0123456789abcdefghijk';
    process.env.KERNEL_OUTBOUND_ALLOW = '127.0.0.1';
    port = await op5.listen();
    k = await startKernel();
    [admin, pm, analyst] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst')]);
    db = await import('../../src/db.js');
  });
  after(async () => {
    delete process.env.KERNEL_SECRET_KEY;
    delete process.env.KERNEL_OUTBOUND_ALLOW;
    op5.server.close();
    await k?.close();
  });

  const ci = (id: string, extra: object = {}) => ({ source_id: id, name: id, ci_type: 'other', ...extra });

  test('a full snapshot marks missed CIs missing after three syncs, and a shrunk snapshot is refused', async () => {
    const push = (cis: object[], full = true) => pm.post('/api/cmdb/ci-batch', { source_system: 'Inventory', cis, full_sync: full });
    const all = Array.from({ length: 12 }, (_, n) => ci(`host-${n}`));
    const first = (await push(all)).body;
    assert.equal(first.cis.created, 12);
    const refused = (await push(all.slice(0, 2))).body;
    assert.match(refused.missing.refused, /more than 50 % fewer/);
    assert.equal((await db.query("SELECT max(missed_syncs)::int AS m FROM ci_sources WHERE source_system = 'Inventory'")).rows[0].m, 0, 'nothing marked');
    for (let n = 0; n < 3; n++) await push(all.slice(0, 11));
    const gone = (await analyst.get('/api/cis?q=host-11&status=all')).body[0];
    assert.equal(gone.status, 'missing');
    assert.ok((await analyst.get(`/api/cis/${gone.ref}`)).body.activity.some((a: any) => /Not reported by Inventory for 3 syncs/.test(a.body)));
    await push(all);
    assert.equal((await analyst.get(`/api/cis/${gone.ref}`)).body.status, 'active', 'back when it is reported again');
  });

  test('new source records join existing CIs, and attribute precedence keeps the better source', async () => {
    const web = (await pm.post('/api/cis', { name: 'web01', ci_type: 'virtual_machine', attributes: { fqdn: 'web01.corp.local', os: 'Ubuntu 24.04' } })).body.ref;
    await db.query(`UPDATE configuration_items SET attribute_sources = '{"os": "vCenter"}' WHERE ref = $1`, [web]);
    await db.query(`UPDATE settings SET value = jsonb_set(value, '{attribute_precedence}', '{"os": ["vCenter", "OP5"]}') WHERE key = 'cmdb_reconciliation'`);
    const r = (await pm.post('/api/cmdb/ci-batch', { source_system: 'OP5-push', cis: [ci('web01.corp.local', { ci_type: 'virtual_machine', attributes: { fqdn: 'web01.corp.local', os: 'Linux', ip: '10.1.0.5' } })] })).body;
    assert.deepEqual([r.cis.created, r.cis.matched], [0, 1]);
    const page = (await analyst.get(`/api/cis/${web}`)).body;
    assert.deepEqual(page.sources.map((s: any) => s.source_system), ['OP5-push']);
    assert.equal(page.attributes.ip, '10.1.0.5', 'a new attribute is taken');
    assert.equal(page.attributes.os, 'Ubuntu 24.04', 'unchanged by a weaker source');
    await db.query(`UPDATE settings SET value = jsonb_set(value, '{attribute_precedence}', '{}') WHERE key = 'cmdb_reconciliation'`);
  });

  test('an OP5 connector: write-only credentials, test, sync, alerts that clear, no overlapping runs', async () => {
    const base = { type: 'op5', name: 'OP5 prod', source_system: 'OP5', config: { base_url: `http://127.0.0.1:${port}`, default_ci_type: 'virtual_machine', insecure_http: true }, secret: { username: 'kernel', password: 'secret-pw' } };
    assert.equal((await pm.post('/api/connectors', base)).status, 403);
    const cleartext = await admin.post('/api/connectors', { ...base, config: { ...base.config, insecure_http: false } });
    assert.match(cleartext.body.error, /clear text/, 'http with credentials needs an explicit lab flag');
    assert.equal((await admin.post('/api/connectors', { ...base, name: 'x', source_system: 'x', config: { ...base.config, ca_pem: 'not a cert' } })).status, 400);
    assert.equal((await admin.post('/api/connectors', { ...base, private_allow: ['127.0.0.1'] })).status, 400, 'only private ranges can be allowed');
    const c = (await admin.post('/api/connectors', { ...base, private_allow: ['10.1.0.0/24'] })).body;
    assert.equal(c.has_secret, true);
    assert.equal(c.secret, undefined);
    const listed = JSON.stringify((await admin.get('/api/connectors')).body);
    assert.ok(!listed.includes('secret-pw'));
    const { rows } = await db.query('SELECT secret FROM connectors WHERE id = $1', [c.id]);
    assert.ok(!rows[0].secret.includes('secret-pw'), 'stored encrypted');
    assert.deepEqual((await admin.post(`/api/connectors/${c.id}/test`, {})).body, { ok: true, message: 'Connected: 2 hosts' });

    const run = (await admin.post(`/api/connectors/${c.id}/run`, {})).body;
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    const db01 = (await analyst.get('/api/cis?q=db01')).body[0];
    assert.equal(db01.source_systems[0], 'OP5');
    const alert = (await analyst.get('/api/alerts?q=Disk')).body[0];
    assert.deepEqual([alert.ci_ref, alert.severity, alert.source], [db01.ref, 'critical', 'OP5 prod']);
    op5.state.problems = [];
    await admin.post(`/api/connectors/${c.id}/run`, {});
    assert.equal((await analyst.get('/api/alerts?status=all&q=Disk')).body[0].status, 'closed', 'the problem is gone, so the alert clears');

    op5.state.delay = 300;
    const [a, b] = await Promise.all([admin.post(`/api/connectors/${c.id}/run`, {}), admin.post(`/api/connectors/${c.id}/run`, {})]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], 'never two runs at once');
    op5.state.delay = 0;

    op5.state.fail = true;
    const failed = (await admin.post(`/api/connectors/${c.id}/run`, {})).body;
    assert.equal(failed.status, 'failed');
    assert.equal((await db.query("SELECT max(missed_syncs)::int AS m FROM ci_sources WHERE source_system = 'OP5'")).rows[0].m, 0, 'a failed run marks nothing missed');
    op5.state.fail = false;
    const runs = (await admin.get(`/api/connectors/${c.id}/runs`)).body;
    assert.ok(runs.length >= 4 && runs[0].status === 'failed' && runs.some((r: any) => r.counts.created + r.counts.matched === 2));
  });

  test('a connector owns its source system', async () => {
    await admin.post('/api/users', { username: 'squatter', display_name: 'Squatter', role: 'integration', password: 'four quiet harbour lamps', ci_source_systems: ['OP5'] });
    const bot = new Client(k.base);
    await bot.post('/api/auth/login', { username: 'squatter', password: 'four quiet harbour lamps' });
    const sq = new Client(k.base, (await bot.post('/api/tokens', { name: 'x' })).body.token);
    const r = (await sq.post('/api/cmdb/ci-batch', { source_system: 'OP5', cis: [ci('evil')] })).body;
    assert.match(r.cis.errors[0].error, /synced by a Kernel connector/);
    const blocked = await admin.post('/api/connectors', { type: 'op5', name: 'Private', source_system: 'Private', config: { base_url: 'https://10.9.9.9' }, secret: { username: 'a', password: 'b' } });
    assert.equal((await admin.post(`/api/connectors/${blocked.body.id}/test`, {})).body.ok, false, 'a private address needs the connector allowlist');
  });
});
