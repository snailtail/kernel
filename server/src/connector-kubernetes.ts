// The Kubernetes connector (#24): one connector per cluster, reading the API with a read-only ServiceAccount.
//
// CIs: the cluster, its nodes, namespaces and workloads (Deployment, StatefulSet, DaemonSet, CronJob). Pods are not
// CIs – they come and go in minutes – but each workload carries its desired and ready replicas. Relationships: the
// cluster contains its namespaces and nodes, a namespace contains its workloads. A node carries its cloud resource id
// or VMware BIOS UUID from providerID, so the CMDB's reconciliation joins it to the VM another connector reports.
//
// Data minimisation: only a short allowlist of labels and the container image names are kept. Environment variables,
// arguments, annotations, Secrets and ConfigMaps are never read into Kernel – they often hold credentials – and what is
// kept still goes through the sensitive-data scanner (#61).
//
// The API is plain JSON over HTTPS, so it goes through outboundFetch like every connector: the cluster's own CA,
// private address allow-lists, timeouts, size limits and no redirects with credentials.
import { z } from 'zod';
import type { ConnectorType, RunContext } from './connectors.js';
import { query } from './db.js';
import type { NormalisedEvent } from './events.js';
import { redact } from './sensitive.js';

const PAGE = 500;

/** Every item of a list, following `continue` tokens. */
async function listAll(ctx: RunContext, path: string): Promise<any[]> {
  const items: any[] = [];
  let next = '';
  for (let page = 0; page < 200; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await ctx.fetchJson(`${path}${sep}limit=${PAGE}${next ? `&continue=${encodeURIComponent(next)}` : ''}`);
    items.push(...(res.items ?? []));
    next = res.metadata?.continue ?? '';
    if (!next) return items;
  }
  throw new Error(`${path}: more than ${200 * PAGE} items`);
}

/** Lists a kind, or says why it could not (RBAC 403 or 404 for an API the cluster does not serve). */
async function listKind(ctx: RunContext, path: string): Promise<{ items: any[] } | { skipped: string }> {
  try {
    return { items: await listAll(ctx, path) };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 403) return { skipped: 'forbidden by the ServiceAccount\'s role' };
    if (status === 404) return { skipped: 'not served by this cluster' };
    throw err;
  }
}

/** providerID → the attribute the CMDB matches VMs on (resource_id or bios_uuid). */
export function identityFromProviderId(providerId: string | undefined): Record<string, string> {
  if (!providerId) return {};
  const azure = /^azure:\/\/(\/subscriptions\/.+)$/i.exec(providerId);
  if (azure) return { resource_id: azure[1].toLowerCase() };
  const aws = /^aws:\/\/\/[^/]*\/(i-[0-9a-f]+)$/i.exec(providerId);
  if (aws) return { resource_id: aws[1] };
  const gce = /^gce:\/\/([^/]+)\/([^/]+)\/([^/]+)$/i.exec(providerId);
  if (gce) return { resource_id: `projects/${gce[1]}/zones/${gce[2]}/instances/${gce[3]}` };
  const vsphere = /^vsphere:\/\/([0-9a-f-]{36})$/i.exec(providerId);
  if (vsphere) return { bios_uuid: vsphere[1].toLowerCase() };
  return {};
}

const clean = (v: unknown, max = 200) => redact(String(v ?? '')).text.slice(0, max);
const gib = (q: string | undefined) => {
  const m = /^(\d+)(Ki|Mi|Gi)?$/.exec(q ?? '');
  if (!m) return undefined;
  const n = Number(m[1]) / ({ Ki: 1024 ** 2, Mi: 1024, Gi: 1 } as Record<string, number>)[m[2] ?? 'Gi'];
  return Math.round(n * 10) / 10;
};

/**
 * The workload a pod belongs to, from the pod's name: <deployment>-<pod-template-hash>-<5>, <statefulset>-<n>,
 * <daemonset>-<5>, <cronjob>-<schedule minute>-<5>. A name that has a workload's name as prefix but not its form
 * (a standalone Job "web-migrate-x7k2p" next to Deployment "web") belongs to none: better no alert than a wrong one.
 */
export function podOwner(workloads: { id: string; kind: string; namespace: string; name: string }[], namespace: string, pod: string): string | undefined {
  // Generated parts use Kubernetes' alphabet without vowels, 0, 1 and 3 (rand.String, the pod-template-hash), so
  // "migrate" is not one.
  const suffix: Record<string, RegExp> = {
    Deployment: /^[bcdfghjklmnpqrstvwxz24-9]{6,10}-[bcdfghjklmnpqrstvwxz24-9]{5}$/,
    StatefulSet: /^\d+$/,
    DaemonSet: /^[bcdfghjklmnpqrstvwxz24-9]{5}$/,
    CronJob: /^\d{8,10}-[bcdfghjklmnpqrstvwxz24-9]{5}$/,
  };
  return workloads
    .filter((w) => w.namespace === namespace && pod.startsWith(`${w.name}-`) && suffix[w.kind]?.test(pod.slice(w.name.length + 1)))
    .sort((a, b) => b.name.length - a.name.length)[0]?.id;
}

const WORKLOADS = [
  { kind: 'Deployment', path: '/apis/apps/v1/deployments' },
  { kind: 'StatefulSet', path: '/apis/apps/v1/statefulsets' },
  { kind: 'DaemonSet', path: '/apis/apps/v1/daemonsets' },
  { kind: 'CronJob', path: '/apis/batch/v1/cronjobs' },
] as const;

/** Exactly what the connector reads: the manifest grants this and the connection test checks it. */
export const ACCESS = [
  { group: '', resource: 'nodes' },
  { group: '', resource: 'namespaces' },
  { group: 'apps', resource: 'deployments' },
  { group: 'apps', resource: 'statefulsets' },
  { group: 'apps', resource: 'daemonsets' },
  { group: 'batch', resource: 'cronjobs' },
  { group: '', resource: 'events', onlyWithEvents: true },
] as const;

/** What a read-only role must not reach; the connection test warns when the token can. */
const TOO_MUCH = [
  { group: '', resource: 'secrets' },
  { group: '', resource: 'configmaps' },
  // Pod specs carry environment literals, often credentials.
  { group: '', resource: 'pods' },
  { group: '', resource: 'pods/exec', verb: 'create' },
  // The kubelet API through the API server: in practice exec on every node.
  { group: '', resource: 'nodes/proxy', verb: 'get' },
] as const;

/**
 * A least-privilege manifest: a ServiceAccount with list on exactly what is read, and a token Secret. No get, watch,
 * no pods, no Secrets or ConfigMaps.
 */
export function rbacManifest(config: { cluster_name?: unknown; sync_events?: unknown }): string {
  const cluster = String(config.cluster_name ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 100) || 'your cluster';
  const events = config.sync_events === true || config.sync_events === 'true';
  const rules = Object.entries(
    ACCESS.filter((a) => !('onlyWithEvents' in a) || events).reduce<Record<string, string[]>>((by, a) => ({ ...by, [a.group]: [...(by[a.group] ?? []), a.resource] }), {}),
  ).map(([group, resources]) => `  - apiGroups: [${JSON.stringify(group)}]\n    resources: [${resources.map((r) => JSON.stringify(r)).join(', ')}]\n    verbs: ["list"]`);
  return `# Kernel: read-only access to ${cluster}. Apply with: kubectl apply -f kernel-reader.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: kernel
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kernel-reader
  namespace: kernel
automountServiceAccountToken: false
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kernel-reader
rules:
${rules.join('\n')}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kernel-reader
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: kernel-reader
subjects:
  - kind: ServiceAccount
    name: kernel-reader
    namespace: kernel
---
# The token Kernel uses: kubectl -n kernel get secret kernel-reader-token -o jsonpath='{.data.token}' | base64 -d
apiVersion: v1
kind: Secret
metadata:
  name: kernel-reader-token
  namespace: kernel
  annotations:
    kubernetes.io/service-account.name: kernel-reader
type: kubernetes.io/service-account-token
`;
}

/** May this token do verb on resource? A SelfSubjectAccessReview, which every authenticated account may ask. */
async function canI(ctx: RunContext, a: { group: string; resource: string; verb?: string }): Promise<boolean> {
  const [resource, subresource] = a.resource.split('/');
  const review = await ctx.postJson('/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
    apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectAccessReview',
    spec: { resourceAttributes: { group: a.group, resource, ...(subresource ? { subresource } : {}), verb: a.verb ?? 'list' } },
  });
  return review.status?.allowed === true;
}

/** Warning reasons worth an alert, and how loud. */
const REASONS: Record<string, NormalisedEvent['severity']> = { BackOff: 'major', OOMKilling: 'major', OOMKilled: 'major', FailedScheduling: 'minor', FailedMount: 'minor', Unhealthy: 'warning' };

export const KUBERNETES: ConnectorType = {
  label: 'Kubernetes cluster',
  config: z.object({
    /** The API server, e.g. https://k8s.example.com:6443. */
    base_url: z.string().url().refine((u) => u.startsWith('https://'), 'The API server must be https'),
    /** The cluster's CA certificate (PEM): most API servers use their own CA. */
    ca_pem: z.string().max(20_000).regex(/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/, 'Paste a PEM certificate').optional().or(z.literal('')),
    cluster_name: z.string().trim().min(1).max(100),
    environment: z.enum(['prod', 'test', 'dev', 'other']).default('prod'),
    /** The CI type for nodes that no other connector already knows. */
    node_ci_type: z.string().max(50).default('virtual_machine'),
    /** A label naming the owning team or service, kept alongside the app.kubernetes.io/* labels. */
    owner_label: z.string().max(100).regex(/^[A-Za-z0-9./_-]*$/).default(''),
    /**
     * A link to the object in a dashboard (Rancher, Headlamp, Lens, a cloud console), with {cluster}, {kind},
     * {namespace} and {name}; empty for none.
     */
    console_url: z.string().max(500).refine((u) => !u || /^https?:\/\//.test(u), 'http(s) only').default(''),
    /** Warning events (crash loops, out of memory, scheduling failures) become alerts on their workload. */
    sync_events: z.boolean().default(false),
    /** Namespaces left out entirely (no CI, no workloads, no alerts): the cluster's own plumbing by default. */
    exclude_namespaces: z.array(z.string().regex(/^[a-z0-9-]{1,63}$/, 'A namespace name')).max(100).default(['kube-system', 'kube-public', 'kube-node-lease']),
  }),
  secret: z.object({ token: z.string().min(20).max(10_000) }),

  // Version and node count, then per kind whether the token may list it, so a missing permission shows up here and
  // not as an incomplete first run; and a warning when the token can read more than it should.
  test: async (ctx) => {
    const v = await ctx.fetchJson('/version');
    // The node count, when the token may list nodes (the per-kind check below says if not).
    const nodes = await ctx.fetchJson('/api/v1/nodes?limit=1').catch(() => undefined);
    const count = nodes?.metadata?.remainingItemCount !== undefined ? `, ${nodes.metadata.remainingItemCount + (nodes.items?.length ?? 0)} nodes` : nodes?.items && !nodes.metadata?.continue ? `, ${nodes.items.length} node${nodes.items.length === 1 ? '' : 's'}` : '';
    const wanted = ACCESS.filter((a) => !('onlyWithEvents' in a) || ctx.config.sync_events);
    let readable: string[] = [], forbidden: string[] = [];
    try {
      const allowed = await Promise.all(wanted.map((a) => canI(ctx, a)));
      readable = wanted.filter((_, i) => allowed[i]).map((a) => a.resource);
      forbidden = wanted.filter((_, i) => !allowed[i]).map((a) => a.resource);
    } catch {
      // A cluster without the access-review API: try one item of each kind instead (never Secrets).
      const paths: Record<string, string> = { nodes: '/api/v1/nodes', namespaces: '/api/v1/namespaces', events: '/api/v1/events', cronjobs: '/apis/batch/v1/cronjobs' };
      for (const a of wanted) {
        const r = await listKind(ctx, `${paths[a.resource] ?? `/apis/apps/v1/${a.resource}`}?limit=1`);
        ('items' in r ? readable : forbidden).push(a.resource);
      }
    }
    // More than it needs: everything (cluster-admin or a wildcard role), or the specific dangerous rights.
    let tooMuch: string[] = [];
    try {
      if (await canI(ctx, { group: '*', resource: '*', verb: '*' })) tooMuch = ['do everything (cluster-admin)'];
      else {
        const extra = await Promise.all(TOO_MUCH.map((a) => canI(ctx, a)));
        tooMuch = TOO_MUCH.filter((_, i) => extra[i]).map((a) => `${'verb' in a ? a.verb : 'list'} ${a.resource}`);
      }
    } catch {
      // Without the access-review API this cannot be checked; the per-kind result above still stands.
    }
    return [
      `Connected to Kubernetes ${v.gitVersion ?? '?'}${count}.`,
      forbidden.length ? `Readable: ${readable.join(', ') || 'nothing'}. Not readable: ${forbidden.join(', ')} – runs skip these until the role allows list (see the manifest).` : `Every kind the connector reads is readable (${readable.join(', ')}).`,
      ...(tooMuch.length ? [`Warning: this token can also ${tooMuch.join(', ')}. Kernel never uses that; bind it to the read-only role instead.`] : []),
    ].join(' ');
  },

  setup: rbacManifest,

  fetch: async (ctx) => {
    const cfg = ctx.config;
    const link = (kind: string, namespace: string, name: string) =>
      cfg.console_url ? cfg.console_url.replaceAll('{cluster}', encodeURIComponent(cfg.cluster_name)).replaceAll('{kind}', kind.toLowerCase()).replaceAll('{namespace}', encodeURIComponent(namespace)).replaceAll('{name}', encodeURIComponent(name)) : '';
    // Allowlisted labels become tags ("app_part_of=webshop", "team=payments"); every other label is left behind.
    const keep = (labels: Record<string, string> | undefined) =>
      Object.entries(labels ?? {})
        .filter(([k]) => k.startsWith('app.kubernetes.io/') || (cfg.owner_label && k === cfg.owner_label))
        .map(([k, v]) => `${k.replace('app.kubernetes.io/', 'app_').replace(/[^a-z0-9_]/gi, '_').toLowerCase()}=${clean(v, 100)}`.slice(0, 50))
        .slice(0, 30);
    const version = await ctx.fetchJson('/version');
    const cis: Awaited<ReturnType<NonNullable<ConnectorType['fetch']>>>['cis'] = [];
    const relationships: { from_id: string; type: string; to_id: string }[] = [];
    const partial: { message: string; prefix?: string }[] = [];
    const warnings: string[] = [];
    const excluded = new Set<string>(cfg.exclude_namespaces);
    cis.push({ source_id: 'cluster', name: cfg.cluster_name, ci_type: 'cluster', environment: cfg.environment, source_url: link('cluster', '', cfg.cluster_name), attributes: { platform: 'Kubernetes', version: clean(version.gitVersion, 50) } });

    const counts: Record<string, number> = {};
    const nodes = await listKind(ctx, '/api/v1/nodes');
    if ('skipped' in nodes) partial.push({ message: `nodes: ${nodes.skipped}`, prefix: 'node/' });
    else {
      counts.node = nodes.items.length;
      for (const n of nodes.items) {
        const name = String(n.metadata?.name);
        const ip = (n.status?.addresses ?? []).find((a: any) => a.type === 'InternalIP')?.address;
        cis.push({
          source_id: `node/${name}`, name: clean(name), ci_type: cfg.node_ci_type, environment: cfg.environment, source_url: link('node', '', name),
          attributes: {
            ...identityFromProviderId(n.spec?.providerID),
            os: clean(n.status?.nodeInfo?.osImage, 100),
            kubelet_version: clean(n.status?.nodeInfo?.kubeletVersion, 50),
            ...(ip ? { ip: clean(ip, 50) } : {}),
            ...(n.status?.capacity?.cpu ? { cpu: Number(n.status.capacity.cpu) || undefined } : {}),
            ...(gib(n.status?.capacity?.memory) ? { ram_gb: gib(n.status?.capacity?.memory) } : {}),
          },
        });
        relationships.push({ from_id: 'cluster', type: 'contains', to_id: `node/${name}` });
      }
    }

    const namespaces = await listKind(ctx, '/api/v1/namespaces');
    if ('skipped' in namespaces) partial.push({ message: `namespaces: ${namespaces.skipped}`, prefix: 'ns/' });
    else {
      counts.namespace = namespaces.items.length;
      for (const ns of namespaces.items) {
        const name = String(ns.metadata?.name);
        if (excluded.has(name)) continue;
        cis.push({ source_id: `ns/${name}`, name: `${cfg.cluster_name}/${clean(name)}`.slice(0, 200), ci_type: 'kubernetes_namespace', environment: cfg.environment, source_url: link('namespace', '', name), tags: keep(ns.metadata?.labels), attributes: {} });
        relationships.push({ from_id: 'cluster', type: 'contains', to_id: `ns/${name}` });
      }
    }

    const workloadIds: { id: string; kind: string; namespace: string; name: string }[] = [];
    for (const w of WORKLOADS) {
      const list = await listKind(ctx, w.path);
      if ('skipped' in list) { partial.push({ message: `${w.kind}s: ${list.skipped}`, prefix: `${w.kind}/` }); continue; }
      // Counted before the exclusions: the check below is about the API returning nothing, not about our filter.
      counts[w.kind] = list.items.length;
      for (const o of list.items) {
        const namespace = String(o.metadata?.namespace);
        const name = String(o.metadata?.name);
        if (excluded.has(namespace)) continue;
        const id = `${w.kind}/${namespace}/${name}`;
        const pod = w.kind === 'CronJob' ? o.spec?.jobTemplate?.spec?.template?.spec : o.spec?.template?.spec;
        // Image names and tags only: never env, args or command, which often carry credentials.
        const images = [...new Set((pod?.containers ?? []).map((c: any) => clean(c.image, 300)))].join(', ');
        const desired = w.kind === 'DaemonSet' ? o.status?.desiredNumberScheduled : w.kind === 'CronJob' ? undefined : o.spec?.replicas;
        const ready = w.kind === 'DaemonSet' ? o.status?.numberReady : w.kind === 'CronJob' ? undefined : o.status?.readyReplicas ?? 0;
        cis.push({
          source_id: id, name: clean(name), ci_type: 'kubernetes_workload', environment: cfg.environment, source_url: link(w.kind, namespace, name),
          attributes: {
            namespace: clean(namespace, 100), kind: w.kind, ...(desired !== undefined ? { replicas: Number(desired) } : {}), ...(ready !== undefined ? { ready_replicas: Number(ready) } : {}),
            ...(images ? { images: images.slice(0, 500) } : {}), ...(w.kind === 'CronJob' ? { schedule: clean(o.spec?.schedule, 50) } : {}),
          },
          tags: keep(o.metadata?.labels),
        });
        relationships.push({ from_id: `ns/${namespace}`, type: 'contains', to_id: id });
        workloadIds.push({ id, kind: w.kind, namespace, name });
      }
    }

    // A kind that suddenly lists nothing, where it listed some before, is more likely an API problem than a cluster
    // that lost all of them: the snapshot is incomplete rather than a reason to mark them missing.
    const prefixes: Record<string, string> = { node: 'node/', namespace: 'ns/', Deployment: 'Deployment/', StatefulSet: 'StatefulSet/', DaemonSet: 'DaemonSet/', CronJob: 'CronJob/' };
    for (const [kind, prefix] of Object.entries(prefixes)) {
      if (counts[kind] !== 0) continue;
      const { rows } = await query('SELECT count(*)::int AS n FROM ci_sources WHERE source_system = $1 AND source_id LIKE $2 AND missed_syncs = 0', [ctx.sourceSystem, `${prefix}%`]);
      if (rows[0].n > 0) partial.push({ message: `${kind}: the list came back empty where ${rows[0].n} were reported before`, prefix });
    }

    let events: NormalisedEvent[] | undefined;
    if (cfg.sync_events) {
      const list = await listKind(ctx, '/api/v1/events?fieldSelector=type%3DWarning');
      // Events cannot say anything about which CIs exist: a forbidden list only means no alerts this run.
      if ('skipped' in list) warnings.push(`events: ${list.skipped}`);
      else {
        // Core events linger until their TTL (an hour by default) after the problem is gone: only those seen within
        // two sync intervals count as current, so a fixed crash loop clears on the next run.
        const since = Date.now() - Math.max(2 * ctx.scheduleMinutes, 10) * 60_000;
        const latest = new Map<string, { at: number; event: NormalisedEvent }>();
        for (const e of list.items) {
          const severity = REASONS[e.reason];
          if (!severity) continue;
          // Newer clusters leave lastTimestamp null on recurring events and keep the latest in series.
          const seenAt = e.series?.lastObservedTime ?? e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp;
          const at = seenAt ? Date.parse(seenAt) : NaN;
          if (!(at >= since)) continue;
          const obj = e.involvedObject ?? e.regarding ?? {};
          const target = obj.kind === 'Pod' ? podOwner(workloadIds, String(obj.namespace), String(obj.name)) : obj.kind === 'Node' ? `node/${obj.name}` : undefined;
          if (!target || (obj.namespace && excluded.has(String(obj.namespace)))) continue;
          // One alert per workload and reason, from its latest occurrence; the message is untrusted text from the cluster.
          const key = `${target}|${e.reason}`;
          if ((latest.get(key)?.at ?? -1) >= at) continue;
          latest.set(key, {
            at,
            event: { ci_source_id: target, check: `Kubernetes ${e.reason}`, severity, message: clean(`${obj.kind} ${obj.name}: ${e.message ?? e.note ?? ''}`, 2000), occurred_at: new Date(at).toISOString() },
          });
        }
        events = [...latest.values()].map((l) => l.event);
      }
    }
    return { cis, relationships, events, partial, warnings };
  },
};
