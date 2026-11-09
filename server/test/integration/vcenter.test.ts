import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { skip, startKernel, type Client, type Harness } from './harness.js';

const AUTH = `Basic ${Buffer.from('kernel@vsphere.local:vc-pw').toString('base64')}`;
const VC_UUID = '5f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f';
const BIOS = '4215ABCD-1234-5678-9ABC-DEF012345678';

/**
 * A fake vCenter (vSphere Automation REST API): sessions created with basic auth and deleted again, inventory lists
 * with the filters the connector uses, per-VM details and VMware Tools, tags, and paths the user may not read.
 */
function fakeVcenter() {
  const state = {
    datacenters: [{ datacenter: 'datacenter-1', name: 'DC Stockholm' }],
    clusters: [{ cluster: 'domain-c8', name: 'Prod cluster', ha_enabled: true, drs_enabled: false }],
    hosts: [
      { host: 'host-10', name: 'esx01.corp.local', connection_state: 'CONNECTED', power_state: 'POWERED_ON', cluster: 'domain-c8' },
      { host: 'host-20', name: '10.0.0.20', connection_state: 'CONNECTED', power_state: 'POWERED_ON' },
    ] as any[],
    vms: {
      'vm-42': {
        host: 'host-10', folder: 'group-v3', pool: 'resgroup-9',
        info: { name: 'web01', identity: { name: 'web01', bios_uuid: BIOS, instance_uuid: '5015AAAA-0000-1111-2222-333344445555' }, guest_OS: 'RHEL_9_64', cpu: { count: 4 }, memory: { size_MiB: 8192 }, power_state: 'POWERED_ON', disks: { 2000: { backing: { vmdk_file: '[ds-prod] web01/web01.vmdk' } } } },
        guest: { host_name: 'web01.corp.local', ip_address: '10.1.0.42', full_name: { default_message: 'Red Hat Enterprise Linux 9 (64-bit)' } },
      },
      // Powered on, but VMware Tools is not running: no IP, no host name.
      'vm-43': { host: 'host-10', pool: 'resgroup-9', info: { name: 'db01', identity: { bios_uuid: '4215ffff-0000-0000-0000-000000000043' }, guest_OS: 'WINDOWS_SERVER_2022', cpu: { count: 8 }, memory: { size_MiB: 32768 }, power_state: 'POWERED_ON', disks: {} }, guest: null },
      'vm-50': { host: 'host-20', info: { name: 'old-build', identity: { bios_uuid: '4215eeee-0000-0000-0000-000000000050' }, guest_OS: 'UBUNTU_64', cpu: { count: 2 }, memory: { size_MiB: 2048 }, power_state: 'POWERED_OFF', disks: {} }, guest: { ip_address: '10.9.9.9' } },
    } as Record<string, any>,
    datastores: [{ datastore: 'datastore-11', name: 'ds-prod', type: 'VMFS', capacity: 2 * 1024 ** 4, free_space: 1024 ** 4 }],
    tags: { 'urn:tag:1': { name: 'payments', category_id: 'urn:cat:1', objects: ['vm-42', 'host-10'] } } as Record<string, any>,
    categories: { 'urn:cat:1': 'Team' } as Record<string, string>,
    sessions: new Set<string>(),
    opened: 0,
    forbidden: new Set<string>(),
    requests: [] as string[],
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const path = url.pathname;
    state.requests.push(`${req.method} ${path}${url.search}`);
    const json = (v: unknown, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(v));
    if (path === '/api/session' && req.method === 'POST') {
      if (req.headers.authorization !== AUTH) return json({ error_type: 'UNAUTHENTICATED' }, 401);
      const token = `session-${++state.opened}`;
      state.sessions.add(token);
      return json(token, 201);
    }
    const token = String(req.headers['vmware-api-session-id'] ?? '');
    if (!state.sessions.has(token)) return json({ error_type: 'UNAUTHENTICATED' }, 401);
    if (path === '/api/session' && req.method === 'DELETE') { state.sessions.delete(token); return res.writeHead(204).end(); }
    if ([...state.forbidden].some((f) => path.startsWith(f))) return json({ error_type: 'UNAUTHORIZED' }, 403);
    const p = url.searchParams;
    const vm = (id: string) => ({ vm: id, name: state.vms[id].info.name, power_state: state.vms[id].info.power_state });
    if (path === '/api/vcenter/datacenter') return json(state.datacenters);
    if (path === '/api/vcenter/cluster') return json(state.clusters);
    if (path === '/api/vcenter/host') return json(state.hosts.filter((h) => !p.get('clusters') || h.cluster === p.get('clusters')).map(({ cluster: _, ...h }) => h));
    if (path === '/api/vcenter/datastore') return json(state.datastores);
    if (path === '/api/vcenter/folder') return json([{ folder: 'group-v3', name: 'Webshop', type: 'VIRTUAL_MACHINE' }]);
    if (path === '/api/vcenter/resource-pool') return json([{ resource_pool: 'resgroup-9', name: 'Resources' }]);
    if (path === '/api/vcenter/vm') {
      const ids = Object.keys(state.vms).filter((id) => {
        const v = state.vms[id];
        return (!p.get('hosts') || v.host === p.get('hosts')) && (!p.get('folders') || v.folder === p.get('folders')) && (!p.get('resource_pools') || v.pool === p.get('resource_pools'));
      });
      return json(ids.map(vm));
    }
    const guest = /^\/api\/vcenter\/vm\/([^/]+)\/guest\/identity$/.exec(path);
    if (guest) {
      const v = state.vms[guest[1]];
      if (!v) return json({}, 404);
      return v.info.power_state === 'POWERED_ON' && v.guest ? json(v.guest) : json({ error_type: 'SERVICE_UNAVAILABLE' }, 503);
    }
    const detail = /^\/api\/vcenter\/vm\/([^/]+)$/.exec(path);
    if (detail) return state.vms[detail[1]] ? json(state.vms[detail[1]].info) : json({ error_type: 'NOT_FOUND' }, 404);
    if (path === '/api/cis/tagging/tag') return json(Object.keys(state.tags));
    const t = /^\/api\/cis\/tagging\/tag\/(.+)$/.exec(path);
    if (t) return json({ id: decodeURIComponent(t[1]), ...state.tags[decodeURIComponent(t[1])] });
    const c = /^\/api\/cis\/tagging\/category\/(.+)$/.exec(path);
    if (c) return json({ id: decodeURIComponent(c[1]), name: state.categories[decodeURIComponent(c[1])] });
    if (path === '/api/cis/tagging/tag-association' && req.method === 'POST' && p.get('action') === 'list-attached-objects-on-tags') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => json(JSON.parse(body).tag_ids.map((id: string) => ({ tag_id: id, object_ids: state.tags[id].objects.map((o: string) => ({ id: o, type: o.startsWith('vm') ? 'VirtualMachine' : 'HostSystem' })) }))));
      return;
    }
    return json({ error_type: 'NOT_FOUND' }, 404);
  });
  return { server, state, listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as any).port))) };
}

describe('VMware vCenter connector (#20)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client;
  let db: typeof import('../../src/core/db.js');
  const vc = fakeVcenter();
  let port = 0;
  let id = 0;

  before(async () => {
    port = await vc.listen();
    process.env.KERNEL_SECRET_KEY = 'vcenter-connector-test-key-0123456789abcdef';
    process.env.KERNEL_OUTBOUND_ALLOW = '127.0.0.1';
    k = await startKernel();
    [admin, pm, analyst] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst')]);
    db = await import('../../src/core/db.js');
  });
  after(async () => {
    delete process.env.KERNEL_SECRET_KEY;
    delete process.env.KERNEL_OUTBOUND_ALLOW;
    vc.server.close();
    await k?.close();
  });

  const config = (extra: object = {}) => ({ base_url: `http://127.0.0.1:${port}`, insecure_http: true, include_datastores: true, vcenter_uuid: VC_UUID.toUpperCase(), ...extra });
  const relationship = async (from: string, type: string, to: string) =>
    (await db.query(
      `SELECT 1 FROM ci_relationships r JOIN ci_sources f ON f.ci_id = r.from_ci JOIN ci_sources t ON t.ci_id = r.to_ci
       WHERE f.source_system = 'vCenter lab' AND f.source_id = $1 AND r.type = $2 AND t.source_system = 'vCenter lab' AND t.source_id = $3`,
      [from, type, to],
    )).rows.length === 1;
  const source = async (sourceId: string) => (await analyst.get(`/api/cis/${(await db.query("SELECT c.ref FROM ci_sources s JOIN configuration_items c ON c.id = s.ci_id WHERE s.source_system = 'vCenter lab' AND s.source_id = $1", [sourceId])).rows[0].ref}`)).body;

  test('the test opens a session, counts, and closes it; a wrong password is told apart', async () => {
    const wrong = await admin.post('/api/connectors', { type: 'vcenter', name: 'vCenter wrong', source_system: 'vCenter wrong', config: config(), secret: { username: 'kernel@vsphere.local', password: 'nope' } });
    assert.equal(wrong.status, 201, JSON.stringify(wrong.body));
    assert.deepEqual((await admin.post(`/api/connectors/${wrong.body.id}/test`, {})).body, { ok: false, message: 'vCenter refused the user or password (HTTP 401)' });
    await admin.del(`/api/connectors/${wrong.body.id}`);

    const created = await admin.post('/api/connectors', { type: 'vcenter', name: 'vCenter lab', source_system: 'vCenter lab', config: config(), secret: { username: 'kernel@vsphere.local', password: 'vc-pw' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    id = created.body.id;
    assert.equal(created.body.config.vcenter_uuid, VC_UUID, 'stored in lower case');
    vc.state.forbidden.add('/api/vcenter/');
    const forbidden = (await admin.post(`/api/connectors/${id}/test`, {})).body;
    vc.state.forbidden.clear();
    assert.equal(forbidden.ok, false);
    assert.match(forbidden.message, /HTTP 403.*Read-only role/);
    assert.deepEqual((await admin.post(`/api/connectors/${id}/test`, {})).body, { ok: true, message: 'Connected: 1 datacenters, 2 hosts' });
    assert.equal(vc.state.sessions.size, 0, 'every session is deleted again, also after a refusal');
  });

  test('the setup text describes a read-only role at the root', async () => {
    const text = (await admin.get('/api/connectors/types/vcenter/setup')).body.text;
    assert.match(text, /built-in role "Read-only"/);
    assert.match(text, /Propagate to children/);
    assert.doesNotMatch(text, /Browse datastore/);
    assert.match((await admin.get('/api/connectors/types/vcenter/setup?include_datastores=true')).body.text, /Datastore → Browse datastore/);
    assert.equal((await pm.get('/api/connectors/types/vcenter/setup')).status, 403);
  });

  test('datacenters, clusters, hosts, VMs and datastores become CIs with relationships and deep links', async () => {
    // The Kubernetes connector reports a node with the VM's BIOS UUID (from providerID vsphere://…), in lower case.
    const node = (await pm.post('/api/cmdb/ci-batch', { source_system: 'Kubernetes prod', cis: [{ source_id: 'node/worker-1', name: 'worker-1', ci_type: 'virtual_machine', attributes: { bios_uuid: BIOS.toLowerCase() } }] })).body;
    assert.equal(node.cis.created, 1, JSON.stringify(node));

    const run = (await admin.post(`/api/connectors/${id}/run`, {})).body;
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    assert.equal(vc.state.sessions.size, 0, 'the run deletes its session');
    assert.equal(vc.state.requests.some((r) => r.includes('vm-50/guest')), false, 'a powered-off VM is not asked for VMware Tools');

    const web = await source('vm/vm-42');
    assert.equal(web.name, 'worker-1', 'the VM joins the Kubernetes node on its BIOS UUID');
    assert.deepEqual(web.sources.map((s: any) => s.source_system).sort(), ['Kubernetes prod', 'vCenter lab']);
    const a = web.attributes;
    assert.deepEqual(
      [a.bios_uuid, a.instance_uuid, a.os, a.ip, a.fqdn, a.cpu, a.ram_gb, a.power_state, a.host, a.cluster, a.folder, a.resource_pool],
      [BIOS.toLowerCase(), '5015aaaa-0000-1111-2222-333344445555', 'Red Hat Enterprise Linux 9 (64-bit)', '10.1.0.42', 'web01.corp.local', 4, 8, 'POWERED_ON', 'esx01.corp.local', 'Prod cluster', 'Webshop', 'Resources'],
    );
    assert.equal(web.sources.find((s: any) => s.source_system === 'vCenter lab').source_url, `http://127.0.0.1:${port}/ui/app/vm;nav=v/urn:vmomi:VirtualMachine:vm-42:${VC_UUID}/summary`);

    const db01 = await source('vm/vm-43');
    assert.deepEqual([db01.attributes.ip, db01.attributes.fqdn, db01.attributes.os], [undefined, undefined, 'WINDOWS_SERVER_2022'], 'Tools off: no IP or host name, the configured guest OS');
    assert.equal((await source('vm/vm-50')).attributes.ip, undefined, 'nor for a powered-off VM');

    const esx = await source('host/host-10');
    assert.deepEqual([esx.ci_type, esx.attributes.fqdn, esx.attributes.os, esx.attributes.connection_state, esx.attributes.cluster], ['physical_server', 'esx01.corp.local', 'VMware ESXi', 'CONNECTED', 'Prod cluster']);
    assert.deepEqual(esx.tags, ['team=payments']);
    assert.equal(esx.sources[0].source_url, `http://127.0.0.1:${port}/ui/app/host;nav=h/urn:vmomi:HostSystem:host-10:${VC_UUID}/summary`);
    assert.equal((await source('host/host-20')).attributes.ip, '10.0.0.20', 'a host added by address');
    const cluster = await source('cluster/domain-c8');
    assert.deepEqual([cluster.ci_type, cluster.attributes.ha_enabled, cluster.attributes.drs_enabled], ['cluster', 'true', 'false']);
    assert.equal((await source('datacenter/datacenter-1')).ci_type, 'datacenter');
    const ds = await source('datastore/datastore-11');
    assert.deepEqual([ds.ci_type, ds.attributes.filesystem, ds.attributes.capacity_tb, ds.attributes.free_tb], ['storage', 'VMFS', 2, 1]);

    assert.ok(await relationship('vm/vm-42', 'runs_on', 'host/host-10'));
    assert.ok(await relationship('vm/vm-50', 'runs_on', 'host/host-20'));
    assert.ok(await relationship('cluster/domain-c8', 'contains', 'host/host-10'));
    assert.ok(await relationship('datacenter/datacenter-1', 'contains', 'cluster/domain-c8'));
    assert.ok(await relationship('datacenter/datacenter-1', 'contains', 'host/host-20'), 'a standalone host is in its datacenter');
    assert.ok(await relationship('vm/vm-42', 'depends_on', 'datastore/datastore-11'), 'a VM depends on the datastore of its disks');
  });

  test('a list the user may not read leaves its CIs alone; unreadable tags stay as they were', async () => {
    vc.state.forbidden.add('/api/vcenter/vm');
    vc.state.forbidden.add('/api/cis/tagging');
    const run = (await admin.post(`/api/connectors/${id}/run`, {})).body;
    vc.state.forbidden.clear();
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    assert.equal((await db.query("SELECT max(missed_syncs)::int AS m FROM ci_sources WHERE source_system = 'vCenter lab' AND source_id LIKE 'vm/%'")).rows[0].m, 0, 'no VM counts a miss');
    assert.ok(await relationship('vm/vm-42', 'runs_on', 'host/host-10'), 'nor loses its relationship');
    assert.deepEqual((await source('host/host-10')).tags, ['team=payments'], 'tags are kept when they cannot be read');
    const last = (await admin.get(`/api/connectors/${id}/runs`)).body[0];
    assert.match(last.message, /VMs: not readable by the vCenter user/);
    assert.equal(vc.state.sessions.size, 0);
  });

  test('a VM list that comes back empty where it had VMs is incomplete; a VM that moved is followed', async () => {
    const saved = vc.state.vms;
    vc.state.vms = {};
    const run = (await admin.post(`/api/connectors/${id}/run`, {})).body;
    vc.state.vms = saved;
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    assert.equal((await db.query("SELECT max(missed_syncs)::int AS m FROM ci_sources WHERE source_system = 'vCenter lab' AND source_id LIKE 'vm/%'")).rows[0].m, 0);
    assert.match((await admin.get(`/api/connectors/${id}/runs`)).body[0].message, /vms: the list came back empty where 3 were reported before/);

    vc.state.vms['vm-43'].host = 'host-20';
    await admin.post(`/api/connectors/${id}/run`, {});
    assert.ok(await relationship('vm/vm-43', 'runs_on', 'host/host-20'), 'vMotion: the VM runs on its new host');
    assert.equal(await relationship('vm/vm-43', 'runs_on', 'host/host-10'), false, 'and no longer on the old one');
    assert.deepEqual((await source('vm/vm-42')).tags, ['team=payments'], 'a matched VM gets its tags from the next run on');
  });
});
