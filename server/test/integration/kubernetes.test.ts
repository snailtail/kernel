import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { skip, startKernel, type Client, type Harness } from './harness.js';

const TOKEN = 'k8s-test-token-0123456789abcdef';
const ENV_SECRET = 'S3cr3t-DbPassw0rd!';
const ok = (r: { status: number; body: unknown }) => assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);

/** A fake Kubernetes API server: TLS with its own CA, bearer auth, paginated lists, a forbidden and a missing kind. */
function fakeCluster(cert: string, key: string) {
  const state = { deployments: true, requests: [] as string[] };
  const deployment = (name: string) => ({
    metadata: { name, namespace: 'shop', labels: { 'app.kubernetes.io/part-of': 'webshop', team: 'payments', 'internal-note': 'not kept' }, annotations: { secret: 'never read' } },
    spec: { replicas: 3, template: { spec: { containers: [{ name: 'app', image: `registry.example.com/${name}:1.4.2`, env: [{ name: 'DB_PASSWORD', value: ENV_SECRET }], args: [`--password=${ENV_SECRET}`] }] } } },
    status: { readyReplicas: 2 },
  });
  const server: Server = createServer({ cert, key }, (req, res) => {
    const url = new URL(req.url!, 'https://x');
    state.requests.push(url.pathname + url.search);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
    const json = (v: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(v)); };
    switch (url.pathname) {
      case '/version': return json({ gitVersion: 'v1.31.2' });
      case '/api/v1/nodes': return json({ items: [
        { metadata: { name: 'aks-node-1' }, spec: { providerID: 'azure:///subscriptions/SUB-1/resourceGroups/RG/providers/Microsoft.Compute/virtualMachines/aks-node-1' }, status: { addresses: [{ type: 'InternalIP', address: '10.2.0.4' }], nodeInfo: { osImage: 'Ubuntu 22.04', kubeletVersion: 'v1.31.2' }, capacity: { cpu: '4', memory: '16Gi' } } },
        { metadata: { name: 'aks-node-2' }, spec: { providerID: 'azure:///subscriptions/SUB-1/resourceGroups/RG/providers/Microsoft.Compute/virtualMachines/aks-node-2' }, status: { nodeInfo: {}, capacity: {} } },
      ] });
      case '/api/v1/namespaces': return json({ items: [{ metadata: { name: 'shop', labels: { 'app.kubernetes.io/part-of': 'webshop' } } }, { metadata: { name: 'kube-system' } }] });
      case '/apis/apps/v1/deployments':
        if (!state.deployments) return json({ items: [] });
        // Two pages: the connector must follow `continue`.
        return url.searchParams.get('continue') === 'page2'
          ? json({ items: [deployment('checkout')], metadata: {} })
          : json({ items: [deployment('web'), deployment('cart')], metadata: { continue: 'page2' } });
      case '/apis/apps/v1/statefulsets': return json({ items: [{ metadata: { name: 'db', namespace: 'shop' }, spec: { replicas: 1, template: { spec: { containers: [{ image: 'postgres:18' }] } } }, status: { readyReplicas: 1 } }] });
      case '/apis/apps/v1/daemonsets': return json({ kind: 'Status', code: 403, message: 'forbidden' }, 403);
      case '/apis/batch/v1/cronjobs': return json({ kind: 'Status', code: 404 }, 404);
      case '/api/v1/events': return json({ items: [
        { type: 'Warning', reason: 'BackOff', message: `Back-off restarting failed container app (token=${ENV_SECRET})`, involvedObject: { kind: 'Pod', name: 'web-7d9f8c-abcde', namespace: 'shop' }, lastTimestamp: new Date().toISOString() },
        { type: 'Warning', reason: 'BackOff', message: 'again', involvedObject: { kind: 'Pod', name: 'web-7d9f8c-fghij', namespace: 'shop' }, lastTimestamp: new Date().toISOString() },
        { type: 'Warning', reason: 'Something', message: 'ignored', involvedObject: { kind: 'Pod', name: 'cart-1', namespace: 'shop' } },
      ] });
      default: return json({ kind: 'Status', code: 404 }, 404);
    }
  });
  return { server, state, listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as any).port))) };
}

describe('Kubernetes connector (#24)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client;
  let db: typeof import('../../src/db.js');
  let cluster: ReturnType<typeof fakeCluster>;
  let ca = '';
  let port = 0;
  let id = 0;
  const dir = mkdtempSync(join(tmpdir(), 'k8s-'));

  before(async () => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k'), '-out', join(dir, 'c'), '-days', '1', '-subj', '/CN=k8s', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    ca = readFileSync(join(dir, 'c'), 'utf8');
    cluster = fakeCluster(ca, readFileSync(join(dir, 'k'), 'utf8'));
    port = await cluster.listen();
    process.env.KERNEL_SECRET_KEY = 'k8s-connector-test-key-0123456789abcdef';
    process.env.KERNEL_OUTBOUND_ALLOW = '127.0.0.1';
    k = await startKernel();
    [admin, pm, analyst] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst')]);
    db = await import('../../src/db.js');
  });
  after(async () => {
    delete process.env.KERNEL_SECRET_KEY;
    delete process.env.KERNEL_OUTBOUND_ALLOW;
    cluster?.server.close();
    rmSync(dir, { recursive: true, force: true });
    await k?.close();
  });

  const config = () => ({ base_url: `https://127.0.0.1:${port}`, ca_pem: ca, cluster_name: 'aks-prod', owner_label: 'team', console_url: 'https://headlamp.example.com/c/{cluster}/{kind}/{namespace}/{name}', sync_events: true });

  test('connects over TLS with the cluster CA and a write-only token; http is refused', async () => {
    assert.equal((await admin.post('/api/connectors', { type: 'kubernetes', name: 'plain', source_system: 'plain', config: { ...config(), base_url: `http://127.0.0.1:${port}` }, secret: { token: TOKEN } })).status, 400);
    const created = await admin.post('/api/connectors', { type: 'kubernetes', name: 'AKS prod', source_system: 'aks-prod', config: config(), secret: { token: TOKEN } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    id = created.body.id;
    assert.equal(JSON.stringify(created.body).includes(TOKEN), false, 'the token is never returned');
    const t = (await admin.post(`/api/connectors/${id}/test`, {})).body;
    assert.equal(t.ok, true, t.message);
    assert.match(t.message, /v1\.31\.2/);
  });

  test('a sync maps cluster, nodes, namespaces and workloads; pods are not CIs; nothing secret is kept', async () => {
    // A VM another connector already reported: the AKS node with the same Azure resource id joins it.
    const vm = (await pm.post('/api/cmdb/ci-batch', { source_system: 'Azure', cis: [{ source_id: 'vm-1', name: 'aks-node-1', ci_type: 'virtual_machine', attributes: { resource_id: '/subscriptions/sub-1/resourcegroups/rg/providers/microsoft.compute/virtualmachines/aks-node-1' } }] }));
    ok(vm);
    const r = (await admin.post(`/api/connectors/${id}/run`, {})).body;
    assert.equal(r.status, 'succeeded', JSON.stringify(r));
    assert.equal(r.cis.matched, 1, 'the node joined the VM');
    assert.ok(cluster.state.requests.some((q) => q.includes('continue=page2')), 'pagination followed');
    const all = (await analyst.get('/api/cis?status=all&q=')).body.map((c: any) => c.name);
    for (const name of ['aks-prod', 'aks-node-2', 'aks-prod/shop', 'web', 'cart', 'checkout', 'db']) assert.ok(all.includes(name), `${name} is a CI`);
    assert.ok(!all.some((n: string) => n.startsWith('web-7d9f')), 'pods are not CIs');
    const web = (await analyst.get('/api/cis?status=all&q=web')).body.find((c: any) => c.name === 'web');
    const page = (await analyst.get(`/api/cis/${web.ref}`)).body;
    assert.equal(page.attributes.images, 'registry.example.com/web:1.4.2', 'positive control: the image is kept');
    assert.equal(page.attributes.replicas, 3);
    assert.equal(page.attributes.ready_replicas, 2);
    assert.ok(page.tags.includes('app_part_of=webshop'), JSON.stringify(page.tags));
    assert.ok(page.tags.includes('team=payments'), 'the configured owner label');
    assert.ok(!page.tags.some((t: string) => t.startsWith('internal_note')), 'other labels are not kept');
    assert.equal(page.sources[0].source_url, 'https://headlamp.example.com/c/aks-prod/deployment/shop/web');
    const leaked = await db.query('SELECT count(*)::int AS n FROM configuration_items c WHERE c::text LIKE $1', [`%${ENV_SECRET}%`]);
    assert.equal(leaked.rows[0].n, 0, 'environment variables and arguments are never stored');
    // The node that matched the Azure VM is one CI with two sources.
    const node = (await analyst.get('/api/cis?status=all&q=aks-node-1')).body[0];
    assert.deepEqual((await analyst.get(`/api/cis/${node.ref}`)).body.sources.map((s: any) => s.source_system).sort(), ['Azure', 'aks-prod']);
    // Relationships: the namespace contains the workload, the cluster the namespace.
    const rels = (await db.query("SELECT f.name AS f, r.type, t.name AS t FROM ci_relationships r JOIN configuration_items f ON f.id = r.from_ci JOIN configuration_items t ON t.id = r.to_ci WHERE r.source_system = 'aks-prod'")).rows;
    assert.ok(rels.some((x: any) => x.f === 'aks-prod/shop' && x.t === 'web' && x.type === 'contains'));
    assert.ok(rels.some((x: any) => x.f === 'aks-prod' && x.t === 'aks-prod/shop'));
  });

  test('a forbidden or unserved kind makes the run incomplete: reported, and nothing marked missing', async () => {
    const run = (await admin.get(`/api/connectors/${id}/runs`)).body[0];
    assert.match(run.message, /incomplete/);
    assert.match(run.message, /DaemonSets: forbidden/);
    assert.match(run.message, /CronJobs: not served/);
    assert.equal(Number((await db.query("SELECT coalesce(max(missed_syncs), 0)::int AS m FROM ci_sources WHERE source_system = 'aks-prod'")).rows[0].m), 0);
  });

  test('a kind that suddenly lists nothing does not mark its CIs missing', async () => {
    cluster.state.deployments = false;
    const r = (await admin.post(`/api/connectors/${id}/run`, {})).body;
    assert.equal(r.status, 'succeeded');
    const run = (await admin.get(`/api/connectors/${id}/runs`)).body[0];
    assert.match(run.message, /Deployment: the list came back empty where 3 were reported before/);
    assert.equal(Number((await db.query("SELECT coalesce(max(missed_syncs), 0)::int AS m FROM ci_sources WHERE source_system = 'aks-prod'")).rows[0].m), 0);
    cluster.state.deployments = true;
  });

  test('warning events become one alert per workload and reason, without secrets', async () => {
    const alerts = (await analyst.get('/api/alerts?status=all&q=BackOff')).body;
    const mine = alerts.filter((a: any) => a.check_key === 'Kubernetes BackOff');
    assert.equal(mine.length, 1, JSON.stringify(alerts));
    assert.equal(JSON.stringify(mine).includes(ENV_SECRET), false);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM alerts WHERE check_key = 'Kubernetes Something'")).rows[0].n, 0, 'only known reasons');
  });
});
