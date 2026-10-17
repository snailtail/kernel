import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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

/** Many OP5 stand-ins on one port (/c0, /c1…), counting requests in flight; paths in `hang` never answer. */
function mockFleet() {
  const state = { inFlight: 0, maxInFlight: 0, perConnector: new Map<string, number>(), maxPerConnector: 0, hang: new Set<string>() };
  const server: Server = createServer(async (req, res) => {
    const name = req.url!.split('/')[1];
    if (state.hang.has(name)) return;
    const mine = (state.perConnector.get(name) ?? 0) + 1;
    state.perConnector.set(name, mine);
    state.maxPerConnector = Math.max(state.maxPerConnector, mine);
    state.maxInFlight = Math.max(state.maxInFlight, ++state.inFlight);
    await new Promise((r) => setTimeout(r, 150));
    state.inFlight--;
    state.perConnector.set(name, state.perConnector.get(name)! - 1);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url!.includes(encodeURIComponent('[hosts]')) ? [{ name: `${name}-host`, address: '10.2.0.1' }] : []));
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

  test('CIs missing for retire_after_days are proposed for retirement, and a person retires them', async () => {
    const push = (cis: object[]) => pm.post('/api/cmdb/ci-batch', { source_system: 'Retiring', cis, full_sync: true });
    const all = Array.from({ length: 12 }, (_, n) => ci(`old-${n}`));
    await push(all);
    for (let n = 0; n < 3; n++) await push(all.slice(0, 9));
    const refOf = async (name: string) => (await analyst.get(`/api/cis?q=${name}&status=all`)).body[0].ref as string;
    const [gone, owned, back] = await Promise.all([refOf('old-9'), refOf('old-10'), refOf('old-11')]);
    assert.equal((await analyst.get(`/api/cis/${gone}`)).body.status, 'missing');
    assert.deepEqual((await analyst.get('/api/cis/retire-proposals')).body, [], 'not proposed before retire_after_days');
    assert.match((await analyst.get(`/api/cis/${gone}`)).body.next_steps.next, /proposed for retirement on \d{4}-\d{2}-\d{2}/);

    await db.query("UPDATE configuration_items SET missing_since = now() - interval '15 days' WHERE ref = ANY($1)", [[gone, owned, back]]);
    const me = (await analyst.get('/api/auth/me')).body;
    await pm.patch(`/api/cis/${owned}`, { owner_id: me.id });
    assert.equal((await pm.post(`/api/cis/${back}/relationships`, { type: 'runs_on', target: gone })).status, 200);
    const inc = (await analyst.post('/api/incidents', { title: 'Old host unreachable' })).body.ref;
    await analyst.post(`/api/incidents/${inc}/cis`, { ci: gone });

    const proposals = (await analyst.get('/api/cis/retire-proposals')).body;
    assert.deepEqual(proposals.map((p: any) => p.ref).sort(), [gone, owned, back].sort());
    const p = proposals.find((x: any) => x.ref === gone);
    assert.deepEqual([p.sources[0].source_system, p.retire_after_days, p.can_retire], ['Retiring', 14, false]);
    assert.deepEqual(p.open_records.map((o: any) => o.ref), [inc]);
    assert.equal(proposals.find((x: any) => x.ref === owned).can_retire, true, 'the owner may retire their own CI');
    assert.match((await analyst.get(`/api/cis/${gone}`)).body.next_steps.next, /^Proposed for retirement/);
    assert.deepEqual(p.relationships.map((r: any) => [r.type, r.direction, r.ref]), [['runs_on', 'in', back]]);
    assert.equal((await analyst.get('/api/health-tips')).body.find((t: any) => t.id === 'ci_retire')?.count, 3);

    // A CI that comes back before it is retired is active again and no longer proposed.
    await push([...all.slice(0, 9), all[11]]);
    assert.equal((await analyst.get(`/api/cis/${back}`)).body.status, 'active');
    assert.equal((await db.query('SELECT missing_since FROM configuration_items WHERE ref = $1', [back])).rows[0].missing_since, null);

    const denied = (await analyst.post('/api/cis/retire', { refs: [gone] })).body;
    assert.match(denied.results[0].reason, /Only an administrator, a CMDB manager or the owner/);
    assert.equal((await analyst.post('/api/cis/retire', { refs: [owned], comment: 'Decommissioned in March' })).body.retired, 1);
    const first = (await pm.post('/api/cis/retire', { refs: [gone, back, owned] })).body.results;
    assert.deepEqual(first.map((r: any) => r.outcome), ['skipped', 'skipped', 'unchanged']);
    assert.match(first[0].reason, new RegExp(`Open records name it: ${inc}`));
    assert.match(first[1].reason, /not missing/);
    assert.equal((await pm.post('/api/cis/retire', { refs: [gone], acknowledge_open: true })).body.retired, 1);

    const page = (await analyst.get(`/api/cis/${gone}`)).body;
    assert.equal(page.status, 'retired');
    const entry = page.activity.find((a: any) => a.kind === 'status' && a.data.to === 'retired');
    assert.deepEqual([entry.data.from, entry.data.open_records], ['missing', [inc]]);
    assert.equal((await analyst.get(`/api/cis/${owned}`)).body.activity.find((a: any) => a.data.to === 'retired').body, 'Decommissioned in March');
    assert.ok((await db.query("SELECT 1 FROM audit_log WHERE entity_ref = $1 AND action = 'status' AND changes->>'to' = 'retired'", [gone])).rows[0], 'audited');
    assert.deepEqual((await analyst.get('/api/cis/retire-proposals')).body, []);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM configuration_items WHERE ref = ANY($1)', [[gone, owned]])).rows[0].n, 2, 'never deleted');
  });

  test('retire_after_days per connector, and retiring over MCP needs the person\'s confirmation', async () => {
    const push = (cis: object[]) => pm.post('/api/cmdb/ci-batch', { source_system: 'Patient', cis, full_sync: true });
    const all = Array.from({ length: 10 }, (_, n) => ci(`patient-${n}`));
    await push(all);
    for (let n = 0; n < 3; n++) await push(all.slice(0, 9));
    const ref = (await analyst.get('/api/cis?q=patient-9&status=all')).body[0].ref;
    await db.query("UPDATE configuration_items SET missing_since = now() - interval '20 days' WHERE ref = $1", [ref]);
    const proposed = async () => (await analyst.get('/api/cis/retire-proposals')).body.map((p: any) => p.ref);
    assert.ok((await proposed()).includes(ref));
    const c = (await admin.post('/api/connectors', { type: 'op5', name: 'Patient', source_system: 'Patient', retire_after_days: 30, enabled: false,
      config: { base_url: 'https://op5.example.com' }, secret: { username: 'a', password: 'b' } })).body;
    assert.equal(c.retire_after_days, 30);
    assert.ok(!(await proposed()).includes(ref), 'the connector waits 30 days');
    await admin.put(`/api/connectors/${c.id}`, { type: 'op5', name: 'Patient', source_system: 'Patient', retire_after_days: 7, enabled: false, config: { base_url: 'https://op5.example.com' } });
    assert.ok((await proposed()).includes(ref));

    const mcp = new McpClient({ name: 'retire-test', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('pm')}` } } }));
    try {
      const call = async (name: string, args: object) => (await mcp.callTool({ name, arguments: args as any })) as any;
      assert.ok(JSON.parse((await call('list_retire_proposals', {})).content[0].text).some((p: any) => p.ref === ref));
      const unconfirmed = await call('retire_cis', { refs: [ref] });
      assert.equal(unconfirmed.isError, true);
      assert.match(unconfirmed.content[0].text, /is a decision/);
      const done = await call('retire_cis', { refs: [ref], human_confirmation: 'Yes, retire it' });
      assert.equal(JSON.parse(done.content[0].text).retired, 1);
      const { rows: quoted } = await db.query("SELECT entity_ref FROM audit_log WHERE entity_type = 'ci' AND action = 'mcp_human_confirmation' AND reason = 'Yes, retire it'");
      assert.deepEqual(quoted.map((r: any) => r.entity_ref), [ref], 'the quote lands on the CI itself, so its history shows it');
    } finally {
      await mcp.close();
    }
  });

  test('the scheduler runs every due connector in one tick, a few at a time, never one twice, past a hanging one', async () => {
    const fleet = mockFleet();
    const fleetPort = await fleet.listen();
    const { runDueConnectors } = await import('../../src/connectors.js');
    await db.query('UPDATE connectors SET enabled = false');
    const ids: number[] = [];
    for (let n = 0; n < 8; n++) {
      const c = (await admin.post('/api/connectors', { type: 'op5', name: `Fleet ${n}`, source_system: `Fleet ${n}`, private_allow: [],
        config: { base_url: `http://127.0.0.1:${fleetPort}/c${n}`, insecure_http: true }, secret: { username: 'kernel', password: 'pw' } })).body;
      ids.push(c.id);
    }
    fleet.state.hang.add('c3');
    try {
      const ran = await runDueConnectors({ concurrency: 3, timeoutMs: 1500 });
      assert.equal(ran, 8, 'all eight in one tick, not five');
      assert.ok(fleet.state.maxInFlight <= 3 && fleet.state.maxInFlight >= 2, `at most three at once (saw ${fleet.state.maxInFlight})`);
      const last = async () => (await db.query('SELECT DISTINCT ON (connector_id) connector_id, status, message FROM connector_runs WHERE connector_id = ANY($1) ORDER BY connector_id, id DESC', [ids])).rows;
      const runs = await last();
      assert.equal(runs.length, 8);
      const hung = runs.find((r) => r.connector_id === ids[3]);
      assert.deepEqual([hung.status, /no complete answer within 1.5 s/.test(hung.message)], ['failed', true]);
      assert.ok(runs.filter((r) => r.connector_id !== ids[3]).every((r) => r.status === 'succeeded'), JSON.stringify(runs));
      assert.equal((await db.query('SELECT count(*)::int AS n FROM connectors WHERE id = ANY($1) AND running_until IS NOT NULL', [ids])).rows[0].n, 0, 'every lease released');

      // Two replicas ticking at once share the work: each connector runs exactly once, never twice at the same time.
      fleet.state.hang.clear();
      fleet.state.maxPerConnector = 0;
      await db.query("UPDATE connectors SET next_run_at = now() - interval '1 minute' WHERE id = ANY($1)", [ids]);
      const before = (await db.query('SELECT count(*)::int AS n FROM connector_runs WHERE connector_id = ANY($1)', [ids])).rows[0].n;
      const [a, b] = await Promise.all([runDueConnectors({ timeoutMs: 5000 }), runDueConnectors({ timeoutMs: 5000 })]);
      assert.equal(a + b, 8);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM connector_runs WHERE connector_id = ANY($1)', [ids])).rows[0].n - before, 8);
      assert.equal(fleet.state.maxPerConnector, 1);
    } finally {
      fleet.server.closeAllConnections();
      fleet.server.close();
    }
  });

  test('a scheduled run claims only a connector that is still due; a stopped fetch keeps the lease until it settles', async () => {
    const fleet = mockFleet();
    const fleetPort = await fleet.listen();
    const connectors = await import('../../src/connectors.js');
    await db.query('UPDATE connectors SET enabled = false');
    const c = (await admin.post('/api/connectors', { type: 'op5', name: 'Due once', source_system: 'Due once', private_allow: [],
      config: { base_url: `http://127.0.0.1:${fleetPort}/due`, insecure_http: true }, secret: { username: 'kernel', password: 'pw' } })).body;
    try {
      await db.query("UPDATE connectors SET next_run_at = now() - interval '1 minute' WHERE id = $1", [c.id]);
      // Two ticks listed it; the first runs it and releases the lease. The second, with the same stale list, must not.
      assert.equal((await connectors.runConnector(c.id, 'schedule')).status, 'succeeded');
      await assert.rejects(connectors.runConnector(c.id, 'schedule'), /no longer due/);
      assert.equal((await connectors.runConnector(c.id, 'manual')).status, 'succeeded', 'Run now is not bound to the schedule');

      // A fetch that ignores the signal: the run fails at the timeout, but the lease holds until the fetch is done.
      const op5 = connectors.CONNECTOR_TYPES.op5;
      const original = op5.fetch;
      let finish!: () => void;
      op5.fetch = () => new Promise((resolve) => { finish = () => resolve({ cis: [] }); });
      try {
        await db.query("UPDATE connectors SET next_run_at = now() - interval '1 minute' WHERE id = $1", [c.id]);
        assert.equal((await connectors.runConnector(c.id, 'schedule', undefined, 200)).status, 'failed');
        const lease = async () => (await db.query('SELECT running_until IS NOT NULL AS held FROM connectors WHERE id = $1', [c.id])).rows[0].held;
        assert.equal(await lease(), true, 'still fetching: no second run beside it');
        await assert.rejects(connectors.runConnector(c.id, 'manual'), /already running/);
        finish();
        for (let i = 0; i < 50 && (await lease()); i++) await new Promise((r) => setTimeout(r, 20));
        assert.equal(await lease(), false, 'released once the fetch settled');

        // A fetch that outlives its 30-minute lease must not release the next run's lease when it finally settles.
        const settle: (() => void)[] = [];
        op5.fetch = () => new Promise((resolve) => { settle.push(() => resolve({ cis: [] })); });
        await db.query("UPDATE connectors SET next_run_at = now() - interval '1 minute' WHERE id = $1", [c.id]);
        assert.equal((await connectors.runConnector(c.id, 'schedule', undefined, 200)).status, 'failed');
        await db.query("UPDATE connectors SET running_until = now() - interval '1 minute' WHERE id = $1", [c.id]); // A's lease expired
        const b = connectors.runConnector(c.id, 'manual', undefined, 60_000);
        for (let i = 0; i < 50 && settle.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
        assert.equal(settle.length, 2, 'B is fetching');
        settle[0](); // the zombie A settles
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(await lease(), true, "A did not release B's lease");
        settle[1]();
        assert.equal((await b).status, 'succeeded');
        assert.equal(await lease(), false);
      } finally {
        op5.fetch = original;
      }
    } finally {
      fleet.server.closeAllConnections();
      fleet.server.close();
    }
  });
});
