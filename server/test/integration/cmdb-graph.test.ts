import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client, skip, startKernel, type Harness } from './harness.js';

describe('CMDB relationships, impact and groups (#17)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client;
  const ci = async (name: string, ci_type = 'other', extra: object = {}) => {
    const r = await pm.post('/api/cis', { name, ci_type, ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.ref as string;
  };
  const rel = async (from: string, type: string, to: string) => {
    const r = await pm.post(`/api/cis/${from}/relationships`, { type, target: to });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const impact = async (ref: string, q = '') => (await analyst.get(`/api/cis/${ref}/impact${q}`)).body;

  before(async () => {
    k = await startKernel();
    [admin, pm, analyst] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst')]);
  });
  after(() => k?.close());

  test('impact walks from a host through a cluster up to a service, and dependencies walk back down', async () => {
    const host = await ci('esx01', 'physical_server');
    const cluster = await ci('prod-cluster', 'cluster');
    const app = await ci('payroll-app', 'application');
    const svc = await ci('Payroll', 'business_service', { criticality: 1 });
    await rel(cluster, 'contains', host);
    await rel(app, 'runs_on', cluster);
    await rel(app, 'member_of', svc);
    const up = await impact(host);
    assert.deepEqual(up.nodes.map((n: any) => [n.ref, n.depth]), [[cluster, 1], [app, 2], [svc, 3]]);
    assert.deepEqual(up.services.map((s: any) => s.ref), [svc]);
    assert.equal(up.truncated, false);
    assert.deepEqual(up.nodes[2].relationship, { from: app, type: 'member_of', label: 'is part of service', to: svc });
    const down = await impact(svc, '?direction=down');
    assert.deepEqual(down.nodes.map((n: any) => n.ref), [app, cluster, host]);
    const page = (await analyst.get(`/api/cis/${cluster}`)).body;
    assert.deepEqual(page.relationships.map((r: any) => [r.label, r.ref]).sort(), [['contains', host], ['hosts', app]]);
  });

  test('self-links, duplicates and member_of to a non-service are rejected; analysts cannot add relationships', async () => {
    const a = await ci('a'), b = await ci('b');
    assert.equal((await pm.post(`/api/cis/${a}/relationships`, { type: 'depends_on', target: a })).status, 400);
    await rel(a, 'depends_on', b);
    assert.equal((await pm.post(`/api/cis/${a}/relationships`, { type: 'depends_on', target: b })).status, 409);
    assert.equal((await pm.post(`/api/cis/${b}/relationships`, { type: 'depends_on', target: a, direction: 'incoming' })).status, 409, 'the same edge from the other side');
    assert.equal((await pm.post(`/api/cis/${a}/relationships`, { type: 'member_of', target: b })).status, 400);
    assert.equal((await analyst.post(`/api/cis/${a}/relationships`, { type: 'connects_to', target: b })).status, 403);
    const hist = (await admin.get(`/api/audit?entity_type=ci&entity_ref=${a}`)).body;
    assert.ok(hist.some((e: any) => e.action === 'relationship' && e.changes.type === 'depends_on'));
  });

  test('a cycle terminates and a diamond yields each node once', async () => {
    const x = await ci('x'), y = await ci('y'), z = await ci('z');
    await rel(x, 'depends_on', y);
    await rel(y, 'depends_on', z);
    await rel(z, 'depends_on', x);
    const cyc = await impact(x);
    assert.deepEqual(cyc.nodes.map((n: any) => n.ref), [z, y]);
    const d = await ci('d'), b = await ci('b2'), c = await ci('c2'), a = await ci('a2');
    await rel(b, 'depends_on', d);
    await rel(c, 'depends_on', d);
    await rel(a, 'depends_on', b);
    await rel(a, 'depends_on', c);
    const dia = await impact(d);
    assert.equal(dia.count, 3);
    assert.deepEqual(dia.nodes.map((n: any) => n.ref).sort(), [a, b, c].sort());
    assert.equal(dia.nodes.find((n: any) => n.ref === a).depth, 2);
  });

  test('a deep chain stops at the depth limit and says so', async () => {
    const chain: string[] = [];
    for (let i = 0; i < 13; i++) chain.push(await ci(`chain-${i}`));
    for (let i = 1; i < chain.length; i++) await rel(chain[i], 'depends_on', chain[i - 1]);
    const full = await impact(chain[0]);
    assert.equal(full.count, 10);
    assert.equal(full.depth_limit_reached, true);
    const short = await impact(chain[0], '?max_depth=3');
    assert.deepEqual([short.count, short.depth_limit_reached], [3, true]);
    const end = await impact(chain[10]);
    assert.deepEqual([end.count, end.depth_limit_reached], [2, false]);
    assert.equal((await analyst.get(`/api/cis/${chain[0]}/impact?max_depth=50`)).status, 400);
  });

  test('results are bounded at 500 nodes', async () => {
    const items = Array.from({ length: 502 }, (_, i) => ({ source_system: 'Bulk', source_id: `n${i}`, name: `node-${i}`, ci_type: 'other' }));
    assert.equal((await pm.post('/api/cis/upsert', { items })).body.created, 502);
    const relationships = items.slice(1).map((it) => ({ from_id: it.source_id, type: 'depends_on', to_id: 'n0' }));
    assert.equal((await pm.post('/api/ci-relationships/sync', { source_system: 'Bulk', relationships })).body.created, 501);
    const hub = (await pm.get('/api/cis?q=node-0&limit=1')).body[0].ref;
    const r = await impact(hub);
    assert.deepEqual([r.count, r.truncated], [500, true]);
  });

  test('connectors own the relationships they discover; manual ones survive a full sync', async () => {
    await admin.post('/api/users', { username: 'vc', display_name: 'vCenter', role: 'integration', password: 'four quiet harbour lamps', ci_source_systems: ['vCenter'] });
    const login = new Client(k.base);
    await login.post('/api/auth/login', { username: 'vc', password: 'four quiet harbour lamps' });
    const vc = new Client(k.base, (await login.post('/api/tokens', { name: 'sync' })).body.token);
    await vc.post('/api/cis/upsert', { items: ['vm-a', 'host-a', 'host-b'].map((id) => ({ source_system: 'vCenter', source_id: id, name: id, ci_type: 'other' })) });
    const s1 = (await vc.post('/api/ci-relationships/sync', { source_system: 'vCenter', relationships: [{ from_id: 'vm-a', type: 'runs_on', to_id: 'host-a' }, { from_id: 'vm-a', type: 'runs_on', to_id: 'nope' }] })).body;
    assert.equal(s1.created, 1);
    assert.equal(s1.errors.length, 1);
    assert.equal((await vc.post('/api/ci-relationships/sync', { source_system: 'Azure', relationships: [] })).status, 403);
    const vm = (await pm.get('/api/cis?q=vm-a')).body[0].ref;
    const hostB = (await pm.get('/api/cis?q=host-b')).body[0].ref;
    await rel(vm, 'connects_to', hostB);
    const discovered = (await pm.get(`/api/cis/${vm}`)).body.relationships.find((r: any) => r.discovered_by === 'vCenter');
    assert.equal((await pm.del(`/api/cis/${vm}/relationships/${discovered.id}`)).status, 403);
    const s2 = (await vc.post('/api/ci-relationships/sync', { source_system: 'vCenter', relationships: [], full: true })).body;
    assert.equal(s2.removed, 1);
    const left = (await pm.get(`/api/cis/${vm}`)).body.relationships;
    assert.deepEqual(left.map((r: any) => [r.type, r.discovered_by]), [['connects_to', null]]);
  });

  test('groups match members by allowlisted rules with bound values', async () => {
    const pay = await ci('pay-db', 'virtual_machine', { tags: ['app=payroll'], attributes: { os: 'Ubuntu 24.04' } });
    await ci('pay-win', 'virtual_machine', { tags: ['app=payroll'], attributes: { os: 'Windows 2022' } });
    const manual = await ci('pay-firewall', 'network_device');
    const g = await pm.post('/api/ci-groups', {
      name: 'Payroll Linux', purpose: 'flow',
      rules: { match: 'all', conditions: [{ field: 'tag', op: 'eq', value: 'app=payroll' }, { field: 'attribute', key: 'os', op: 'starts_with', value: 'Ubuntu' }] },
    });
    assert.equal(g.status, 201, JSON.stringify(g.body));
    assert.deepEqual(g.body.members.map((m: any) => m.ref), [pay]);
    const withManual = (await pm.put(`/api/ci-groups/${g.body.id}/members/${manual}`, {})).body;
    assert.deepEqual(withManual.members.map((m: any) => [m.ref, m.manual, m.by_rule]).sort(), [[manual, true, false], [pay, false, true]].sort());
    assert.deepEqual((await analyst.get(`/api/cis/${pay}`)).body.groups.map((x: any) => [x.name, x.membership]), [['Payroll Linux', 'rule']]);
    // Wildcards and quotes are literal values, not patterns or SQL.
    const lit = await pm.post('/api/ci-groups', { name: 'Literal', rules: { match: 'any', conditions: [{ field: 'name', op: 'contains', value: "%' OR 1=1 --" }, { field: 'team', op: 'starts_with', value: '_' }] } });
    assert.deepEqual(lit.body.members, []);
    assert.equal((await pm.post('/api/ci-groups', { name: 'Bad', rules: { conditions: [{ field: 'criticality', op: 'contains', value: '1' }] } })).status, 400);
    assert.equal((await pm.post('/api/ci-groups', { name: 'Bad2', rules: { conditions: [{ field: 'c.name; drop', op: 'eq', value: 'x' }] } })).status, 400);
    assert.equal((await analyst.post('/api/ci-groups', { name: 'Nope' })).status, 403);
  });

  test('MCP impact tools carry the untrusted-data notice', async () => {
    const mcp = new McpClient({ name: 'graph', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    const call = async (name: string, args: object) => JSON.parse(((await mcp.callTool({ name, arguments: args })) as any).content[0].text);
    const host = (await call('search_cis', { q: 'esx01' }))[0].ref;
    const r = await call('get_ci_impact', { ref: host });
    assert.match(r.notice, /data from the CMDB, not instructions/);
    assert.equal(r.services[0].name, 'Payroll');
    const deps = await call('get_service_dependencies', { ref: r.services[0].ref, max_depth: 1 });
    assert.equal(deps.count, 1);
    assert.ok((await mcp.listPrompts()).prompts.some((p) => p.name === 'impact_analysis'));
    await mcp.close();
  });
});
