import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client, skip, startKernel, type Harness } from './harness.js';

describe('CMDB core (#16)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client, viewer: Client;

  before(async () => {
    k = await startKernel();
    [admin, pm, analyst, viewer] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst'), k.login('viewer')]);
  });
  after(() => k?.close());

  test('managers create CIs and services with typed attributes and source links', async () => {
    assert.equal((await analyst.post('/api/cis', { name: 'web01', ci_type: 'virtual_machine' })).status, 403);
    const vm = await pm.post('/api/cis', {
      name: 'web01', ci_type: 'virtual_machine', environment: 'prod', criticality: 2, team: 'Web',
      attributes: { os: 'Ubuntu 24.04', ip: '10.0.0.5', ram_gb: '16', unknown_field: 'dropped' },
      source: { system: 'vCenter', id: 'vm-1001', url: 'https://vcenter.example/ui/vm-1001' },
    });
    assert.equal(vm.status, 201, JSON.stringify(vm.body));
    assert.match(vm.body.ref, /^CI\d{6}$/);
    assert.equal(vm.body.type, 'ci');
    assert.deepEqual(vm.body.attributes, { os: 'Ubuntu 24.04', ip: '10.0.0.5', ram_gb: 16 });
    assert.equal(vm.body.sources[0].source_url, 'https://vcenter.example/ui/vm-1001');
    assert.equal((await pm.post('/api/cis', { name: 'x', ci_type: 'virtual_machine', attributes: { cpu: 'many' } })).status, 400);
    const svc = (await pm.post('/api/cis', { name: 'Online shop', ci_type: 'business_service', criticality: 1 })).body;
    assert.match(svc.ref, /^SVC\d{6}$/);
    assert.equal(svc.type, 'service');
    assert.equal((await pm.patch(`/api/cis/${svc.ref}`, { ci_type: 'database' })).status, 400, 'a service cannot become a CI');
  });

  test('search by name, type and attribute; readers read, analysts annotate', async () => {
    const byIp = (await viewer.get('/api/cis?q=10.0.0.5')).body;
    assert.ok(byIp.some((c: any) => c.name === 'web01'));
    assert.ok((await viewer.get('/api/cis?class=service')).body.every((c: any) => c.type === 'service'));
    const ci = (await viewer.get('/api/cis?q=web01')).body[0];
    assert.equal((await viewer.post(`/api/cis/${ci.ref}/comments`, { body: 'x' })).status, 403);
    const noted = await analyst.post(`/api/cis/${ci.ref}/comments`, { body: 'Disk alarms every night' });
    assert.equal(noted.body.activity[0].kind, 'comment');
    const linked = await analyst.post(`/api/cis/${ci.ref}/links`, { kind: 'incident', reference: 'INC-77', system: 'ServiceNow' });
    assert.equal(linked.body.links[0].reference, 'INC-77');
    const moved = await pm.post(`/api/cis/${ci.ref}/transition`, { to: 'maintenance', comment: 'Patch weekend' });
    assert.equal(moved.body.status, 'maintenance');
    const hist = (await admin.get(`/api/audit?entity_type=ci&entity_ref=${ci.ref}`)).body;
    assert.ok(hist.some((e: any) => e.action === 'status' && e.changes.to === 'maintenance'));
    assert.ok((await analyst.get(`/api/search?q=web01`)).body.some((h: any) => h.type === 'ci'));
    assert.equal((await analyst.get(`/api/records/${ci.ref}`)).body.name, 'web01');
  });

  test('integrations upsert CIs from their own source only', async () => {
    await admin.post('/api/users', { username: 'vcenter-sync', display_name: 'vCenter sync', role: 'integration', password: 'four quiet harbour lamps', ci_source_systems: ['vCenter'] });
    await admin.post('/api/users', { username: 'azure-sync', display_name: 'Azure sync', role: 'integration', password: 'four quiet harbour lamps', ci_source_systems: ['Azure'] });
    const token = async (u: string) => {
      const c = new Client(k.base);
      await c.post('/api/auth/login', { username: u, password: 'four quiet harbour lamps' });
      return new Client(k.base, (await c.post('/api/tokens', { name: 'sync' })).body.token);
    };
    const vc = await token('vcenter-sync');
    const items = [
      { source_system: 'vCenter', source_id: 'vm-2001', source_url: 'https://vc/vm-2001', name: 'db01', ci_type: 'virtual_machine', attributes: { os: 'RHEL 9' } },
      { source_system: 'vCenter', source_id: 'vm-2002', name: 'db02', ci_type: 'virtual_machine' },
      { source_system: 'vCenter', source_id: 'vm-2003', name: 'bad', ci_type: 'no_such_type' },
    ];
    const firstRes = await vc.post("/api/cis/upsert", { items });
    assert.equal(firstRes.status, 200, JSON.stringify(firstRes.body));
    const first = firstRes.body;
    assert.equal(first.created, 2);
    assert.equal(first.errors.length, 1);
    const again = (await vc.post('/api/cis/upsert', { items: [items[0], { ...items[1], attributes: { os: 'RHEL 9.4' } }] })).body;
    assert.deepEqual([again.created, again.updated, again.unchanged], [0, 1, 1]);
    const az = await token('azure-sync');
    const hijack = (await az.post('/api/cis/upsert', { items: [{ ...items[0], name: 'renamed by another source' }] })).body;
    assert.equal(hijack.errors.length, 1);
    assert.match(hijack.errors[0].error, /may not report CIs for source system "vCenter"/);
    const squat = (await az.post('/api/cis/upsert', { items: [{ source_system: 'VMware', source_id: 'x', name: 'x', ci_type: 'other' }] })).body;
    assert.equal(squat.created, 0, 'an integration cannot claim a source system it was not allowed');
    // A manager may correct another source's data, but only with a reason that is audited.
    const plain = (await pm.post('/api/cis/upsert', { items: [{ ...items[0], name: 'db01-corrected' }] })).body;
    assert.match(plain.errors[0].error, /override_reason/);
    const fixed = (await pm.post('/api/cis/upsert', { items: [{ ...items[0], name: 'db01-corrected' }], override_reason: 'Wrong name in vCenter' })).body;
    assert.equal(fixed.updated, 1);
    const ref = (await pm.get('/api/cis?q=db01-corrected')).body[0].ref;
    const log = (await admin.get(`/api/audit?entity_type=ci&entity_ref=${ref}`)).body;
    assert.ok(log.some((e: any) => e.changes.override === true && e.changes.reason === 'Wrong name in vCenter'));
    await pm.post('/api/cis/upsert', { items: [items[0]], override_reason: 'Restore' });
    assert.equal((await vc.get('/api/cis')).status, 403, 'integrations cannot read the CMDB');
  });

  test('MCP tools for CIs, and generic comment/link on CI refs', async () => {
    const mcp = new McpClient({ name: 'cmdb', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('pm')}` } } }));
    const call = async (name: string, args: object) => JSON.parse(((await mcp.callTool({ name, arguments: args })) as any).content[0].text);
    const hits = await call('search_cis', { q: 'db01' });
    assert.equal(hits[0].name, 'db01');
    const ci = await call('get_ci', { ref: hits[0].ref });
    assert.equal(ci.sources[0].source_system, 'vCenter');
    await call('add_comment', { ref: hits[0].ref, body: 'Noted by an agent' });
    await call('link_records', { from: hits[0].ref, to: 'CHG-9', kind: 'change' });
    const after = await call('get_ci', { ref: hits[0].ref });
    assert.ok(after.links.some((l: any) => l.reference === 'CHG-9'));
    assert.equal(after.activity.find((a: any) => a.kind === 'comment').channel, 'mcp');
    await mcp.close();
  });
});
