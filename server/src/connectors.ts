// Connector framework (#18): pull connectors and the push contract share one sync path. A connector only fetches and
// maps; scheduling, credentials, reconciliation, missing-CI detection and the run log are done here.
// - credentials are encrypted and write-only; a connector may only reach the private addresses it lists;
// - runs never overlap (a lease per connector) and every run is logged with counts and errors;
// - a full snapshot that failed or shrank implausibly never marks CIs missing.
import { KUBERNETES } from './connector-kubernetes.js';
import { IMAP, MSGRAPH } from './connector-mailbox.js';
import { z } from 'zod';
import type { User } from './auth.js';
import { audit } from './audit.js';
import { prefixPatterns, syncRelationships } from './cmdb-graph.js';
import { logCi, upsertCis, upsertSchema } from './cmdb.js';
import { query, tx } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { processEvents, type NormalisedEvent } from './events.js';
import { asSystem } from './context.js';
import { mailboxTargetSchema, receiveMail } from './inbound-mail.js';
import { logger } from './log.js';
import { moduleEnabled } from './modules.js';
import { outboundFetch, validatePrivateAllow } from './outbound.js';
import { authorize } from './policy.js';
import { decryptSecret, encryptSecret } from './secrets.js';

// ---- The push contract -------------------------------------------------------------------------

const batchCi = upsertSchema.shape.items.element.omit({ source_system: true });
export const ciBatchSchema = z.object({
  source_system: z.string().trim().min(1).max(100),
  cis: z.array(batchCi).max(10_000),
  relationships: z.array(z.object({ from_id: z.string().min(1).max(300), type: z.string().min(1).max(50), to_id: z.string().min(1).max(300) })).max(20_000).default([]),
  /** The batch is the source's complete snapshot: CIs it no longer reports count as missed. */
  full_sync: z.boolean().default(false),
  /**
   * With full_sync: source-id prefixes the snapshot could not read completely this time (e.g. "CronJob/" when the
   * source may not list cron jobs). CIs and relationships under them are left as they are; everything else is synced.
   */
  incomplete_prefixes: z.array(z.string().min(1).max(100)).max(50).default([]),
});

interface Reconciliation { missing_after: number; max_drop_percent: number }
async function reconciliation(): Promise<Reconciliation> {
  const { rows } = await query("SELECT value FROM settings WHERE key = 'cmdb_reconciliation'");
  return { missing_after: 3, max_drop_percent: 50, ...(rows[0]?.value ?? {}) };
}

/**
 * CIs and relationships from one source in one call (REST, MCP and every pull connector use this). With full_sync,
 * records the source no longer reports count a missed sync; after `missing_after` misses by all its sources a CI is
 * marked missing. A snapshot that shrank by more than `max_drop_percent` is refused for that step.
 */
export async function ciBatch(user: User, input: z.infer<typeof ciBatchSchema>) {
  authorize(user, 'ci.ingest');
  // upsertCis takes 1000 items a call; a snapshot can be larger (a cluster's workloads, a big monitoring estate).
  const cis = { created: 0, updated: 0, unchanged: 0, matched: 0, errors: [] as unknown[] };
  for (let i = 0; i < input.cis.length; i += 1000) {
    const part = await upsertCis(user, upsertSchema.parse({ items: input.cis.slice(i, i + 1000).map((c) => ({ ...c, source_system: input.source_system })) }));
    cis.created += part.created; cis.updated += part.updated; cis.unchanged += part.unchanged; cis.matched += part.matched;
    cis.errors.push(...part.errors);
  }
  // Relationships are only reconciled when the snapshot includes them; a CI-only source never wipes its relationships.
  const rels = input.relationships.length
    ? await syncRelationships(user, { source_system: input.source_system, relationships: input.relationships, full: input.full_sync, keep_prefixes: input.incomplete_prefixes })
    : { created: 0, seen: 0, removed: 0, errors: [] };
  let missing: { missed: number; marked_missing: number; refused?: string } = { missed: 0, marked_missing: 0 };
  if (input.full_sync) missing = await markMissed(user, input.source_system, input.cis.map((c) => c.source_id), input.incomplete_prefixes);
  return { cis, relationships: rels, missing };
}

async function markMissed(user: User, source: string, seenIds: string[], skipPrefixes: string[]) {
  const settings = await reconciliation();
  const skip = prefixPatterns(skipPrefixes);
  const inScope = (id: string) => !skipPrefixes.some((p) => id.startsWith(p));
  const { rows } = await query('SELECT count(*)::int AS n FROM ci_sources WHERE source_system = $1 AND missed_syncs = 0 AND NOT (source_id LIKE ANY($2))', [source, skip]);
  const before = rows[0].n;
  const seen = new Set(seenIds.filter(inScope)).size;
  if (before >= 10 && seen < before * (1 - settings.max_drop_percent / 100)) {
    const refused = `The snapshot has ${seen} CIs where ${before} were present (more than ${settings.max_drop_percent} % fewer): nothing was marked missing`;
    await audit(null, { entity_type: 'ci_upsert', entity_ref: source, action: 'full_sync_refused', changes: { before, seen } });
    return { missed: 0, marked_missing: 0, refused };
  }
  return tx(async (db) => {
    const { rowCount } = await db.query('UPDATE ci_sources SET missed_syncs = missed_syncs + 1 WHERE source_system = $1 AND NOT (source_id = ANY($2)) AND NOT (source_id LIKE ANY($3))', [source, seenIds, skip]);
    // A CI goes missing only when every source that reports it has missed it enough times; never deleted.
    const { rows: gone } = await db.query(
      `UPDATE configuration_items c SET status = 'missing', updated_at = now()
       WHERE c.status IN ('active', 'maintenance')
         AND EXISTS (SELECT 1 FROM ci_sources s WHERE s.ci_id = c.id AND s.source_system = $1)
         AND NOT EXISTS (SELECT 1 FROM ci_sources s WHERE s.ci_id = c.id AND s.missed_syncs < $2)
       RETURNING c.id`,
      [source, settings.missing_after],
    );
    for (const g of gone) await logCi(db, g.id, user.id, 'status', `Not reported by ${source} for ${settings.missing_after} syncs`, { from: 'active', to: 'missing', source_system: source });
    return { missed: rowCount ?? 0, marked_missing: gone.length };
  });
}

// ---- Connector types ---------------------------------------------------------------------------

export interface RunContext {
  config: Record<string, any>;
  secret: Record<string, string>;
  /** GET base_url + path as JSON. Errors carry the HTTP status (err.status), e.g. 403 for a kind RBAC forbids. */
  fetchJson: (path: string) => Promise<any>;
  /** POST JSON to base_url + path, for read-only questions an API asks as a POST (a Kubernetes access review). */
  postJson: (path: string, body: unknown) => Promise<any>;
  /** The connector's source system, for types that compare with what they reported before. */
  sourceSystem: string;
  /** How often the connector runs, for types that judge whether an event is still current. */
  scheduleMinutes: number;
  /** Private addresses the connector may reach (for types that open their own connections, e.g. IMAP). */
  privateAllow: string[];
  /** Aborted when the run is stopped. */
  signal?: AbortSignal;
  /** Any HTTPS request through the SSRF-safe client, with the connector's private allowlist and the run's signal. */
  request: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; body: string }>;
}
export interface ConnectorType {
  label: string;
  /** Non-secret settings the type needs, validated on save. */
  config: z.ZodType<Record<string, any>>;
  secret: z.ZodType<Record<string, string>>;
  test: (ctx: RunContext) => Promise<string>;
  /** Setup text for the source system (e.g. a least-privilege manifest), from the form's current settings. */
  setup?: (config: Record<string, unknown>) => string;
  /**
   * A mailbox (#48) instead of a CI source: reads new messages and hands each one to `deliver` (raw MIME), then marks
   * it handled. A message whose delivery throws is left for the next run.
   */
  receive?: (ctx: RunContext, deliver: (raw: Buffer) => Promise<unknown>) => Promise<{ warnings: string[] }>;
  /** Fetch and map: CIs (complete snapshot) and the current problems as events. */
  fetch?: (ctx: RunContext) => Promise<{
    cis: z.infer<typeof batchCi>[];
    relationships?: { from_id: string; type: string; to_id: string }[];
    events?: NormalisedEvent[];
    /**
     * Something could not be read (a kind RBAC forbids, a list that came back suspiciously empty). With a `prefix`,
     * only the CIs whose source id starts with it are left alone this run; without one, nothing is marked missing.
     */
    partial?: { message: string; prefix?: string }[];
    /** Problems that do not touch the CI snapshot (e.g. events that could not be read): reported on the run only. */
    warnings?: string[];
  }>;
}

const OP5_STATE: Record<number, NormalisedEvent['severity']> = { 1: 'warning', 2: 'critical', 3: 'minor' };

/** OP5 Monitor (and Naemon/Livestatus REST): hosts become CIs, services with problems become events. */
const OP5: ConnectorType = {
  label: 'OP5 Monitor',
  config: z.object({
    base_url: z.string().url().refine((u) => /^https?:\/\//.test(u), 'http(s) only'),
    /** Plain HTTP sends the credentials in clear text: only for a lab, and only when explicitly chosen. */
    insecure_http: z.boolean().default(false),
    /** A CA certificate (PEM) to trust for this connector only, e.g. an internal company CA. */
    ca_pem: z.string().max(20_000).regex(/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/, 'Paste a PEM certificate').optional().or(z.literal('')),
    default_ci_type: z.string().max(50).default('virtual_machine'),
    environment: z.enum(['prod', 'test', 'dev', 'other']).default('prod'),
    sync_events: z.boolean().default(true),
  }),
  secret: z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(500) }),
  test: async (ctx) => {
    const hosts = await ctx.fetchJson('/api/filter/count?query=' + encodeURIComponent('[hosts] all') + '&format=json');
    return `Connected: ${hosts.count ?? hosts} hosts`;
  },
  fetch: async (ctx) => {
    const base = ctx.config.base_url.replace(/\/$/, '');
    const hosts: any[] = await ctx.fetchJson('/api/filter/query?query=' + encodeURIComponent('[hosts] all') + '&columns=name,address,alias&limit=50000&format=json');
    const cis = hosts.map((h) => ({
      source_id: String(h.name),
      source_url: `${base}/monitor/index.php/extinfo/details?host=${encodeURIComponent(h.name)}`,
      name: String(h.name).slice(0, 200),
      ci_type: ctx.config.default_ci_type,
      environment: ctx.config.environment,
      attributes: { ip: h.address ?? '', ...(String(h.name).includes('.') ? { fqdn: h.name } : {}) },
    }));
    let events: NormalisedEvent[] | undefined;
    if (ctx.config.sync_events) {
      const problems: any[] = await ctx.fetchJson(
        '/api/filter/query?query=' + encodeURIComponent('[services] state != 0 and has_been_checked = 1') + '&columns=host.name,description,state,plugin_output,last_state_change&limit=50000&format=json',
      );
      events = problems.map((p) => ({
        host: p['host.name'] ?? p.host?.name,
        ci_source_id: p['host.name'] ?? p.host?.name,
        check: String(p.description).slice(0, 200),
        severity: OP5_STATE[p.state] ?? 'minor',
        message: String(p.plugin_output ?? '').slice(0, 2000),
        occurred_at: p.last_state_change ? new Date(p.last_state_change * 1000).toISOString() : undefined,
      }));
    }
    return { cis, events };
  },
};

export const CONNECTOR_TYPES: Record<string, ConnectorType> = { op5: OP5, kubernetes: KUBERNETES, imap: IMAP, msgraph: MSGRAPH };

// ---- Registry ----------------------------------------------------------------------------------

export const connectorSchema = z.object({
  type: z.enum(['op5', 'kubernetes', 'imap', 'msgraph']),
  name: z.string().trim().min(1).max(100),
  source_system: z.string().trim().min(1).max(100),
  config: z.record(z.string(), z.unknown()),
  /** Write-only: omit to keep the stored credentials. */
  secret: z.record(z.string(), z.string()).optional(),
  private_allow: z.array(z.string().max(50)).max(20).default([]),
  schedule_minutes: z.number().int().min(5).max(10080).default(60),
  /** How many days a CI this connector reports may stay missing before it is proposed for retirement. */
  retire_after_days: z.number().int().min(1).max(365).default(14),
  enabled: z.boolean().default(true),
});

const PUBLIC = 'id, type, name, source_system, config, private_allow, schedule_minutes, retire_after_days, enabled, next_run_at, running_until, created_at, secret IS NOT NULL AS has_secret';

export async function listConnectors(user: User) {
  authorize(user, 'user.manage');
  const { rows } = await query(
    `SELECT ${PUBLIC}, (SELECT row_to_json(r) FROM (SELECT status, counts, message, started_at, finished_at FROM connector_runs WHERE connector_id = c.id ORDER BY id DESC LIMIT 1) r) AS last_run
     FROM connectors c ORDER BY name`,
  );
  return rows;
}

export async function saveConnector(user: User, id: number | null, input: z.infer<typeof connectorSchema>) {
  authorize(user, 'user.manage');
  const type = CONNECTOR_TYPES[input.type];
  const config = type.config.parse(input.config);
  if (config.base_url?.startsWith('http://') && !config.insecure_http) {
    throw badRequest('The connector would send its credentials in clear text over http. Use https, or tick "plain HTTP (lab only)".');
  }
  const secret = input.secret ? type.secret.parse(input.secret) : null;
  if (!id && !secret) throw badRequest('Credentials are required for a new connector');
  const allowProblem = validatePrivateAllow(input.private_allow);
  if (allowProblem) throw badRequest(allowProblem);
  // A connector owns its source system: no integration account may write it too.
  const { rows: taken } = await query('SELECT username FROM users WHERE $1 = ANY(ci_source_systems) LIMIT 1', [input.source_system]);
  if (taken[0]) throw conflict(`The integration account ${taken[0].username} already reports "${input.source_system}"; choose another source system name`);
  try {
    const { rows } = id
      ? await query(
          `UPDATE connectors SET name = $2, source_system = $3, config = $4, secret = coalesce($5, secret), private_allow = $6, schedule_minutes = $7, enabled = $8, retire_after_days = $9 WHERE id = $1 RETURNING ${PUBLIC}`,
          [id, input.name, input.source_system, config, secret ? encryptSecret(JSON.stringify(secret)) : null, input.private_allow, input.schedule_minutes, input.enabled, input.retire_after_days],
        )
      : await query(
          `INSERT INTO connectors (type, name, source_system, config, secret, private_allow, schedule_minutes, enabled, created_by, retire_after_days) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${PUBLIC}`,
          [input.type, input.name, input.source_system, config, encryptSecret(JSON.stringify(secret)), input.private_allow, input.schedule_minutes, input.enabled, user.id, input.retire_after_days],
        );
    if (!rows[0]) throw notFound('Connector not found');
    await audit(null, { entity_type: 'connector', entity_ref: input.name, action: id ? 'update' : 'create', changes: { ...input, secret: input.secret ? '[changed]' : undefined, config } });
    return rows[0];
  } catch (err: any) {
    if (err.code === '23505') throw conflict('A connector with that name or source system already exists');
    throw err;
  }
}

export async function deleteConnector(user: User, id: number) {
  authorize(user, 'user.manage');
  const { rows } = await query('DELETE FROM connectors WHERE id = $1 RETURNING name', [id]);
  if (!rows[0]) throw notFound('Connector not found');
  await audit(null, { entity_type: 'connector', entity_ref: rows[0].name, action: 'delete', changes: {} });
}

/** A type's setup text (administrators), e.g. the Kubernetes manifest for the settings in the form. */
export function connectorSetup(user: User, type: string, config: Record<string, unknown>) {
  authorize(user, 'user.manage');
  const t = Object.hasOwn(CONNECTOR_TYPES, type) ? CONNECTOR_TYPES[type] : undefined;
  if (!t?.setup) throw notFound('This connector type has no setup text');
  return { text: t.setup(config) };
}

export async function connectorRuns(user: User, id: number) {
  authorize(user, 'user.manage');
  return (await query('SELECT id, trigger, status, counts, errors, message, started_at, finished_at FROM connector_runs WHERE connector_id = $1 ORDER BY id DESC LIMIT 50', [id])).rows;
}

function contextFor(c: any, signal?: AbortSignal): RunContext {
  const type = CONNECTOR_TYPES[c.type];
  const secret = c.secret ? JSON.parse(decryptSecret(c.secret)) : {};
  const config = type.config.parse(c.config);
  const auth = secret.token ? `Bearer ${secret.token}` : secret.username ? `Basic ${Buffer.from(`${secret.username}:${secret.password}`).toString('base64')}` : undefined;
  const call = async (path: string, body?: unknown) => {
    const res = await outboundFetch(config.base_url.replace(/\/$/, '') + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(auth ? { Authorization: auth } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      privateAllow: c.private_allow,
      ca: config.ca_pem || undefined,
      timeoutMs: 30_000,
      maxBytes: 50_000_000,
      signal,
    });
    if (!res.ok) throw Object.assign(new Error(`${c.name}: HTTP ${res.status}`), { status: res.status });
    try {
      return JSON.parse(res.body);
    } catch {
      throw new Error(`${c.name}: the response is not JSON`);
    }
  };
  return {
    config,
    secret,
    sourceSystem: c.source_system,
    scheduleMinutes: c.schedule_minutes,
    privateAllow: c.private_allow ?? [],
    signal,
    request: (url, init = {}) => outboundFetch(url, { timeoutMs: 30_000, maxBytes: 60_000_000, privateAllow: c.private_allow, signal, ...init }),
    fetchJson: (path) => call(path),
    postJson: (path, body) => call(path, body),
  };
}

export async function testConnector(user: User, id: number) {
  authorize(user, 'user.manage');
  const { rows } = await query('SELECT * FROM connectors WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Connector not found');
  try {
    return { ok: true, message: await CONNECTOR_TYPES[rows[0].type].test(contextFor(rows[0])) };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/** The module a connector type feeds: mailboxes create incidents, the others CIs. */
const moduleOf = (type: string) => (CONNECTOR_TYPES[type]?.receive ? 'incident' : 'cmdb');

/** How long a run may fetch before it is stopped; well inside the 30-minute lease. */
const RUN_TIMEOUT_MS = 10 * 60_000;
const duration = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${ms / 1000} s`);

/**
 * Runs a connector once. A lease on the connector row stops overlapping runs, also across replicas. The run fetches,
 * then pushes through ciBatch as the connector's creator, bound to the connector's own source system. A fetch that
 * takes longer than timeoutMs is stopped and the run fails, so a hanging source never holds the scheduler.
 */
export async function runConnector(id: number, trigger: 'schedule' | 'manual', actor?: User, timeoutMs = RUN_TIMEOUT_MS) {
  if (actor) authorize(actor, 'user.manage');
  const { rows: kind } = await query('SELECT type FROM connectors WHERE id = $1', [id]);
  if (kind[0] && !moduleEnabled(moduleOf(kind[0].type))) throw forbidden(`The ${moduleOf(kind[0].type) === 'cmdb' ? 'CMDB' : 'incident'} module is turned off`);
  // A scheduled run also claims only a connector that is still due: another tick (or replica) may have listed it
  // too, run it and released the lease already, which moved next_run_at on. Checked in the same statement as the lease.
  const { rows } = await query(
    `UPDATE connectors SET running_until = now() + interval '30 minutes', next_run_at = now() + schedule_minutes * interval '1 minute'
     WHERE id = $1 AND (running_until IS NULL OR running_until < now()) AND ($2 = 'manual' OR (enabled AND next_run_at <= now()))
     RETURNING *, running_until::text AS lease`,
    [id, trigger],
  );
  const c = rows[0];
  if (!c) throw conflict(trigger === 'manual' ? 'The connector is already running' : 'The connector is running or no longer due');
  const { rows: run } = await query('INSERT INTO connector_runs (connector_id, trigger) VALUES ($1, $2) RETURNING id', [c.id, trigger]);
  const finish = (status: string, counts: object, errors: unknown[], message: string) =>
    query('UPDATE connector_runs SET status = $2, counts = $3, errors = $4, message = $5, finished_at = now() WHERE id = $1', [run[0].id, status, counts, JSON.stringify(errors.slice(0, 100)), message.slice(0, 1000)]);
  const abort = new AbortController();
  let fetching: Promise<unknown> | undefined;
  try {
    const { rows: owner } = await query('SELECT id, username, display_name, email, role, preferences, must_change_password, true AS mfa_enabled FROM users WHERE id = $1', [c.created_by]);
    if (!owner[0]) throw new Error('The connector has no owner; save it again as an administrator');
    const user = owner[0] as User;
    const timer = setTimeout(() => abort.abort(new Error(`${c.name}: no complete answer within ${duration(timeoutMs)}; the run was stopped`)), timeoutMs);
    const stopped = new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true }));
    const type = CONNECTOR_TYPES[c.type];
    if (type.receive) {
      // A mailbox: each message is handled as it is read; the counts say what became of them.
      const target = mailboxTargetSchema.parse(c.config);
      const counts: Record<string, number> = {};
      const receiving = type.receive(contextFor(c, abort.signal), async (raw) => {
        const h = await asSystem(() => receiveMail({ id: c.id, name: c.name }, user, target, raw));
        counts[h.outcome] = (counts[h.outcome] ?? 0) + 1;
      });
      fetching = receiving;
      const { warnings } = await Promise.race([receiving, stopped]).finally(() => clearTimeout(timer));
      const message = Object.keys(counts).length ? Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') : 'No new mail';
      await finish('succeeded', counts, warnings.map((w) => ({ skipped: w })), message);
      return { status: 'succeeded', counts };
    }
    const work = type.fetch!(contextFor(c, abort.signal));
    fetching = work;
    const fetched = await Promise.race([work, stopped]).finally(() => clearTimeout(timer));
    // What could not be read completely is never marked missing: only its prefix, or the whole snapshot when the
    // type cannot say which part is affected.
    const partial = fetched.partial ?? [];
    const result = await ciBatch(user, {
      source_system: c.source_system, cis: fetched.cis, relationships: fetched.relationships ?? [],
      full_sync: partial.every((p) => p.prefix), incomplete_prefixes: partial.map((p) => p.prefix!).filter(Boolean),
    });
    let events: { reported: number; cleared: number } | undefined;
    if (fetched.events && moduleEnabled('event')) {
      // Current problems open or refresh alerts; alerts from this connector that are no longer a problem clear.
      const results = await processEvents(c.name, c.source_system, fetched.events);
      const current = new Set(results.map((r) => r.alert_id).filter(Boolean));
      const { rows: stale } = await query("SELECT id, ci_hint, check_key, ci_id FROM alerts WHERE source = $1 AND status = 'open'", [c.name]);
      const toClear = stale.filter((a) => !current.has(Number(a.id)));
      const { rows: ciRefs } = await query('SELECT id, ref FROM configuration_items WHERE id = ANY($1)', [toClear.map((a) => a.ci_id).filter(Boolean)]);
      const refOf = new Map(ciRefs.map((r) => [r.id, r.ref]));
      if (toClear.length) {
        await processEvents(c.name, c.source_system, toClear.map((a) => ({ ...(a.ci_id ? { ci: refOf.get(a.ci_id) } : { host: a.ci_hint }), check: a.check_key, severity: 'clear' as const, message: '' })));
      }
      events = { reported: results.length, cleared: toClear.length };
    }
    const errors = [...partial.map((p) => ({ skipped: p.message })), ...(fetched.warnings ?? []).map((w) => ({ skipped: w })), ...result.cis.errors, ...result.relationships.errors];
    const status = result.missing.refused ? 'refused' : 'succeeded';
    const incomplete = partial.map((p) => p.message).join('; ');
    const message = result.missing.refused
      ?? (!partial.length ? `${fetched.cis.length} CIs synced`
        : partial.every((p) => p.prefix) ? `${fetched.cis.length} CIs synced; not marked missing where the list was incomplete: ${incomplete}`
        : `${fetched.cis.length} CIs synced; incomplete, so nothing was marked missing: ${incomplete}`);
    await finish(status, { ...result.cis, errors: undefined, ...result.missing, refused: undefined, ...(events ? { events } : {}) }, errors, message);
    return { status, ...result, events };
  } catch (err) {
    // A failed fetch never marks anything missing: ciBatch was not reached.
    logger.warn({ connector: c.name, err: (err as Error).message }, 'connector run failed');
    await finish('failed', {}, [], (err as Error).message);
    return { status: 'failed', message: (err as Error).message };
  } finally {
    // Only this run's own lease: a fetch that outlived it (30 minutes) must not release the next run's.
    const release = () => query('UPDATE connectors SET running_until = NULL WHERE id = $1 AND running_until = $2::timestamptz', [c.id, c.lease]);
    if (abort.signal.aborted && fetching) {
      // A fetch that does not honour the signal everywhere may still be talking to the source: the lease stands until
      // it settles (or expires after 30 minutes), so the next tick never starts a second fetch beside it.
      const released = fetching.then(release, release);
      released.catch((err) => logger.warn({ connector: c.name, err: (err as Error).message }, 'connector lease not released'));
      await Promise.race([released, new Promise((r) => setTimeout(r, 1000).unref())]);
    } else await release();
  }
}

/**
 * Runs every due connector, a few at a time, so one slow source never holds up the others. Each run claims its own
 * lease, so replicas share the work without overlap: a connector another replica took is skipped here.
 */
export async function runDueConnectors({ concurrency = 3, timeoutMs = RUN_TIMEOUT_MS } = {}) {
  const { rows } = await query('SELECT id, type FROM connectors WHERE enabled AND next_run_at <= now() AND (running_until IS NULL OR running_until < now()) ORDER BY next_run_at');
  const queue = rows.filter((r) => moduleEnabled(moduleOf(r.type))).map((r) => r.id as number);
  let ran = 0;
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (await runConnector(id, 'schedule', undefined, timeoutMs).then(() => true, () => false)) ran++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return ran;
}

export function startConnectorWorker(log: (msg: string) => void) {
  // A tick can outlast the interval (a run may take minutes); the next tick waits so the concurrency limit holds.
  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    runDueConnectors()
      .catch((err) => log(`connector scheduler failed: ${err.message}`))
      .finally(() => { busy = false; });
  }, 60_000).unref();
}
