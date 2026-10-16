// Monitoring and event management (#30). Events from monitoring tools are normalised, deduplicated into alerts on
// (source, CI, check), suppressed during maintenance, and turned into incidents by allowlisted rules – grouped and
// rate limited, so an alert storm becomes one incident, not hundreds. A clear closes the alert; flapping reopens the
// same alert, and incidents are only auto-resolved after a hold-down period.
import { z } from 'zod';
import type { User } from './auth.js';
import { audit } from './audit.js';
import { computeImpact, getGroup, impactSchema } from './cmdb-graph.js';
import { registerCiExtra } from './cmdb.js';
import { query, tx } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { insertIncident, logIncident } from './incidents.js';
import { slaOnTransition } from './sla.js';
import type { Db } from './problems.js';
import { logger } from './log.js';
import { moduleEnabled } from './modules.js';
import { authorize, can } from './policy.js';

export const SEVERITIES = ['info', 'warning', 'minor', 'major', 'critical'] as const;
/**
 * Kernel's own security alerts (#64). The name is reserved: only the detection rules report under it, its alerts
 * match only rules that name it, and the incidents they open are security incidents, restricted from the start.
 */
export const SECURITY_SOURCE = 'Kernel security';
export const isReservedSource = (name: string) => name.trim().toLowerCase() === SECURITY_SOURCE.toLowerCase();
export type Severity = (typeof SEVERITIES)[number];
const RANK: Record<string, number> = { clear: 0, info: 1, warning: 2, minor: 3, major: 4, critical: 5 };

const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => v === '' || /^https?:\/\//i.test(v), 'URL must start with http:// or https://');

/** The normalised event every adapter produces, and the generic format for POST /api/events and MCP. */
export const eventSchema = z.object({
  source_event_id: z.string().trim().max(300).optional(),
  ci: z.string().trim().max(30).optional().describe('CI or service ref, e.g. CI000012'),
  ci_source_id: z.string().trim().max(500).optional().describe("The CI's id in the source's CMDB source system (e.g. an Azure resource id)"),
  host: z.string().trim().max(255).optional().describe('Host name, FQDN, IP or resource name, matched against the CMDB'),
  check: z.string().trim().min(1).max(200).describe('What is checked, e.g. disk_usage or HTTP /health'),
  severity: z.enum(['clear', ...SEVERITIES]),
  message: z.string().max(2000).default(''),
  occurred_at: z.iso.datetime({ offset: true }).optional(),
  url: httpUrl.optional().describe('Link back to the alert in the monitoring tool'),
  /** The source reports the check as under maintenance: record it, but suppress it. */
  maintenance: z.boolean().optional(),
});
export type NormalisedEvent = z.infer<typeof eventSchema>;
export const reportEventsSchema = z.object({
  source: z.string().trim().min(1).max(100).describe('The monitoring source, e.g. Zabbix'),
  events: z.array(eventSchema).min(1).max(500),
});

// ---- Settings ----------------------------------------------------------------------------------

interface Retention { raw_days: number; closed_alert_days: number; reopen_window_minutes: number }
async function retention(): Promise<Retention> {
  const { rows } = await query("SELECT value FROM settings WHERE key = 'event_retention'");
  return { raw_days: 14, closed_alert_days: 180, reopen_window_minutes: 15, ...(rows[0]?.value ?? {}) };
}

// ---- Rules -------------------------------------------------------------------------------------

/** The only conditions a rule may use; evaluated in code against the alert and its CI, never as SQL or regex. */
export const ruleConditionsSchema = z.object({
  min_severity: z.enum(SEVERITIES).optional(),
  sources: z.array(z.string().max(100)).max(20).optional(),
  check_contains: z.string().max(100).optional(),
  ci_types: z.array(z.string().max(50)).max(30).optional(),
  environments: z.array(z.enum(['prod', 'test', 'dev', 'other'])).max(4).optional(),
  /** CI criticality at least this high (1 = business critical). */
  max_ci_criticality: z.number().int().min(1).max(4).optional(),
  /** Also match alerts whose CI is not in the CMDB (default true). */
  include_unmatched: z.boolean().optional(),
  /** Only when the alert repeated at least this many times. */
  min_count: z.number().int().min(1).max(10000).optional(),
});
export const ruleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  position: z.number().int().min(0).max(10000).default(100),
  conditions: ruleConditionsSchema.default({}),
  impact: z.number().int().min(1).max(3).default(2),
  urgency: z.number().int().min(1).max(3).default(2),
  assignment_group: z.string().trim().max(100).default(''),
  /** The team new incidents go to (#42); a group name is matched to its team. */
  team_id: z.number().int().nullable().optional(),
  group_by: z.enum(['service', 'ci', 'rule']).default('service'),
  group_window_minutes: z.number().int().min(1).max(1440).default(60),
  max_incidents_per_hour: z.number().int().min(1).max(100).default(5),
  auto_resolve: z.boolean().default(false),
  hold_down_minutes: z.number().int().min(0).max(1440).default(15),
});
type Rule = z.infer<typeof ruleSchema> & { id: number };

interface AlertFacts { severity: string; source: string; check_key: string; count: number; ci: CiFacts | null }
interface CiFacts { id: number; ref: string; name: string; ci_type: string; environment: string; criticality: number; status: string }

export function ruleMatches(c: z.infer<typeof ruleConditionsSchema>, a: AlertFacts) {
  if (c.min_severity && RANK[a.severity] < RANK[c.min_severity]) return false;
  if (c.sources?.length && !c.sources.includes(a.source)) return false;
  if (c.check_contains && !a.check_key.toLowerCase().includes(c.check_contains.toLowerCase())) return false;
  if (c.min_count && a.count < c.min_count) return false;
  if (!a.ci) return c.include_unmatched !== false && !c.ci_types?.length && !c.environments?.length && !c.max_ci_criticality;
  if (c.ci_types?.length && !c.ci_types.includes(a.ci.ci_type)) return false;
  if (c.environments?.length && !c.environments.includes(a.ci.environment as 'prod')) return false;
  if (c.max_ci_criticality && a.ci.criticality > c.max_ci_criticality) return false;
  return true;
}

export async function listRules(user: User) {
  authorize(user, 'event.read');
  return (await query('SELECT * FROM event_rules ORDER BY position, id')).rows;
}

export async function saveRule(user: User, id: number | null, input: z.infer<typeof ruleSchema>) {
  authorize(user, 'event.manage');
  const cols = Object.keys(input) as (keyof typeof input)[];
  const values = cols.map((k) => (k === 'conditions' ? JSON.stringify(input[k]) : input[k]));
  try {
    const { rows } = id
      ? await query(`UPDATE event_rules SET ${cols.map((k, n) => `${k} = $${n + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, [id, ...values])
      : await query(`INSERT INTO event_rules (${cols.join(', ')}, created_by) VALUES (${cols.map((_, n) => `$${n + 1}`).join(', ')}, $${cols.length + 1}) RETURNING *`, [...values, user.id]);
    if (!rows[0]) throw notFound('Rule not found');
    await audit(null, { entity_type: 'event_rule', entity_ref: input.name, action: id ? 'update' : 'create', changes: input });
    return rows[0];
  } catch (err: any) {
    if (err.code === '23505') throw conflict('A rule with that name already exists');
    throw err;
  }
}

export async function deleteRule(user: User, id: number) {
  authorize(user, 'event.manage');
  const { rows } = await query('DELETE FROM event_rules WHERE id = $1 RETURNING name', [id]);
  if (!rows[0]) throw notFound('Rule not found');
  await audit(null, { entity_type: 'event_rule', entity_ref: rows[0].name, action: 'delete', changes: {} });
}

// ---- Maintenance windows -----------------------------------------------------------------------

export const maintenanceSchema = z
  .object({
    /** A CI or service ref… */
    ci: z.string().trim().max(30).optional(),
    /** …or a CI group id. */
    group_id: z.number().int().optional(),
    /** For a CI or service: also everything it depends on (e.g. a service and its VMs, databases, hosts). */
    include_dependencies: z.boolean().default(false),
    starts_at: z.iso.datetime({ offset: true }),
    ends_at: z.iso.datetime({ offset: true }),
    reason: z.string().trim().max(500).default(''),
  })
  .refine((m) => !!m.ci !== (m.group_id !== undefined), 'Give either a CI/service or a group');

export async function listMaintenance(user: User, includePast = false) {
  authorize(user, 'event.read');
  const { rows } = await query(
    `SELECT m.id, c.ref AS ci, c.name AS ci_name, g.id AS group_id, g.name AS group_name, m.include_dependencies, m.starts_at, m.ends_at, m.reason,
            u.display_name AS created_by, (SELECT count(*)::int FROM maintenance_window_cis x WHERE x.window_id = m.id) AS covered_cis
     FROM maintenance_windows m LEFT JOIN configuration_items c ON c.id = m.ci_id LEFT JOIN ci_groups g ON g.id = m.group_id
     LEFT JOIN users u ON u.id = m.created_by
     ${includePast ? '' : 'WHERE m.ends_at > now()'} ORDER BY m.starts_at LIMIT 500`,
  );
  return rows;
}

export async function addMaintenance(user: User, input: z.infer<typeof maintenanceSchema>) {
  authorize(user, 'ci.manage');
  if (new Date(input.ends_at) <= new Date(input.starts_at)) throw badRequest('The window must end after it starts');
  // Resolve the covered CIs now: the CI (and its dependencies), or the group's manual and rule-matched members.
  let covered: number[];
  let target: { ci_id: number | null; group_id: number | null; label: string };
  if (input.ci) {
    const { rows: ci } = await query('SELECT id, ref FROM configuration_items WHERE ref = $1', [input.ci.toUpperCase()]);
    if (!ci[0]) throw notFound(`${input.ci} not found`);
    covered = [ci[0].id];
    if (input.include_dependencies) {
      const deps = await computeImpact(null, ci[0].ref, impactSchema.parse({ direction: 'down' }));
      if (deps.truncated) throw badRequest('Too many dependencies to cover in one window; use a CI group instead');
      const { rows } = await query('SELECT id FROM configuration_items WHERE ref = ANY($1)', [deps.nodes.map((n) => n.ref)]);
      covered.push(...rows.map((r) => r.id));
    }
    target = { ci_id: ci[0].id, group_id: null, label: ci[0].ref };
  } else {
    const group = await getGroup(user, input.group_id!);
    if (group.truncated) throw badRequest('The group is too large for one maintenance window');
    const { rows } = await query('SELECT id FROM configuration_items WHERE ref = ANY($1)', [group.members.map((m: any) => m.ref)]);
    covered = rows.map((r) => r.id);
    target = { ci_id: null, group_id: group.id, label: `group ${group.name}` };
  }
  const id = await tx(async (db) => {
    const { rows } = await db.query(
      'INSERT INTO maintenance_windows (ci_id, group_id, include_dependencies, starts_at, ends_at, reason, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [target.ci_id, target.group_id, input.include_dependencies, input.starts_at, input.ends_at, input.reason, user.id],
    );
    await db.query('INSERT INTO maintenance_window_cis (window_id, ci_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING', [rows[0].id, [...new Set(covered)]]);
    await audit(db, { entity_type: 'maintenance_window', entity_ref: String(rows[0].id), action: 'create', changes: { ...input, target: target.label, covered_cis: covered.length } });
    return rows[0].id as number;
  });
  return { id, covered_cis: new Set(covered).size };
}

export async function deleteMaintenance(user: User, id: number) {
  authorize(user, 'ci.manage');
  const { rows } = await query('DELETE FROM maintenance_windows WHERE id = $1 RETURNING id', [id]);
  if (!rows[0]) throw notFound('Maintenance window not found');
  await audit(null, { entity_type: 'maintenance_window', entity_ref: String(id), action: 'delete', changes: {} });
}

// ---- Processing --------------------------------------------------------------------------------

async function resolveCi(db: Db, e: NormalisedEvent, ciSourceSystem: string): Promise<CiFacts | null> {
  const cols = 'c.id, c.ref, c.name, c.ci_type, c.environment, c.criticality, c.status';
  if (e.ci) {
    const { rows } = await db.query(`SELECT ${cols} FROM configuration_items c WHERE c.ref = $1`, [e.ci.toUpperCase()]);
    if (rows[0]) return rows[0];
  }
  const sourceId = e.ci_source_id ?? e.host;
  if (sourceId && ciSourceSystem) {
    const { rows } = await db.query(
      `SELECT ${cols} FROM ci_sources s JOIN configuration_items c ON c.id = s.ci_id WHERE s.source_system = $1 AND lower(s.source_id) = lower($2) LIMIT 1`,
      [ciSourceSystem, sourceId],
    );
    if (rows[0]) return rows[0];
  }
  if (e.host) {
    // A name, FQDN, IP or short host name that identifies exactly one current CI.
    const host = e.host.toLowerCase();
    const { rows } = await db.query(
      `SELECT ${cols} FROM configuration_items c
       WHERE c.status <> 'retired' AND (lower(c.name) = $1 OR lower(c.attributes->>'fqdn') = $1 OR c.attributes->>'ip' = $1 OR lower(c.name) = split_part($1, '.', 1))
       LIMIT 2`,
      [host],
    );
    if (rows.length === 1) return rows[0];
  }
  return null;
}

async function suppressionFor(db: Db, ci: CiFacts | null) {
  if (!ci) return '';
  if (ci.status === 'maintenance') return `${ci.ref} is in maintenance`;
  const { rows } = await db.query(
    `SELECT m.reason FROM maintenance_window_cis x JOIN maintenance_windows m ON m.id = x.window_id
     WHERE x.ci_id = $1 AND now() BETWEEN m.starts_at AND m.ends_at LIMIT 1`,
    [ci.id],
  );
  return rows[0] ? `Maintenance window${rows[0].reason ? `: ${rows[0].reason}` : ''}` : '';
}

async function groupKeyFor(rule: Rule, alert: { dedupe_ci: string }, ci: CiFacts | null) {
  if (rule.group_by === 'rule') return 'rule';
  if (rule.group_by === 'ci' || !ci) return alert.dedupe_ci;
  // Alerts on CIs behind the same (most critical) service become one incident: a host failing takes many VMs down.
  const impact = await computeImpact(null, ci.ref, impactSchema.parse({ direction: 'up', max_depth: 10 }));
  const top = impact.services[0];
  return top ? `service:${top.ref}` : alert.dedupe_ci;
}

/** Opens or groups an incident for the alert under the rule; serialised per rule so concurrent alerts agree. */
async function applyRule(db: Db, rule: Rule, alert: any, ci: CiFacts | null) {
  const groupKey = await groupKeyFor(rule, alert, ci);
  await db.query('SELECT pg_advisory_xact_lock(8301, $1)', [rule.id]);
  const attach = async (inc: { id: number; ref: string }, note: string) => {
    await db.query('UPDATE alerts SET incident_id = $2, rule_id = $3 WHERE id = $1', [alert.id, inc.id, rule.id]);
    if (ci) await db.query('INSERT INTO incident_cis (incident_id, ci_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [inc.id, ci.id]);
    await logIncident(db, inc.id, null, 'link', note, { kind: 'event', alert_id: alert.id, check: alert.check_key, ci: ci?.ref ?? null });
    return { incident: inc.ref, action: 'grouped' as const };
  };
  const security = alert.source === SECURITY_SOURCE;
  const label = security ? alert.check_key : `${alert.check_key} on ${ci?.name ?? (alert.ci_hint || 'unknown host')}`;
  // 1. An open incident for the same group: group into it.
  const { rows: open } = await db.query(
    `SELECT id, ref FROM incidents WHERE event_rule_id = $1 AND event_group_key = $2 AND status NOT IN ('resolved', 'closed') ORDER BY created_at DESC LIMIT 1`,
    [rule.id, groupKey],
  );
  if (open[0]) return attach(open[0], `Alert grouped: ${label}`);
  // 2. Recently auto-resolved for the same group (flapping): reopen it instead of opening another incident.
  const { rows: recent } = await db.query(
    `SELECT id, ref FROM incidents WHERE event_rule_id = $1 AND event_group_key = $2 AND status = 'resolved' AND resolved_at > now() - $3 * interval '1 minute'
     ORDER BY resolved_at DESC LIMIT 1`,
    [rule.id, groupKey, rule.group_window_minutes],
  );
  if (recent[0]) {
    await db.query("UPDATE incidents SET status = 'in_progress', resolved_at = NULL, reopen_count = reopen_count + 1 WHERE id = $1", [recent[0].id]);
    await slaOnTransition(db, recent[0].id, 'in_progress');
    await logIncident(db, recent[0].id, null, 'status', `Reopened: ${label} fired again`, { from: 'resolved', to: 'in_progress', alert_id: alert.id });
    return { ...(await attach(recent[0], `Alert fired again: ${label}`)), action: 'reopened' as const };
  }
  // 3. Storm protection: at most max_incidents_per_hour new incidents per rule; beyond that, group into the latest.
  const { rows: made } = await db.query("SELECT count(*)::int AS n FROM incidents WHERE event_rule_id = $1 AND created_at > now() - interval '1 hour'", [rule.id]);
  if (made[0].n >= rule.max_incidents_per_hour) {
    const { rows: latest } = await db.query(
      "SELECT id, ref FROM incidents WHERE event_rule_id = $1 AND status NOT IN ('resolved', 'closed') ORDER BY created_at DESC LIMIT 1",
      [rule.id],
    );
    if (latest[0]) return attach(latest[0], `Alert grouped (rule limit of ${rule.max_incidents_per_hour} incidents/hour reached): ${label}`);
    await db.query("UPDATE alerts SET suppressed = 'Rule incident limit reached', rule_id = $2 WHERE id = $1", [alert.id, rule.id]);
    return { incident: null, action: 'rate_limited' as const };
  }
  // 4. A new incident. Title and description come from monitoring data: stored as data like any user text.
  // A security incident is in the Security category and restricted to its team (ADR 0002) whatever the rule says.
  const securityCategory = security ? (await db.query("SELECT id FROM categories WHERE name = 'Security'")).rows[0]?.id : undefined;
  const created = await insertIncident(
    db,
    null,
    {
      title: `${alert.severity[0].toUpperCase()}${alert.severity.slice(1)}: ${label}`.slice(0, 300),
      description: [alert.message, `Source: ${alert.source}`, alert.source_url ? `Alert: ${alert.source_url}` : '', `Opened by event rule "${rule.name}".`].filter(Boolean).join('\n\n'),
      impact: rule.impact,
      urgency: rule.urgency,
      ...(rule.team_id ? { team_id: rule.team_id } : { assignment_group: rule.assignment_group }),
      ...(securityCategory ? { category_id: securityCategory } : {}),
    },
    ci ? [ci.id] : [],
    'event',
    { event_rule_id: rule.id, event_group_key: groupKey, ...(security ? { restricted: true } : {}) },
  );
  if (security) await db.query("UPDATE incidents SET restricted_teams = CASE WHEN team_id IS NULL THEN '{}' ELSE ARRAY[team_id] END WHERE id = $1", [created.id]);
  await db.query('UPDATE alerts SET incident_id = $2, rule_id = $3 WHERE id = $1', [alert.id, created.id, rule.id]);
  return { incident: created.ref, action: 'created' as const };
}

export interface EventResult { check: string; outcome: string; alert_id?: number; incident?: string | null }

/** Processes normalised events from one source; each event in its own transaction. */
export async function processEvents(source: string, ciSourceSystem: string, events: NormalisedEvent[], internal = false): Promise<EventResult[]> {
  if (isReservedSource(source) && !internal) return events.map((e) => ({ check: e.check, outcome: 'error', error: `"${SECURITY_SOURCE}" is reserved for Kernel's own security alerts` }) as EventResult);
  const settings = await retention();
  const { rows: rules } = await query('SELECT * FROM event_rules WHERE enabled ORDER BY position, id');
  const results: EventResult[] = [];
  for (const e of events) {
    try {
      results.push(await tx((db) => processOne(db, source, ciSourceSystem, e, settings, rules)));
    } catch (err: any) {
      if (!err.statusCode) logger.error({ err, source, check: e.check }, 'event processing failed');
      results.push({ check: e.check, outcome: 'error', ...(err.statusCode ? { error: err.message } : {}) } as EventResult);
    }
  }
  return results;
}

async function processOne(db: Db, source: string, ciSourceSystem: string, e: NormalisedEvent, settings: Retention, rules: Rule[]): Promise<EventResult> {
  const at = e.occurred_at ? new Date(e.occurred_at) : new Date();
  if (at.getTime() > Date.now() + 5 * 60_000) throw badRequest('occurred_at is in the future');
  const ci = await resolveCi(db, e, ciSourceSystem);
  const hint = ci ? '' : (e.host ?? '').toLowerCase().slice(0, 255);
  const identity = [source, ci ? `ci:${ci.id}` : hint ? `host:${hint}` : '-', e.check];
  const message = e.message.slice(0, 2000);
  const record = async (alertId: number | null, outcome: string, suppressed = false) => {
    await db.query('INSERT INTO events (alert_id, source, source_event_id, severity, message, occurred_at, outcome) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      alertId, source, e.source_event_id ?? '', e.severity, message, at, outcome,
    ]);
    await db.query(
      // Suppressed (maintenance) events are also counted apart, so trends can leave planned work out (#31).
      `INSERT INTO event_daily (day, source, ci_id, severity, count, suppressed) VALUES ($1::timestamptz::date, $2, $3, $4, 1, $5)
       ON CONFLICT (day, source, ci_id, severity) DO UPDATE SET count = event_daily.count + 1, suppressed = event_daily.suppressed + excluded.suppressed`,
      [at, source, ci?.id ?? 0, e.severity, suppressed ? 1 : 0],
    );
  };

  if (e.severity === 'clear') {
    // A clear closes the open alert, unless it is older than the alert's last state change (replayed or late).
    const { rows } = await db.query(
      `UPDATE alerts SET status = 'closed', cleared_at = $4, state_at = $4, last_seen = greatest(last_seen, $4)
       WHERE source = $1 AND dedupe_ci = $2 AND check_key = $3 AND status = 'open' AND state_at <= $4 RETURNING id`,
      [...identity, at],
    );
    await record(rows[0]?.id ?? null, rows[0] ? 'cleared' : 'ignored');
    return { check: e.check, outcome: rows[0] ? 'cleared' : 'ignored', alert_id: rows[0]?.id };
  }

  // A firing event older than the latest state change of this identity is stale (replay or out of order).
  const { rows: latest } = await db.query(
    'SELECT id, status, state_at, cleared_at FROM alerts WHERE source = $1 AND dedupe_ci = $2 AND check_key = $3 ORDER BY id DESC LIMIT 1',
    identity,
  );
  const last = latest[0];
  if (last && last.status === 'closed' && last.cleared_at >= at) {
    await record(last.id, 'stale');
    return { check: e.check, outcome: 'stale', alert_id: last.id };
  }

  let alert: any;
  let fresh = false;
  // Flapping: it fired again shortly after clearing – reopen that alert instead of starting a new one.
  if (last && last.status === 'closed' && last.cleared_at > new Date(Date.now() - settings.reopen_window_minutes * 60_000)) {
    await db.query('SAVEPOINT reopen');
    try {
      const { rows } = await db.query(
        `UPDATE alerts SET status = 'open', flap_count = flap_count + 1, count = count + 1, cleared_at = NULL, state_at = $2, last_seen = $2,
                severity = $3, message = $4 WHERE id = $1 AND status = 'closed' RETURNING *`,
        [last.id, at, e.severity, message],
      );
      alert = rows[0];
      fresh = !!alert;
      await db.query('RELEASE SAVEPOINT reopen');
    } catch (err: any) {
      if (err.code !== '23505') throw err;
      await db.query('ROLLBACK TO SAVEPOINT reopen'); // someone opened a new one concurrently: fall through and count it
    }
  }
  if (!alert) {
    const { rows } = await db.query(
      `INSERT INTO alerts (source, ci_id, ci_hint, dedupe_ci, check_key, severity, message, source_url, first_seen, last_seen, state_at)
       VALUES ($1, $4, $5, $2, $3, $6, $7, $8, $9, $9, $9)
       ON CONFLICT (source, dedupe_ci, check_key) WHERE status = 'open' DO UPDATE SET
         count = alerts.count + 1,
         last_seen = greatest(alerts.last_seen, excluded.last_seen),
         severity = CASE WHEN excluded.state_at >= alerts.state_at THEN excluded.severity ELSE alerts.severity END,
         message = CASE WHEN excluded.state_at >= alerts.state_at THEN excluded.message ELSE alerts.message END,
         source_url = coalesce(nullif(excluded.source_url, ''), alerts.source_url),
         state_at = greatest(alerts.state_at, excluded.state_at)
       RETURNING *, (xmax = 0) AS inserted`,
      [...identity, ci?.id ?? null, hint, e.severity, message, e.url ?? '', at],
    );
    alert = rows[0];
    fresh = alert.inserted;
  }
  alert.ci_hint = hint;

  let outcome = fresh ? (alert.flap_count > 0 && !alert.inserted ? 'reopened' : 'opened') : 'deduplicated';
  let incident: string | null = null;
  if (fresh) {
    const suppressed = e.maintenance ? `Maintenance in ${source}` : await suppressionFor(db, ci);
    await db.query('UPDATE alerts SET suppressed = $2 WHERE id = $1', [alert.id, suppressed]);
    alert.suppressed = suppressed;
    if (suppressed) outcome = 'suppressed';
  }
  // Rules: for a new alert, or when a repeating alert reaches a rule's min_count; never twice for one alert.
  const hasIncident = alert.incident_id && (await db.query("SELECT 1 FROM incidents WHERE id = $1 AND status NOT IN ('resolved', 'closed')", [alert.incident_id])).rows[0];
  if (fresh && hasIncident) {
    await logIncident(db, alert.incident_id, null, 'link', `Alert fired again: ${e.check}`, { kind: 'event', alert_id: alert.id });
  }
  // Rules only open incidents while the incident module is on (#36); alerts are still recorded.
  if (!alert.suppressed && !hasIncident && moduleEnabled('incident')) {
    const facts: AlertFacts = { severity: alert.severity, source, check_key: e.check, count: alert.count, ci };
    // Security alerts never fall into a catch-all rule: only a rule that names their source may open an incident.
    const rule = rules.find((r) => ruleMatches(r.conditions, facts) && (source !== SECURITY_SOURCE || !!r.conditions.sources?.includes(SECURITY_SOURCE)));
    if (rule) {
      const applied = await applyRule(db, rule, alert, ci);
      incident = applied.incident;
      outcome = applied.action === 'created' ? 'incident_created' : applied.action === 'rate_limited' ? 'rate_limited' : `incident_${applied.action}`;
    }
  }
  await record(alert.id, outcome, !!alert.suppressed);
  return { check: e.check, outcome, alert_id: Number(alert.id), incident };
}

// ---- Background work ---------------------------------------------------------------------------

/** Resolves rule incidents whose alerts all stayed clear for the rule's hold-down period. */
export async function autoResolveIncidents() {
  const { rows } = await query(
    `SELECT i.id, i.ref, i.status FROM incidents i JOIN event_rules r ON r.id = i.event_rule_id
     WHERE r.auto_resolve AND i.status IN ('new', 'in_progress')
       AND EXISTS (SELECT 1 FROM alerts a WHERE a.incident_id = i.id)
       AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.incident_id = i.id AND (a.status = 'open' OR a.cleared_at > now() - r.hold_down_minutes * interval '1 minute'))`,
  );
  for (const i of rows) {
    await tx(async (db) => {
      const { rowCount } = await db.query(
        `UPDATE incidents SET status = 'resolved', resolution_code = 'fixed', resolution = 'All alerts cleared in monitoring.', resolved_at = now(),
                responded_at = coalesce(responded_at, now()) WHERE id = $1 AND status IN ('new', 'in_progress')`,
        [i.id],
      );
      if (rowCount) {
        await slaOnTransition(db, i.id, 'resolved');
        await logIncident(db, i.id, null, 'status', 'All alerts cleared', { from: i.status, to: 'resolved', resolution_code: 'fixed' });
      }
    });
  }
  return rows.length;
}

/** Retention: raw events after raw_days, closed alerts after closed_alert_days; daily aggregates are kept. */
export async function purgeEvents() {
  const r = await retention();
  const events = await query("DELETE FROM events WHERE received_at < now() - $1 * interval '1 day'", [r.raw_days]);
  const alerts = await query("DELETE FROM alerts WHERE status = 'closed' AND cleared_at < now() - $1 * interval '1 day' AND incident_id IS NULL AND problem_id IS NULL", [r.closed_alert_days]);
  await query("DELETE FROM event_hook_messages WHERE received_at < now() - interval '1 hour'");
  return { events: events.rowCount ?? 0, alerts: alerts.rowCount ?? 0 };
}

export function startEventWorker(log: (msg: string) => void) {
  setInterval(() => moduleEnabled('event') && moduleEnabled('incident') && autoResolveIncidents().catch((err) => log(`event auto-resolve failed: ${err.message}`)), 60_000).unref();
  setInterval(() => purgeEvents().catch((err) => log(`event purge failed: ${err.message}`)), 3600_000).unref();
}

// ---- Reading -----------------------------------------------------------------------------------

export const listAlertsSchema = z.object({
  status: z.enum(['open', 'closed', 'all']).default('open'),
  min_severity: z.enum(SEVERITIES).optional(),
  source: z.string().max(100).optional(),
  ci: z.string().max(30).optional(),
  q: z.string().max(200).optional(),
  suppressed: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  id: z.coerce.number().int().optional(),
});

export async function listAlerts(user: User, f: z.infer<typeof listAlertsSchema>) {
  authorize(user, 'event.read');
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (f.id) add('a.id = ?', f.id);
  // Security alerts name accounts and addresses: administrators only (#64).
  if (!can(user.role, 'security.read')) add('a.source <> ?', SECURITY_SOURCE);
  if (f.status !== 'all') add('a.status = ?', f.status);
  if (f.min_severity) add(`a.severity = ANY(?)`, SEVERITIES.slice(SEVERITIES.indexOf(f.min_severity)));
  if (f.source) add('a.source = ?', f.source);
  if (f.ci) add('c.ref = ?', f.ci.toUpperCase());
  if (f.q) add("(a.check_key ILIKE '%' || ? || '%' OR a.ci_hint ILIKE '%' || ? || '%' OR c.name ILIKE '%' || ? || '%')", f.q.replace(/[\\%_]/g, (m) => '\\' + m));
  if (f.suppressed === true) where.push("a.suppressed <> ''");
  if (f.suppressed === false) where.push("a.suppressed = ''");
  params.push(f.limit);
  const { rows } = await query(
    `SELECT a.id, a.source, a.check_key, a.severity, a.status, a.message, a.source_url, a.count, a.flap_count, a.first_seen, a.last_seen,
            a.cleared_at, a.suppressed, a.ci_hint, c.ref AS ci_ref, c.name AS ci_name, i.ref AS incident_ref, i.status AS incident_status,
            u.display_name AS acknowledged_by, a.acknowledged_at, r.name AS rule
     FROM alerts a LEFT JOIN configuration_items c ON c.id = a.ci_id LEFT JOIN incidents i ON i.id = a.incident_id
     LEFT JOIN users u ON u.id = a.acknowledged_by LEFT JOIN event_rules r ON r.id = a.rule_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY a.status = 'closed', array_position(ARRAY['critical','major','minor','warning','info'], a.severity), a.last_seen DESC
     LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({ ...r, flapping: r.flap_count >= 3 }));
}

export async function getAlert(user: User, id: number) {
  authorize(user, 'event.read');
  const [alert] = await listAlerts(user, listAlertsSchema.parse({ status: 'all', id, limit: 1 }));
  if (!alert) throw notFound('Alert not found');
  const { rows } = await query('SELECT severity, message, occurred_at, received_at, outcome FROM events WHERE alert_id = $1 ORDER BY occurred_at DESC LIMIT 100', [id]);
  return { ...alert, events: rows };
}

export async function acknowledgeAlert(user: User, id: number) {
  authorize(user, 'event.ack');
  const { rows } = await query('UPDATE alerts SET acknowledged_by = $2, acknowledged_at = now() WHERE id = $1 AND acknowledged_at IS NULL AND (source <> $3 OR $4) RETURNING id, check_key', [id, user.id, SECURITY_SOURCE, can(user.role, 'security.read')]);
  if (!rows[0]) throw conflict('Alert not found or already acknowledged');
  await audit(null, { entity_type: 'alert', entity_ref: String(id), action: 'acknowledge', changes: { check: rows[0].check_key } });
  return { ok: true };
}

/** Closes an alert by hand (the source said nothing more, or it was noise); a new event for it opens it again. */
export async function closeAlert(user: User, id: number) {
  authorize(user, 'event.ack');
  const { rows } = await query("UPDATE alerts SET status = 'closed', cleared_at = now(), state_at = now() WHERE id = $1 AND status <> 'closed' AND (source <> $2 OR $3) RETURNING id, check_key", [id, SECURITY_SOURCE, can(user.role, 'security.read')]);
  if (!rows[0]) throw conflict('Alert not found or already closed');
  await audit(null, { entity_type: 'alert', entity_ref: String(id), action: 'close', changes: { check: rows[0].check_key } });
  return { ok: true };
}

export async function reportEvents(user: User, input: z.infer<typeof reportEventsSchema>) {
  authorize(user, 'event.ingest');
  if (isReservedSource(input.source)) throw badRequest(`"${SECURITY_SOURCE}" is reserved for Kernel's own security alerts`);
  const results = await processEvents(input.source, '', input.events);
  return { accepted: results.filter((r) => r.outcome !== 'error').length, results };
}

registerCiExtra(async (ciId) => {
  const { rows } = await query(
    `SELECT a.id, a.source, a.check_key, a.severity, a.status, a.count, a.flap_count, a.last_seen, a.suppressed, i.ref AS incident_ref
     FROM alerts a LEFT JOIN incidents i ON i.id = a.incident_id WHERE a.ci_id = $1 ORDER BY a.status = 'closed', a.last_seen DESC LIMIT 25`,
    [ciId],
  );
  const { rows: windows } = await query(
    `SELECT m.id, m.starts_at, m.ends_at, m.reason FROM maintenance_window_cis x JOIN maintenance_windows m ON m.id = x.window_id
     WHERE x.ci_id = $1 AND m.ends_at > now() ORDER BY m.starts_at`,
    [ciId],
  );
  return { alerts: rows, maintenance_windows: windows };
});
