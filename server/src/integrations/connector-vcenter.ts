// The VMware vCenter connector (#20): one connector per vCenter Server, reading the vSphere Automation REST API
// (/api, vSphere 7.0 U2 and later) with a read-only user. It opens a session for the run and deletes it afterwards.
//
// CIs: datacenters, clusters, ESXi hosts and VMs, and datastores when the connector asks for them. Relationships: a
// datacenter contains its clusters and standalone hosts, a cluster its hosts; a VM runs on its host and depends on the
// datastores its disks live on. A VM carries its BIOS UUID, so the CMDB's reconciliation joins it to the Kubernetes
// node (providerID vsphere://<uuid>) or any other source that reports the same machine.
//
// Data minimisation: IP and host name come only from VMware Tools (nothing when Tools is not running), vSphere tags
// are kept as category=name tags, and VM notes and custom attributes are never read (the REST API does not serve
// custom attributes). What is kept goes through the sensitive-data scanner (#61).
//
// Events: the REST API does not list triggered alarms (they are only in the SOAP API), so this connector reports
// CIs only. Follow-up: #258.
import { z } from 'zod';
import type { ConnectorType, RunContext } from './connectors.js';
import { query } from '../core/db.js';
import { redact } from '../security/scanner.js';

const SESSION_HEADER = 'vmware-api-session-id';
/** Requests in flight at once for per-object calls (VM details, VMware Tools), so a large estate fits in a run. */
const PARALLEL = 8;

interface Session {
  get: (path: string) => Promise<any>;
  post: (path: string, body: unknown) => Promise<any>;
}

const statusOf = (err: unknown) => (err as { status?: number }).status;

/** Opens a session with the user and password, runs `work`, and always deletes the session again. */
async function withSession<T>(ctx: RunContext, work: (s: Session) => Promise<T>): Promise<T> {
  const base = ctx.config.base_url.replace(/\/$/, '');
  const basic = `Basic ${Buffer.from(`${ctx.secret.username}:${ctx.secret.password}`).toString('base64')}`;
  const login = await ctx.request(`${base}/api/session`, { method: 'POST', headers: { Accept: 'application/json', Authorization: basic } });
  if (login.status === 401) throw Object.assign(new Error('vCenter refused the user or password (HTTP 401)'), { status: 401 });
  if (!login.ok) throw Object.assign(new Error(`vCenter did not open a session (HTTP ${login.status})`), { status: login.status });
  const token = JSON.parse(login.body);
  if (typeof token !== 'string' || !token) throw new Error('vCenter did not answer with a session id');
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await ctx.request(base + path, {
      method,
      headers: { Accept: 'application/json', [SESSION_HEADER]: token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw Object.assign(new Error(`${path.split('?')[0]}: HTTP ${res.status}`), { status: res.status });
    try {
      return JSON.parse(res.body);
    } catch {
      throw new Error(`${path.split('?')[0]}: the response is not JSON`);
    }
  };
  try {
    return await work({ get: (path) => call('GET', path), post: (path, body) => call('POST', path, body) });
  } finally {
    // A session left open counts against vCenter's session limit until it times out; a failed delete is not the run's problem.
    await ctx.request(`${base}/api/session`, { method: 'DELETE', headers: { [SESSION_HEADER]: token } }).catch(() => undefined);
  }
}

/** fn over items, at most `limit` at a time, in order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const clean = (v: unknown, max = 200) => redact(String(v ?? '')).text.slice(0, max);
const tag = (category: string, name: string) => `${clean(category, 50).toLowerCase().replace(/[^a-z0-9_]/g, '_')}=${clean(name, 50)}`.slice(0, 50);
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
/** The datastore a disk lives on, from its backing file: "[datastore1] web01/web01.vmdk". */
const datastoreOf = (file: unknown) => /^\[([^\]]+)\]/.exec(String(file ?? ''))?.[1];

/**
 * The vSphere Client's deep link to an object: /ui/app/<view>;nav=<tree>/urn:vmomi:<ManagedType>:<moid>:<vCenter
 * instance UUID>/summary, e.g. /ui/app/vm;nav=v/urn:vmomi:VirtualMachine:vm-42:5f1c…/summary. The UUID is the vCenter
 * Server's own, which the REST API does not serve; without it the link opens the vSphere Client.
 */
function clientLink(base: string, vcenterUuid: string | undefined, kind: 'datacenter' | 'cluster' | 'host' | 'vm' | 'datastore', moid: string) {
  if (!vcenterUuid) return `${base}/ui/`;
  const [view, nav, type] = {
    datacenter: ['datacenter', 'h', 'Datacenter'],
    cluster: ['cluster', 'h', 'ClusterComputeResource'],
    host: ['host', 'h', 'HostSystem'],
    vm: ['vm', 'v', 'VirtualMachine'],
    datastore: ['datastore', 's', 'Datastore'],
  }[kind];
  return `${base}/ui/app/${view};nav=${nav}/urn:vmomi:${type}:${encodeURIComponent(moid)}:${vcenterUuid}/summary`;
}

/**
 * The read-only vCenter user. The built-in Read-only role holds System.Anonymous, System.Read and System.View, which
 * is everything the inventory and tag lists need; datastores need Datastore.Browse on top.
 */
function vcenterSetup(config: { include_datastores?: unknown }): string {
  const datastores = config.include_datastores === true || config.include_datastores === 'true';
  return `Kernel: a read-only vCenter user

1. vSphere Client → Administration → Single Sign On → Users and Groups: add a user "kernel" in vsphere.local (or use
   a directory account) with a long random password.
2. Administration → Access Control → Roles: ${datastores
    ? 'clone the role "Read-only" as "Kernel reader" and add only the privilege Datastore → Browse datastore.'
    : 'use the built-in role "Read-only" (System.Anonymous, System.Read, System.View).'}
   Kernel only reads: no power, snapshot, configuration or alarm privileges.
3. Inventory: select the vCenter Server itself (the root), Permissions → Add: the user "kernel", the role
   "${datastores ? 'Kernel reader' : 'Read-only'}", and tick "Propagate to children".
4. Here: the vCenter URL (https://vcenter.example.com), the user and the password. Add the vCenter's address under
   private network access if it is on your LAN, and its CA certificate (vSphere Client → Download trusted root CA
   certificates) if it uses the VMCA or your own CA.
5. Optional, for links straight to each object: the vCenter's instance UUID, the part after the last colon in the
   address bar when the vCenter itself is selected (…/urn:vmomi:Folder:group-d1:<UUID>/summary).
6. Test: Kernel opens a session, counts the datacenters and hosts, and closes it again.
`;
}

export const VCENTER: ConnectorType = {
  label: 'VMware vCenter',
  config: z.object({
    base_url: z.string().url().refine((u) => /^https?:\/\//.test(u), 'http(s) only'),
    /** Plain HTTP sends the credentials in clear text: only for a lab, and only when explicitly chosen. */
    insecure_http: z.boolean().default(false),
    /** A CA certificate (PEM) to trust for this connector only, e.g. the VMCA root. */
    ca_pem: z.string().max(20_000).regex(/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/, 'Paste a PEM certificate').optional().or(z.literal('')),
    environment: z.enum(['prod', 'test', 'dev', 'other']).default('prod'),
    /** Datastores become storage CIs that VMs depend on. */
    include_datastores: z.boolean().default(false),
    /** vSphere tags become category=name tags on their objects. */
    tags: z.boolean().default(true),
    /** The vCenter Server's instance UUID, for deep links into the vSphere Client. */
    vcenter_uuid: z.string().regex(/^[0-9a-f-]{36}$/i, 'A UUID, e.g. 5f1c2d3e-…').transform((s) => s.toLowerCase()).optional().or(z.literal('')),
  }),
  secret: z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(500) }),

  test: (ctx) =>
    withSession(ctx, async (s) => {
      try {
        const [datacenters, hosts] = await Promise.all([s.get('/api/vcenter/datacenter'), s.get('/api/vcenter/host')]);
        return `Connected: ${datacenters.length} datacenters, ${hosts.length} hosts`;
      } catch (err) {
        if (statusOf(err) === 403) throw new Error('vCenter accepted the user, but it may not read the inventory (HTTP 403): give it the Read-only role at the vCenter root, propagated (see the setup text)');
        throw err;
      }
    }),

  setup: vcenterSetup,

  fetch: (ctx) =>
    withSession(ctx, async (s) => {
      const cfg = ctx.config;
      const base = cfg.base_url.replace(/\/$/, '');
      const link = (kind: Parameters<typeof clientLink>[2], moid: string) => clientLink(base, cfg.vcenter_uuid || undefined, kind, moid);
      const cis: Awaited<ReturnType<NonNullable<ConnectorType['fetch']>>>['cis'] = [];
      const relationships: { from_id: string; type: string; to_id: string }[] = [];
      const partial: { message: string; prefix?: string }[] = [];
      const warnings: string[] = [];
      const skip = (what: string, prefixes: string[]) => {
        for (const prefix of prefixes) if (!partial.some((p) => p.prefix === prefix)) partial.push({ message: `${what}: not readable by the vCenter user`, prefix });
      };
      /** A list, or null (and the given prefixes left alone) when the user may not read it. */
      const list = async (path: string, what: string, prefixes: string[]): Promise<any[] | null> => {
        try {
          const rows = await s.get(path);
          if (!Array.isArray(rows)) throw new Error(`${what}: vCenter did not answer with a list`);
          return rows;
        } catch (err) {
          if (statusOf(err) === 401 || statusOf(err) === 403) { skip(what, prefixes); return null; }
          throw err;
        }
      };
      const q = (key: string, id: string) => `${key}=${encodeURIComponent(id)}`;

      // Datacenters are the root of the snapshot: when they cannot be read the run fails and nothing is marked missing.
      const datacenters: any[] = await s.get('/api/vcenter/datacenter');
      // cluster is null when the datacenter's clusters could not be read: then a host's place is unknown, not standalone.
      const hostInfo = new Map<string, { name: string; datacenter: string; cluster: string | null | undefined; summary?: any }>();
      const clusterName = new Map<string, string>();
      for (const dc of datacenters) {
        const dcId = `datacenter/${dc.datacenter}`;
        cis.push({ source_id: dcId, source_url: link('datacenter', dc.datacenter), name: clean(dc.name), ci_type: 'datacenter', environment: cfg.environment, attributes: { platform: 'VMware vSphere' } });
        const clusters = await list(`/api/vcenter/cluster?${q('datacenters', dc.datacenter)}`, 'clusters', ['cluster/', 'host/', 'vm/']);
        let placed = !!clusters;
        for (const c of clusters ?? []) {
          clusterName.set(c.cluster, String(c.name));
          cis.push({
            source_id: `cluster/${c.cluster}`, source_url: link('cluster', c.cluster), name: clean(c.name), ci_type: 'cluster', environment: cfg.environment,
            attributes: { platform: 'VMware vSphere', ha_enabled: c.ha_enabled === undefined ? '' : String(c.ha_enabled), drs_enabled: c.drs_enabled === undefined ? '' : String(c.drs_enabled) },
          });
          relationships.push({ from_id: dcId, type: 'contains', to_id: `cluster/${c.cluster}` });
          const members = await list(`/api/vcenter/host?${q('clusters', c.cluster)}`, 'hosts', ['host/', 'vm/']);
          if (!members) placed = false;
          for (const h of members ?? []) hostInfo.set(h.host, { name: String(h.name), datacenter: dc.datacenter, cluster: c.cluster });
        }
        // Standalone hosts: those in the datacenter that no cluster listed, when every cluster could be listed.
        for (const h of (await list(`/api/vcenter/host?${q('datacenters', dc.datacenter)}`, 'hosts', ['host/', 'vm/'])) ?? []) {
          const known = hostInfo.get(h.host);
          if (known) known.summary = h;
          else hostInfo.set(h.host, { name: String(h.name), datacenter: dc.datacenter, cluster: placed ? undefined : null, summary: h });
        }
      }

      for (const [moid, h] of hostInfo) {
        const summary = h.summary ?? {};
        const name = h.name;
        cis.push({
          source_id: `host/${moid}`, source_url: link('host', moid), name: clean(name), ci_type: 'physical_server', environment: cfg.environment,
          attributes: {
            ...(IPV4.test(name) ? { ip: name } : name.includes('.') ? { fqdn: clean(name) } : {}),
            os: 'VMware ESXi', connection_state: clean(summary.connection_state, 50), power_state: clean(summary.power_state, 50),
            ...(h.cluster === null ? {} : { cluster: h.cluster ? clean(clusterName.get(h.cluster)) : '' }),
          },
        });
        if (h.cluster !== null) relationships.push({ from_id: h.cluster ? `cluster/${h.cluster}` : `datacenter/${h.datacenter}`, type: 'contains', to_id: `host/${moid}` });
      }

      const datastores = new Map<string, string>(); // "<datacenter>/<name>" → datastore moid
      if (cfg.include_datastores) {
        for (const dc of datacenters) {
          for (const d of (await list(`/api/vcenter/datastore?${q('datacenters', dc.datacenter)}`, 'datastores', ['datastore/'])) ?? []) {
            datastores.set(`${dc.datacenter}/${d.name}`, d.datastore);
            const tb = (bytes: unknown) => (typeof bytes === 'number' ? Math.round((bytes / 1024 ** 4) * 100) / 100 : null);
            cis.push({
              source_id: `datastore/${d.datastore}`, source_url: link('datastore', d.datastore), name: clean(d.name), ci_type: 'storage', environment: cfg.environment,
              attributes: { vendor: 'VMware', filesystem: clean(d.type, 50), capacity_tb: tb(d.capacity), free_tb: tb(d.free_space) },
            });
          }
        }
      }

      // VMs are listed per host: that is the runs_on relationship, and it stays under vCenter's 4000-row list limit.
      const vms: { moid: string; host: string }[] = [];
      for (const [moid] of hostInfo) {
        for (const v of (await list(`/api/vcenter/vm?${q('hosts', moid)}`, 'VMs', ['vm/'])) ?? []) vms.push({ moid: v.vm, host: moid });
      }

      // Folders and resource pools by name, from the VMs each one lists; a list the user may not read leaves the
      // attribute as it was.
      const membership = async (path: string, idKey: string, filter: string, what: string) => {
        const groups = await list(path, what, []);
        const members = groups && (await mapLimit(groups, PARALLEL, (g) => list(`/api/vcenter/vm?${q(filter, g[idKey])}`, what, [])));
        if (!groups || !members || members.includes(null)) {
          warnings.push(`${what}: not readable by the vCenter user, left as they were`);
          return null;
        }
        const names = new Map<string, string>();
        groups.forEach((g, i) => { for (const v of members[i]!) names.set(v.vm, String(g.name)); });
        return names;
      };
      const folders = await membership('/api/vcenter/folder?type=VIRTUAL_MACHINE', 'folder', 'folders', 'VM folders');
      const pools = await membership('/api/vcenter/resource-pool', 'resource_pool', 'resource_pools', 'resource pools');

      await mapLimit(vms, PARALLEL, async ({ moid, host }) => {
        let vm: any;
        try {
          vm = await s.get(`/api/vcenter/vm/${encodeURIComponent(moid)}`);
        } catch (err) {
          // Gone between the list and now (deleted or migrated away): the next run sees it where it is.
          if (statusOf(err) === 404) return;
          if (statusOf(err) === 403) { skip('VMs', ['vm/']); return; }
          throw err;
        }
        // VMware Tools answers only while it runs in the guest (503 otherwise); then IP and host name stay unknown.
        let guest: any = null;
        if (vm.power_state === 'POWERED_ON') guest = await s.get(`/api/vcenter/vm/${encodeURIComponent(moid)}/guest/identity`).catch(() => null);
        const h = hostInfo.get(host)!;
        const hostName = guest?.host_name ? String(guest.host_name) : '';
        const id = `vm/${moid}`;
        cis.push({
          source_id: id, source_url: link('vm', moid), name: clean(vm.name ?? vm.identity?.name ?? moid), ci_type: 'virtual_machine', environment: cfg.environment,
          attributes: {
            ...(vm.identity?.bios_uuid ? { bios_uuid: String(vm.identity.bios_uuid).toLowerCase() } : {}),
            instance_uuid: clean(vm.identity?.instance_uuid ?? '', 50).toLowerCase(),
            os: clean(guest?.full_name?.default_message ?? guest?.full_name ?? vm.guest_OS ?? ''),
            ...(guest?.ip_address ? { ip: clean(guest.ip_address, 50) } : {}),
            ...(hostName.includes('.') ? { fqdn: clean(hostName) } : {}),
            cpu: vm.cpu?.count ?? null, ram_gb: typeof vm.memory?.size_MiB === 'number' ? Math.round((vm.memory.size_MiB / 1024) * 10) / 10 : null,
            power_state: clean(vm.power_state, 50), host: clean(h.name),
            ...(h.cluster === null ? {} : { cluster: h.cluster ? clean(clusterName.get(h.cluster)) : '' }),
            ...(folders ? { folder: clean(folders.get(moid) ?? '') } : {}),
            ...(pools ? { resource_pool: clean(pools.get(moid) ?? '') } : {}),
          },
        });
        relationships.push({ from_id: id, type: 'runs_on', to_id: `host/${host}` });
        if (cfg.include_datastores) {
          const used = new Set(Object.values(vm.disks ?? {}).map((d: any) => datastores.get(`${h.datacenter}/${datastoreOf(d?.backing?.vmdk_file)}`)).filter(Boolean));
          for (const ds of used) relationships.push({ from_id: id, type: 'depends_on', to_id: `datastore/${ds}` });
        }
      });

      if (cfg.tags) {
        const tags = await objectTags(s);
        if (!tags) warnings.push('tags: not readable by the vCenter user, left as they were');
        else for (const ci of cis) ci.tags = (tags.get(ci.source_id.split('/')[1]) ?? []).slice(0, 30);
      }

      // A list that suddenly comes back empty, where it had rows before, is more likely a permission or API problem
      // than an estate that lost all its VMs: incomplete rather than a reason to mark them missing.
      for (const prefix of ['datacenter/', 'cluster/', 'host/', 'vm/', ...(cfg.include_datastores ? ['datastore/'] : [])]) {
        if (cis.some((c) => c.source_id.startsWith(prefix)) || partial.some((p) => p.prefix === prefix)) continue;
        const { rows } = await query('SELECT count(*)::int AS n FROM ci_sources WHERE source_system = $1 AND source_id LIKE $2 AND missed_syncs = 0', [ctx.sourceSystem, `${prefix}%`]);
        if (rows[0].n > 0) partial.push({ message: `${prefix.slice(0, -1)}s: the list came back empty where ${rows[0].n} were reported before`, prefix });
      }

      return { cis, relationships, partial, warnings };
    }),
};

/** vSphere tags per object moid, as category=name; null when the user may not read tags. */
async function objectTags(s: Session): Promise<Map<string, string[]> | null> {
  try {
    const ids: string[] = await s.get('/api/cis/tagging/tag');
    const categories = new Map<string, string>();
    const named = await mapLimit(ids, PARALLEL, async (id) => {
      const t = await s.get(`/api/cis/tagging/tag/${encodeURIComponent(id)}`);
      if (!categories.has(t.category_id)) categories.set(t.category_id, '');
      return { id, name: String(t.name), category: String(t.category_id) };
    });
    await mapLimit([...categories.keys()], PARALLEL, async (id) => categories.set(id, String((await s.get(`/api/cis/tagging/category/${encodeURIComponent(id)}`)).name)));
    const label = new Map(named.map((t) => [t.id, tag(categories.get(t.category) ?? 'tag', t.name)]));
    const out = new Map<string, string[]>();
    for (let i = 0; i < ids.length; i += 100) {
      const attached: any[] = await s.post('/api/cis/tagging/tag-association?action=list-attached-objects-on-tags', { tag_ids: ids.slice(i, i + 100) });
      for (const a of attached) {
        for (const o of a.object_ids ?? []) {
          const list = out.get(o.id) ?? [];
          list.push(label.get(a.tag_id)!);
          out.set(o.id, list);
        }
      }
    }
    return out;
  } catch (err) {
    if (statusOf(err) === 401 || statusOf(err) === 403) return null;
    throw err;
  }
}
