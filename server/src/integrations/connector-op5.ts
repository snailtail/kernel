// The OP5 Monitor connector (#19): one connector per OP5 (or Naemon with the OP5 REST API), reading Livestatus through
// /api/filter/query with a read-only API user.
//
// CIs: every host, and each of its services as a monitoring check that runs on it. Host groups become tags, or
// technical services the hosts are part of when the connector maps them. source_url is the OP5 detail page.
//
// Events: the current HARD problems of hosts and services, read in the same lists. A problem that is gone is no longer
// reported, and the framework clears its alert; so the last run is the cursor and nothing is kept between runs. A host
// or service in scheduled downtime is reported as maintenance, which records the alert but opens no incident.
//
// Data minimisation: only allowlisted custom variables are kept (CI_ID, OWNER and those the connector names), and what
// is kept goes through the sensitive-data scanner (#61). Check commands are kept by name only, never their arguments.
import { z } from 'zod';
import type { ConnectorType, RunContext } from './connectors.js';
import { query } from '../core/db.js';
import { OP5_SEVERITY } from '../events/event-hooks.js';
import type { NormalisedEvent } from '../events/events.js';
import { redact } from '../security/scanner.js';

const PAGE = 1000;
const MAX_PAGES = 500;

const HOST_STATES = ['UP', 'DOWN', 'UNREACHABLE'] as const;
const SERVICE_STATES = ['OK', 'WARNING', 'CRITICAL', 'UNKNOWN'] as const;

const HOST_COLUMNS = 'name,alias,address,groups,check_command,notes,notes_url,custom_variables,has_been_checked,state,state_type,last_hard_state,last_hard_state_change,acknowledged,scheduled_downtime_depth,plugin_output';
const SERVICE_COLUMNS = 'host.name,host.scheduled_downtime_depth,description,check_command,notes,notes_url,custom_variables,has_been_checked,state,state_type,last_hard_state,last_hard_state_change,acknowledged,scheduled_downtime_depth,plugin_output';

/** Every row of a Livestatus table, a page at a time. */
async function listAll(ctx: RunContext, table: string, columns: string): Promise<any[]> {
  const rows: any[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await ctx.fetchJson(`/api/filter/query?query=${encodeURIComponent(`[${table}] all`)}&columns=${columns}&limit=${PAGE}&offset=${page * PAGE}&format=json`);
    if (!Array.isArray(res)) throw new Error(`${table}: OP5 did not answer with a list`);
    rows.push(...res);
    if (res.length < PAGE) return rows;
  }
  throw new Error(`${table}: more than ${MAX_PAGES * PAGE} rows`);
}

/** Lists a table, or says why it could not (a right the API user lacks). */
async function listTable(ctx: RunContext, table: string, columns: string): Promise<{ rows: any[] } | { skipped: string }> {
  try {
    return { rows: await listAll(ctx, table, columns) };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) return { skipped: 'not readable by the API user' };
    throw err;
  }
}

const clean = (v: unknown, max = 200) => redact(String(v ?? '')).text.slice(0, max);
/** The command's name only: arguments after "!" may carry passwords (check_mysql!user!secret). */
const commandName = (v: unknown) => clean(String(v ?? '').split('!')[0], 200);
const tag = (k: string, v: string) => `${k.toLowerCase().replace(/[^a-z0-9_]/g, '_')}=${clean(v, 100)}`.slice(0, 50);

/** Custom variables as { NAME: value }, from the object Livestatus returns (or [name, value] pairs). */
function customVariables(v: unknown): Record<string, string> {
  if (Array.isArray(v)) return Object.fromEntries(v.filter((p) => Array.isArray(p) && p.length === 2).map(([k, x]) => [String(k).toUpperCase(), String(x)]));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.toUpperCase(), String(x)]));
  return {};
}

const CI_REF = /^(CI|SVC)\d{6,}$/i;

/**
 * The read-only OP5 user's rights. OP5 grants rights to groups (Manage → Configure → Group rights); a user in only this
 * group can read status through the HTTP API, and cannot change configuration or send commands.
 */
function op5Setup(config: { hostgroups_as_services?: unknown }): string {
  const groups = config.hostgroups_as_services === true || config.hostgroups_as_services === 'true';
  return `Kernel: a read-only OP5 Monitor user

1. Manage → Configure → Group rights: add a group "kernel_readers" with only these rights:
   - API: API Status (read the HTTP API's filter queries)
   - Host: Host View All
   - Service: Service View All${groups ? '\n   - Host group: Hostgroup View All' : ''}
   Leave every other right off: no API Config, API Command, Configuration, Nagvis, Reports or command rights.
   Kernel only reads; it never acknowledges, schedules downtime or changes configuration.
2. Manage → Configure → Users: add a local user "kernel" in the group "kernel_readers" only, with a long random
   password. Save and apply the configuration.
3. Here: the OP5 URL (https://op5.example.com), the user and the password. Add the OP5 server's address under
   private network access if it is on your LAN, and its CA certificate if it uses your own CA.
4. Test: Kernel counts the hosts, and says so if OP5 refuses the user.
`;
}

export const OP5: ConnectorType = {
  label: 'OP5 Monitor',
  config: z.object({
    base_url: z.string().url().refine((u) => /^https?:\/\//.test(u), 'http(s) only'),
    /** Plain HTTP sends the credentials in clear text: only for a lab, and only when explicitly chosen. */
    insecure_http: z.boolean().default(false),
    /** A CA certificate (PEM) to trust for this connector only, e.g. an internal company CA. */
    ca_pem: z.string().max(20_000).regex(/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/, 'Paste a PEM certificate').optional().or(z.literal('')),
    /** The CI type for hosts that no other connector already knows. */
    default_ci_type: z.string().max(50).default('virtual_machine'),
    environment: z.enum(['prod', 'test', 'dev', 'other']).default('prod'),
    /** Current HARD problems of hosts and services become alerts. */
    sync_events: z.boolean().default(true),
    /** Host groups become technical services their hosts are part of; otherwise only a tag on each host. */
    hostgroups_as_services: z.boolean().default(false),
    /** Custom variables kept as tags besides CI_ID and OWNER, by name without the leading underscore. */
    custom_variables: z.array(z.string().regex(/^[A-Za-z0-9_]{1,50}$/, 'A custom variable name, e.g. TEAM').transform((s) => s.toUpperCase())).max(20).default([]),
  }),
  secret: z.union([
    z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(500) }),
    z.object({ token: z.string().min(20).max(10_000) }),
  ]),

  test: async (ctx) => {
    try {
      const hosts = await ctx.fetchJson('/api/filter/count?query=' + encodeURIComponent('[hosts] all') + '&format=json');
      return `Connected: ${hosts.count ?? hosts} hosts`;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401) throw new Error('OP5 refused the user or password (HTTP 401)');
      if (status === 403) throw new Error('OP5 accepted the user, but it may not read the API (HTTP 403): give its group the right API Status (see the setup text)');
      throw err;
    }
  },

  setup: op5Setup,

  fetch: async (ctx) => {
    const cfg = ctx.config;
    const base = cfg.base_url.replace(/\/$/, '');
    const detail = (host: string, service?: string) => `${base}/monitor/index.php/extinfo/details?host=${encodeURIComponent(host)}${service === undefined ? '' : `&service=${encodeURIComponent(service)}`}`;
    const allowed = new Set<string>(['CI_ID', 'OWNER', ...cfg.custom_variables]);
    const keep = (vars: unknown) => {
      const kept = Object.entries(customVariables(vars)).filter(([k, v]) => allowed.has(k) && v !== '');
      return { tags: kept.filter(([k]) => k !== 'CI_ID').map(([k, v]) => tag(k, v)), ciRef: kept.find(([k, v]) => k === 'CI_ID' && CI_REF.test(v.trim()))?.[1].trim() };
    };
    const cis: Awaited<ReturnType<NonNullable<ConnectorType['fetch']>>>['cis'] = [];
    const relationships: { from_id: string; type: string; to_id: string }[] = [];
    const partial: { message: string; prefix?: string }[] = [];
    const events: NormalisedEvent[] = [];
    const serviceId = (host: string, description: string) => `service/${host}/${description}`.slice(0, 300);

    /** A HARD problem (or the latest HARD state while a SOFT one is pending) as an event; nothing for OK and UP. */
    const problem = (o: any, states: readonly string[], target: { id: string; host: string; check: string; url: string; downtime: boolean }) => {
      if (!cfg.sync_events || o.has_been_checked === 0) return;
      const hard = Number(o.state_type === 1 || o.last_hard_state === undefined ? o.state : o.last_hard_state);
      const state = states[hard];
      if (!state || hard === 0) return;
      events.push({
        ci_source_id: target.id, host: target.host, check: target.check.slice(0, 200), severity: OP5_SEVERITY[state as keyof typeof OP5_SEVERITY],
        message: clean(`${o.acknowledged ? 'Acknowledged in OP5. ' : ''}${state}: ${o.plugin_output ?? ''}`, 2000),
        occurred_at: o.last_hard_state_change > 0 ? new Date(o.last_hard_state_change * 1000).toISOString() : undefined,
        url: target.url, ...(target.downtime ? { maintenance: true } : {}),
      });
    };

    // Hosts are the snapshot itself: when they cannot be read the run fails and nothing is marked missing.
    const hosts = await listAll(ctx, 'hosts', HOST_COLUMNS);
    const known = new Set<string>();
    for (const h of hosts) {
      const name = String(h.name);
      known.add(name);
      const vars = keep(h.custom_variables);
      const groups: string[] = Array.isArray(h.groups) ? h.groups.map(String) : [];
      cis.push({
        source_id: name, source_url: detail(name), name: clean(name), ci_type: cfg.default_ci_type, environment: cfg.environment,
        ...(vars.ciRef ? { ci: vars.ciRef } : {}),
        tags: [...groups.map((g) => tag('hostgroup', g)), ...vars.tags].slice(0, 30),
        attributes: {
          ip: clean(h.address, 50), ...(name.includes('.') ? { fqdn: clean(name) } : {}),
          alias: clean(h.alias), check_command: commandName(h.check_command), notes: clean(h.notes, 500), notes_url: /^https?:\/\//.test(h.notes_url ?? '') ? clean(h.notes_url, 500) : '',
        },
      });
      if (cfg.hostgroups_as_services) for (const g of groups) relationships.push({ from_id: name, type: 'member_of', to_id: `hostgroup/${g}` });
      problem(h, HOST_STATES, { id: name, host: name, check: 'host', url: detail(name), downtime: h.scheduled_downtime_depth > 0 });
    }

    const services = await listTable(ctx, 'services', SERVICE_COLUMNS);
    if ('skipped' in services) partial.push({ message: `services: ${services.skipped}`, prefix: 'service/' });
    else {
      for (const s of services.rows) {
        const host = String(s['host.name'] ?? s.host?.name ?? '');
        const description = String(s.description ?? '');
        if (!known.has(host) || !description) continue;
        const id = serviceId(host, description);
        cis.push({
          source_id: id, source_url: detail(host, description), name: clean(`${host} / ${description}`), ci_type: 'monitoring_check', environment: cfg.environment,
          tags: keep(s.custom_variables).tags,
          attributes: { host: clean(host), check_command: commandName(s.check_command), notes: clean(s.notes, 500), notes_url: /^https?:\/\//.test(s.notes_url ?? '') ? clean(s.notes_url, 500) : '' },
        });
        relationships.push({ from_id: id, type: 'runs_on', to_id: host });
        const downtime = s.scheduled_downtime_depth > 0 || (s['host.scheduled_downtime_depth'] ?? s.host?.scheduled_downtime_depth) > 0;
        problem(s, SERVICE_STATES, { id, host, check: description, url: detail(host, description), downtime });
      }
    }

    if (cfg.hostgroups_as_services) {
      const groups = await listTable(ctx, 'hostgroups', 'name,alias');
      if ('skipped' in groups) {
        partial.push({ message: `host groups: ${groups.skipped}`, prefix: 'hostgroup/' });
        // Memberships of groups that cannot be listed are left as they are, like the groups themselves.
        for (let i = relationships.length - 1; i >= 0; i--) if (relationships[i].to_id.startsWith('hostgroup/')) relationships.splice(i, 1);
      } else {
        for (const g of groups.rows) {
          const name = String(g.name);
          cis.push({ source_id: `hostgroup/${name}`, source_url: `${base}/monitor/index.php/status/hostgroup?group=${encodeURIComponent(name)}`, name: clean(g.alias || name), ci_type: 'technical_service', environment: cfg.environment, attributes: {} });
        }
      }
    }

    // A list that suddenly comes back empty, where it had rows before, is more likely an API problem than an estate
    // that lost all its services: incomplete rather than a reason to mark them missing.
    for (const prefix of ['service/', 'hostgroup/']) {
      if (cis.some((c) => c.source_id.startsWith(prefix)) || partial.some((p) => p.prefix === prefix)) continue;
      const { rows } = await query('SELECT count(*)::int AS n FROM ci_sources WHERE source_system = $1 AND source_id LIKE $2 AND missed_syncs = 0', [ctx.sourceSystem, `${prefix}%`]);
      if (rows[0].n > 0) partial.push({ message: `${prefix.slice(0, -1)}s: the list came back empty where ${rows[0].n} were reported before`, prefix });
    }

    return { cis, relationships, partial, ...(cfg.sync_events ? { events } : {}) };
  },
};
