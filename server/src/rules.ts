// Automation rules (#49): "when an incident is created, if service is Payroll, assign to team HR-Systems". One small
// engine for incidents, problems, changes and requests, declarative only: a rule is JSON checked against allowlists
// (the fields a condition may read, the actions it may take), never an expression, script or template that runs.
//
// - A change queues runs in its own transaction (rule-queue.ts); the worker here runs them after commit with a lease,
//   so a rule never makes a person's save fail.
// - A rule acts as the actor "rule:<id>" through the same service functions as people (validation, SLA,
//   notifications, the audit trail) with an analyst's permissions, so it can never do more than an analyst.
// - Loops stop: a chain is at most 3 rules deep, a rule fires at most once per record in 10 minutes, and a rule that
//   takes more than 50 actions in a minute is turned off (the circuit breaker) and its owner is told.
// - Time triggers ("resolved for 5 days", "an action is due within a day") are found by a scan every minute and queued
//   in the same rule_runs, once per record and window, so a reminder is never repeated.
// Event rules (#30) and candidate rules (#5/#31) stay where they are; the list shows them as their own sections.
import { z } from 'zod';
import { audit } from './audit.js';
import type { User } from './auth.js';
import { contextStore, currentContext, type RequestContext } from './context.js';
import { query, tx } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { logger } from './log.js';
import { notify } from './notifications.js';
import { authorize, can } from './policy.js';
import { onRulesQueued, RULE_KINDS, type RuleKind } from './rule-queue.js';
import { moduleEnabled } from './modules.js';
import { audienceOf } from './audience.js';
import { config } from './config.js';
import { enqueueTo } from './webhooks.js';
import type { Db } from './problems.js';

export { RULE_KINDS, type RuleKind };

/** A chain of rules stops at this depth: a person's change, then at most 3 rules each set off by the one before. */
export const MAX_DEPTH = 3;
/** The same rule fires at most once per record in this window. */
const REFIRE_MINUTES = 10;
/** More actions than this in a minute turns a rule off. */
const MAX_ACTIONS_PER_MINUTE = 50;
/** The dry run looks at this many days of records, at most this many of them. */
const DRY_RUN_DAYS = 30;
const DRY_RUN_MAX = 2000;

// ---- The format ------------------------------------------------------------------------------

const STATUSES: Record<RuleKind, readonly string[]> = {
  incident: ['new', 'in_progress', 'on_hold', 'resolved', 'closed'],
  problem: ['new', 'analysis', 'known_error', 'resolved', 'closed'],
  change: ['draft', 'assess', 'authorize', 'scheduled', 'implementing', 'review', 'closed', 'rejected', 'cancelled'],
  request: ['submitted', 'awaiting_approval', 'in_fulfilment', 'fulfilled', 'rejected', 'cancelled'],
};
const SOURCES: Partial<Record<RuleKind, readonly string[]>> = {
  incident: ['user', 'event', 'api', 'mcp', 'email', 'portal'],
  change: ['user', 'api', 'mcp', 'pipeline'],
};

type FieldType = 'ci' | 'category' | 'team' | 'user' | 'priority' | 'enum' | 'bool';
const FIELD_TYPES: Record<string, FieldType> = {
  service: 'ci', ci: 'ci', priority: 'priority', category: 'category', team: 'team', assignee: 'user', status: 'enum', source: 'enum', caller_vip: 'bool', is_major: 'bool',
  requester_reopened: 'bool',
};
/** The structured fields a condition may read, per kind. Never free text. */
export const CONDITION_FIELDS: Record<RuleKind, readonly string[]> = {
  // requester_reopened: the caller said "still a problem" in the portal (#45) at some point.
  incident: ['service', 'ci', 'priority', 'category', 'team', 'assignee', 'status', 'caller_vip', 'source', 'is_major', 'requester_reopened'],
  problem: ['service', 'ci', 'priority', 'category', 'team', 'assignee', 'status', 'is_major'],
  change: ['service', 'ci', 'team', 'assignee', 'status', 'source'],
  request: ['service', 'priority', 'status', 'caller_vip'],
};
/** Who a notification can go to besides named people and teams: people the record itself names. */
export const NOTIFY_ROLES: Record<RuleKind, readonly string[]> = {
  incident: ['assignee', 'team_lead'],
  problem: ['assignee', 'team_lead', 'owner'],
  change: ['assignee', 'team_lead'],
  request: ['approvers'],
};
/** The kinds whose follow-ups have due dates (problem actions), for the due_in trigger. */
const DUE_KINDS: readonly RuleKind[] = ['problem'];
const OPERATORS: Record<FieldType, readonly string[]> = {
  ci: ['is', 'is_not', 'in', 'is_empty'],
  category: ['is', 'is_not', 'in', 'is_empty'],
  team: ['is', 'is_not', 'in', 'is_empty'],
  user: ['is', 'is_not', 'in', 'is_empty'],
  priority: ['is', 'is_not', 'in', 'gt', 'lt'],
  enum: ['is', 'is_not', 'in'],
  bool: ['is'],
};
/** The fields a change to which can set a rule off, per kind. */
export const TRIGGER_FIELDS: Record<RuleKind, readonly string[]> = {
  incident: ['priority', 'category', 'team', 'assignee'],
  problem: ['priority', 'category', 'team', 'assignee'],
  change: ['team', 'assignee'],
  request: ['priority'],
};
/** What set_field may set, per kind. Never classification, restriction or text. */
export const SETTABLE: Record<RuleKind, readonly string[]> = {
  incident: ['priority', 'category', 'team', 'assignee'],
  problem: ['priority', 'category', 'team', 'assignee'],
  change: ['team', 'assignee'],
  request: ['priority'],
};
/** The only moves a rule may make: close what is resolved, take back what was on hold. */
export const TRANSITIONS: Partial<Record<RuleKind, Record<string, string>>> = { incident: { closed: 'resolved', in_progress: 'on_hold' } };

const scalar = z.union([z.string().trim().min(1).max(30), z.number().int(), z.boolean()]);
const conditionSchema = z.object({
  field: z.string().max(30),
  op: z.enum(['is', 'is_not', 'in', 'is_empty', 'gt', 'lt']),
  value: z.union([scalar, z.array(scalar).min(1).max(50)]).optional(),
}).strict();
const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('created') }).strict(),
  z.object({ type: z.literal('field_changed'), field: z.string().max(30) }).strict(),
  z.object({ type: z.literal('status_changed'), to: z.string().max(30).optional() }).strict(),
  // Time triggers: in a status for a while (from 15 minutes to a year), or a follow-up action due within a while.
  z.object({ type: z.literal('in_status_for'), status: z.string().max(30), hours: z.number().min(0.25).max(8760).multipleOf(0.25) }).strict(),
  z.object({ type: z.literal('due_in'), hours: z.number().min(1).max(720).int() }).strict(),
]);
const id = z.number().int().positive();
const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_field'), field: z.string().max(30), value: z.number().int().nullable() }).strict(),
  z.object({ type: z.literal('assign_team'), team_id: id }).strict(),
  // An internal note in the rule author's fixed words, never a reply to the requester.
  z.object({ type: z.literal('add_comment'), text: z.string().trim().min(1).max(2000) }).strict(),
  z.object({
    type: z.literal('notify'), users: z.array(id).max(20).default([]), teams: z.array(id).max(10).default([]),
    roles: z.array(z.enum(['assignee', 'team_lead', 'approvers', 'owner'])).max(4).default([]),
  }).strict().refine((a) => a.users.length + a.teams.length + a.roles.length > 0, 'Say who to notify'),
  z.object({ type: z.literal('transition'), to: z.string().max(30) }).strict(),
  // Only to an outgoing webhook an administrator has already set up (#11): signed, retried, SSRF-safe.
  z.object({ type: z.literal('webhook'), webhook_id: id }).strict(),
]);
export const ruleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(RULE_KINDS),
  trigger: triggerSchema,
  conditions: z.array(conditionSchema).max(10).default([]),
  actions: z.array(actionSchema).min(1).max(10),
}).strict();
export type RuleInput = z.infer<typeof ruleSchema>;
type Condition = z.infer<typeof conditionSchema>;
type RuleAction = z.infer<typeof actionSchema>;

export const enableSchema = z.object({ enabled: z.boolean() });
export const dryRunSchema = z.union([z.object({ id }).strict(), ruleSchema]);

/** Checks a rule against the allowlists of its kind; zod has already checked the shape. Throws 400 with what is wrong. */
function checkAllowed(r: RuleInput) {
  const fail = (msg: string) => { throw badRequest(msg); };
  const kind = r.kind;
  if (r.trigger.type === 'field_changed' && !TRIGGER_FIELDS[kind].includes(r.trigger.field)) fail(`A ${kind} rule cannot start when ${r.trigger.field} changes. Choose one of: ${TRIGGER_FIELDS[kind].join(', ')}`);
  if (r.trigger.type === 'status_changed' && r.trigger.to !== undefined && !STATUSES[kind].includes(r.trigger.to)) fail(`A ${kind} has no status ${r.trigger.to}`);
  if (r.trigger.type === 'in_status_for' && !STATUSES[kind].includes(r.trigger.status)) fail(`A ${kind} has no status ${r.trigger.status}`);
  if (r.trigger.type === 'due_in' && !DUE_KINDS.includes(kind)) fail(`Only ${DUE_KINDS.join(', ')} rules can start from a due date (follow-up actions)`);
  for (const c of r.conditions) {
    if (!CONDITION_FIELDS[kind].includes(c.field)) fail(`A ${kind} rule cannot check ${c.field}. It can check: ${CONDITION_FIELDS[kind].join(', ')}`);
    const type = FIELD_TYPES[c.field];
    if (!OPERATORS[type].includes(c.op)) fail(`${c.field} cannot be compared with "${c.op}"`);
    if (c.op === 'is_empty') {
      if (c.value !== undefined) fail(`"is empty" takes no value (${c.field})`);
      continue;
    }
    if (c.value === undefined) fail(`Give a value for ${c.field}`);
    const values = Array.isArray(c.value) ? c.value : [c.value];
    if ((c.op === 'in') !== Array.isArray(c.value)) fail(c.op === 'in' ? `"in" takes a list (${c.field})` : `"${c.op}" takes one value (${c.field})`);
    for (const v of values) {
      const ok = type === 'ci' ? typeof v === 'string'
        : type === 'bool' ? typeof v === 'boolean'
          : type === 'enum' ? typeof v === 'string' && (c.field === 'status' ? STATUSES[kind] : SOURCES[kind] ?? []).includes(v)
            : type === 'priority' ? typeof v === 'number' && v >= 1 && v <= 5
              : typeof v === 'number';
      if (!ok) fail(`${JSON.stringify(v)} is not a ${c.field}`);
    }
  }
  for (const a of r.actions) {
    if (a.type === 'set_field') {
      if (!SETTABLE[kind].includes(a.field)) fail(`A rule cannot set ${a.field} on a ${kind}. It can set: ${SETTABLE[kind].join(', ')}`);
      if (a.field === 'priority' && (a.value === null || a.value < 1 || a.value > 5)) fail('Priority is 1 to 5');
      if (a.field === 'team' && a.value === null) fail('Choose a team');
    }
    if (a.type === 'assign_team' && !SETTABLE[kind].includes('team')) fail(`A ${kind} has no team`);
    if (a.type === 'notify') {
      for (const role of a.roles) {
        if (!NOTIFY_ROLES[kind].includes(role)) fail(`A ${kind} has no ${role.replace('_', ' ')} to notify`);
        if (role === 'owner' && r.trigger.type !== 'due_in') fail('The owner is the owner of the action that is due: only with a due date trigger');
      }
    }
    if (a.type === 'transition' && TRANSITIONS[kind]?.[a.to] === undefined) {
      fail(kind === 'incident' ? 'A rule can only close a resolved incident or take one back from on hold' : `A rule cannot move a ${kind}`);
    }
  }
}

/** The teams, people, categories and CIs a rule names exist and can be used. */
async function checkRefs(r: RuleInput) {
  const teams = new Set<number>(), users = new Set<number>(), categories = new Set<number>(), cis = new Set<string>();
  for (const c of r.conditions) {
    const values = c.value === undefined ? [] : Array.isArray(c.value) ? c.value : [c.value];
    const type = FIELD_TYPES[c.field];
    for (const v of values) {
      if (type === 'team') teams.add(v as number);
      if (type === 'user') users.add(v as number);
      if (type === 'category') categories.add(v as number);
      if (type === 'ci') cis.add(String(v).toUpperCase());
    }
  }
  for (const a of r.actions) {
    if (a.type === 'assign_team') teams.add(a.team_id);
    if (a.type === 'set_field' && a.value !== null && a.field !== 'priority') ({ team: teams, assignee: users, category: categories } as Record<string, Set<number>>)[a.field].add(a.value);
    if (a.type === 'notify') {
      a.users.forEach((u) => users.add(u));
      a.teams.forEach((t) => teams.add(t));
    }
  }
  const missing = async (sql: string, ids: unknown[]) => {
    if (!ids.length) return [];
    const { rows } = await query(sql, [ids]);
    const found = new Set(rows.map((x) => String(x.id)));
    return ids.filter((v) => !found.has(String(v)));
  };
  const t = await missing('SELECT id FROM teams WHERE id = ANY($1) AND active', [...teams]);
  if (t.length) throw badRequest(`No such team: ${t.join(', ')}`);
  const u = await missing("SELECT id FROM users WHERE id = ANY($1) AND active AND role NOT IN ('integration')", [...users]);
  if (u.length) throw badRequest(`No such person: ${u.join(', ')}`);
  const c = await missing('SELECT id FROM categories WHERE id = ANY($1)', [...categories]);
  if (c.length) throw badRequest(`No such category: ${c.join(', ')}`);
  const ci = await missing('SELECT ref AS id FROM configuration_items WHERE ref = ANY($1)', [...cis]);
  if (ci.length) throw badRequest(`No such CI or service: ${ci.join(', ')}`);
  const hooks = r.actions.flatMap((a) => (a.type === 'webhook' ? [a.webhook_id] : []));
  const w = await missing('SELECT id FROM webhooks WHERE id = ANY($1) AND active', hooks);
  if (w.length) throw badRequest(`No such active outgoing webhook: ${w.join(', ')}. An administrator sets webhooks up first.`);
}

/** CI refs are kept upper case, so a condition matches however it was typed. */
function normalised(r: RuleInput): RuleInput {
  const up = (v: unknown) => (typeof v === 'string' ? v.toUpperCase() : v);
  return {
    ...r,
    conditions: r.conditions.map((c) => (FIELD_TYPES[c.field] === 'ci' && c.value !== undefined ? { ...c, value: Array.isArray(c.value) ? c.value.map(up) : up(c.value) } as Condition : c)),
  };
}

// ---- What a condition reads ------------------------------------------------------------------

export interface Facts {
  ref: string;
  title: string;
  service: string[];
  ci: string[];
  priority: number | null;
  category: number | null;
  team: number | null;
  assignee: number | null;
  status: string;
  caller_vip: boolean;
  requester_reopened: boolean;
  source: string | null;
  is_major: boolean;
}

const CIS_OF: Record<RuleKind, string> = {
  incident: 'SELECT c.id, c.ref, c.class FROM incident_cis x JOIN configuration_items c ON c.id = x.ci_id WHERE x.incident_id = t.id',
  problem: 'SELECT c.id, c.ref, c.class FROM problem_cis x JOIN configuration_items c ON c.id = x.ci_id WHERE x.problem_id = t.id',
  change: 'SELECT c.id, c.ref, c.class FROM change_cis x JOIN configuration_items c ON c.id = x.ci_id WHERE x.change_id = t.id',
  request: 'SELECT c.id, c.ref, c.class FROM request_items i JOIN configuration_items c ON c.id = i.service_id WHERE i.id = t.item_id',
};
const FACTS: Record<RuleKind, string> = {
  incident: `t.priority, t.category_id AS category, t.team_id AS team, t.assignee_id AS assignee, t.source, t.is_major, coalesce(p.is_vip, false) AS caller_vip,
             EXISTS (SELECT 1 FROM incident_activity x WHERE x.incident_id = t.id AND x.kind = 'status' AND x.data->>'by_requester' = 'true' AND x.data->>'to' = 'in_progress') AS requester_reopened
             FROM incidents t LEFT JOIN people p ON p.id = t.caller_id`,
  problem: 't.priority, t.category_id AS category, t.team_id AS team, t.assignee_id AS assignee, NULL AS source, t.is_major, false AS caller_vip FROM problems t',
  change: 'NULL::int AS priority, NULL::int AS category, t.team_id AS team, t.assignee_id AS assignee, t.source, false AS is_major, false AS caller_vip FROM changes t',
  request: `t.priority, NULL::int AS category, NULL::int AS team, NULL::int AS assignee, NULL AS source, false AS is_major, coalesce(p.is_vip, false) AS caller_vip
            FROM requests t LEFT JOIN people p ON p.id = t.requester_id`,
};

/**
 * The services a set of CIs belong to: the services among them and those that depend on them through the CMDB, the
 * way an outage travels (as in impact analysis, at most 10 steps).
 */
async function servicesOf(ciIds: number[]): Promise<string[]> {
  if (!ciIds.length) return [];
  const { rows } = await query(
    `WITH RECURSIVE up(id, depth) AS (
       SELECT unnest($1::int[]), 0
       UNION
       SELECT CASE WHEN ty.propagation = 'forward' THEN r.from_ci ELSE r.to_ci END, up.depth + 1
       FROM ci_relationships r JOIN ci_relationship_types ty ON ty.name = r.type
       JOIN up ON up.id = CASE WHEN ty.propagation = 'forward' THEN r.to_ci ELSE r.from_ci END
       WHERE up.depth < 10
     )
     SELECT DISTINCT c.ref FROM configuration_items c WHERE c.id IN (SELECT id FROM up) AND c.class = 'service' ORDER BY 1`,
    [ciIds],
  );
  return rows.map((x) => x.ref);
}

/**
 * The facts of records of one kind, as the current viewer may see them (row-level security): the worker reads as the
 * system, a dry run as the rule's author. `withServices` walks the CMDB only when a condition needs it.
 */
async function factsOf(kind: RuleKind, where: { refs?: string[]; days?: number }, withServices: boolean): Promise<Facts[]> {
  const params: unknown[] = [];
  const filter = where.refs
    ? `t.ref = ANY($${params.push(where.refs)})`
    : `t.updated_at >= now() - $${params.push(where.days ?? DRY_RUN_DAYS)} * interval '1 day'`;
  const { rows } = await query(
    `SELECT t.ref, t.title, t.status, coalesce((SELECT json_agg(json_build_object('id', c.id, 'ref', c.ref, 'class', c.class)) FROM (${CIS_OF[kind]}) c), '[]') AS cis,
            ${FACTS[kind]}
     WHERE ${filter} ORDER BY t.updated_at DESC LIMIT ${DRY_RUN_MAX}`,
    params,
  );
  const out: Facts[] = [];
  for (const r of rows) {
    const cis = r.cis as { id: number; ref: string; class: string }[];
    out.push({
      ref: r.ref, title: r.title, ci: kind === 'request' ? [] : cis.filter((c) => c.class !== 'service').map((c) => c.ref),
      service: withServices ? (kind === 'request' ? cis.map((c) => c.ref) : await servicesOf(cis.map((c) => c.id))) : [],
      priority: r.priority, category: r.category, team: r.team, assignee: r.assignee, status: r.status, caller_vip: !!r.caller_vip, requester_reopened: !!r.requester_reopened, source: r.source, is_major: !!r.is_major,
    });
  }
  return out;
}

/** True when every condition holds (no conditions: always). */
export function matches(conditions: Condition[], f: Facts): boolean {
  return conditions.every((c) => {
    const actual = (f as unknown as Record<string, unknown>)[c.field];
    const list = Array.isArray(actual) ? actual : actual === null || actual === undefined ? [] : [actual];
    const values = c.value === undefined ? [] : Array.isArray(c.value) ? c.value : [c.value];
    switch (c.op) {
      case 'is_empty': return list.length === 0;
      case 'is': return list.includes(values[0]) || (typeof values[0] === 'boolean' && actual === values[0]);
      case 'is_not': return !list.includes(values[0]);
      case 'in': return values.some((v) => list.includes(v));
      case 'gt': return typeof actual === 'number' && actual > (values[0] as number);
      case 'lt': return typeof actual === 'number' && actual < (values[0] as number);
    }
  });
}

const needsServices = (conditions: Condition[]) => conditions.some((c) => c.field === 'service');

// ---- Managing rules --------------------------------------------------------------------------

const SELECT = `SELECT r.*, o.display_name AS owner, c.display_name AS created_by_name FROM automation_rules r
  LEFT JOIN users o ON o.id = r.owner_id LEFT JOIN users c ON c.id = r.created_by`;

const shape = (r: any) => ({
  id: r.id, name: r.name, kind: r.kind, trigger: r.trigger, conditions: r.conditions, actions: r.actions, enabled: r.enabled,
  proposed_by_agent: r.proposed_by_agent, recommended: r.recommended, owner_id: r.owner_id, owner: r.owner, created_by: r.created_by_name, tripped_at: r.tripped_at,
  created_at: r.created_at, updated_at: r.updated_at, sentence: describeRule(r),
});

/** All automation rules, and the other kinds of rules Kernel has, so there is one place to find them. */
export async function listRules(user: User) {
  authorize(user, 'rule.read');
  const { rows } = await query(
    `${SELECT.replace('SELECT r.*', `SELECT r.*, (SELECT count(*)::int FROM rule_runs x WHERE x.rule_id = r.id AND x.status = 'matched' AND x.finished_at > now() - interval '30 days') AS matched_30d,
       (SELECT count(*)::int FROM rule_runs x WHERE x.rule_id = r.id AND x.status = 'failed' AND x.finished_at > now() - interval '30 days') AS failed_30d,
       (SELECT max(finished_at) FROM rule_runs x WHERE x.rule_id = r.id AND x.status = 'matched') AS last_matched_at`)}
     ORDER BY r.recommended IS NOT NULL AND NOT r.enabled, r.kind, r.name`,
  );
  const others: { kind: string; label: string; count: number; enabled: number; path: string }[] = [];
  if (moduleEnabled('event') && can(user.role, 'event.read')) {
    const { rows: e } = await query('SELECT count(*)::int AS n, count(*) FILTER (WHERE enabled)::int AS on FROM event_rules');
    others.push({ kind: 'event', label: 'Event rules: which monitoring alerts open incidents', count: e[0].n, enabled: e[0].on, path: '/events?tab=rules' });
  }
  if (can(user.role, 'candidate.read')) {
    const { rows: c } = await query('SELECT count(*)::int AS n, count(*) FILTER (WHERE enabled)::int AS on FROM candidate_rules');
    others.push({ kind: 'candidate', label: 'Candidate rules: which patterns suggest a problem', count: c[0].n, enabled: c[0].on, path: '/candidates?tab=rules' });
  }
  const manage = can(user.role, 'rule.manage');
  // The outgoing webhooks a rule may send to, by name only, for those who write rules.
  const webhooks = manage ? (await query('SELECT id, name FROM webhooks WHERE active ORDER BY name')).rows : [];
  return { rules: rows.map((r) => ({ ...shape(r), matched_30d: r.matched_30d, failed_30d: r.failed_30d, last_matched_at: r.last_matched_at })), other_rules: others, can_manage: manage, webhooks };
}

/** A rule with its latest runs (only those on records the reader may see). */
export async function getRule(user: User, ruleId: number) {
  authorize(user, 'rule.read');
  const { rows } = await query(`${SELECT} WHERE r.id = $1`, [ruleId]);
  if (!rows[0]) throw notFound('No such rule');
  const { rows: runs } = await query(
    `SELECT id, record_ref, event, depth, status, detail, results, created_at, finished_at FROM rule_runs
     WHERE rule_id = $1 AND status NOT IN ('pending', 'running', 'not_matched') ORDER BY id DESC LIMIT 50`,
    [ruleId],
  );
  const { rows: stats } = await query(
    `SELECT count(*) FILTER (WHERE status = 'matched')::int AS matched, count(*) FILTER (WHERE status = 'not_matched')::int AS not_matched,
            count(*) FILTER (WHERE status = 'skipped')::int AS skipped, count(*) FILTER (WHERE status = 'failed')::int AS failed
     FROM rule_runs WHERE rule_id = $1 AND created_at > now() - interval '30 days'`,
    [ruleId],
  );
  return { ...shape(rows[0]), runs, stats_30d: stats[0] };
}

async function loadRule(db: Db, ruleId: number) {
  const { rows } = await db.query('SELECT * FROM automation_rules WHERE id = $1 FOR UPDATE', [ruleId]);
  if (!rows[0]) throw notFound('No such rule');
  return rows[0];
}

const fromAgent = () => currentContext().channel === 'mcp';

/** A person writes a rule; it starts disabled unless they say otherwise. */
export async function saveRule(user: User, ruleId: number | null, raw: unknown, enabled = false) {
  authorize(user, 'rule.manage');
  if (enabled) assertPersonEnables();
  const input = normalised(ruleSchema.parse(raw));
  checkAllowed(input);
  await checkRefs(input);
  const saved = await tx(async (db) => {
    const before = ruleId ? await loadRule(db, ruleId) : null;
    const { rows: dup } = await db.query('SELECT id FROM automation_rules WHERE lower(name) = lower($1) AND id <> coalesce($2, 0)', [input.name, ruleId]);
    if (dup[0]) throw conflict(`There is already a rule called ${input.name}`);
    const values = [input.name, input.kind, JSON.stringify(input.trigger), JSON.stringify(input.conditions), JSON.stringify(input.actions)];
    const { rows } = before
      ? await db.query(
        `UPDATE automation_rules SET name = $2, kind = $3, trigger = $4, conditions = $5, actions = $6, updated_at = now() WHERE id = $1 RETURNING *`,
        [ruleId, ...values],
      )
      : await db.query(
        `INSERT INTO automation_rules (name, kind, trigger, conditions, actions, enabled, owner_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
        [...values, enabled, user.id],
      );
    // Before and after, so every change to what a rule does can be traced.
    await audit(db, {
      entity_type: 'automation_rule', entity_ref: `#${rows[0].id}`, action: before ? 'update' : 'create',
      changes: { ...ruleFields(rows[0]), ...(before ? { before: ruleFields(before) } : {}) },
    });
    return rows[0];
  });
  return getRule(user, saved.id);
}

const ruleFields = (r: any) => ({ name: r.name, kind: r.kind, trigger: r.trigger, conditions: r.conditions, actions: r.actions, enabled: r.enabled });

/** Only a person enables a rule: never an agent, never a token. */
function assertPersonEnables() {
  const ctx = currentContext();
  if (ctx.actorType !== 'user') throw forbidden(ctx.channel === 'mcp' ? 'An agent cannot enable a rule. A person enables it in Kernel.' : 'Enable rules in Kernel, signed in as yourself.');
}

export async function setRuleEnabled(user: User, ruleId: number, enabled: boolean) {
  authorize(user, 'rule.manage');
  if (enabled) assertPersonEnables();
  await tx(async (db) => {
    const r = await loadRule(db, ruleId);
    if (r.enabled === enabled) return;
    if (enabled) {
      // A rule written before an allowlist changed must still pass it.
      const { enabled: _, ...fields } = ruleFields(r);
      const input = ruleSchema.parse(fields);
      checkAllowed(input);
      await checkRefs(input);
    }
    // Enabling makes the person who did it the owner: they hear if the circuit breaker turns it off.
    await db.query('UPDATE automation_rules SET enabled = $2, tripped_at = CASE WHEN $2 THEN NULL ELSE tripped_at END, owner_id = CASE WHEN $2 THEN $3 ELSE owner_id END, updated_at = now() WHERE id = $1', [ruleId, enabled, user.id]);
    await audit(db, { entity_type: 'automation_rule', entity_ref: `#${ruleId}`, action: enabled ? 'enable' : 'disable', changes: { name: r.name, enabled: { from: r.enabled, to: enabled } } });
  });
  return getRule(user, ruleId);
}

export async function deleteRule(user: User, ruleId: number) {
  authorize(user, 'rule.manage');
  await tx(async (db) => {
    const r = await loadRule(db, ruleId);
    await db.query('DELETE FROM automation_rules WHERE id = $1', [ruleId]);
    await audit(db, { entity_type: 'automation_rule', entity_ref: `#${ruleId}`, action: 'delete', changes: { before: ruleFields(r) } });
  });
  return { deleted: true };
}

/**
 * Proposes a rule (an agent over MCP, or someone without rule.manage): it lands disabled, marked as proposed, and a
 * person with rule.manage reads it and enables it.
 */
export async function proposeRule(user: User, raw: unknown) {
  authorize(user, 'rule.propose');
  const input = normalised(ruleSchema.parse(raw));
  checkAllowed(input);
  await checkRefs(input);
  const saved = await tx(async (db) => {
    const { rows: dup } = await db.query('SELECT id FROM automation_rules WHERE lower(name) = lower($1)', [input.name]);
    if (dup[0]) throw conflict(`There is already a rule called ${input.name}`);
    const { rows } = await db.query(
      `INSERT INTO automation_rules (name, kind, trigger, conditions, actions, enabled, proposed_by_agent, created_by) VALUES ($1, $2, $3, $4, $5, false, $6, $7) RETURNING *`,
      [input.name, input.kind, JSON.stringify(input.trigger), JSON.stringify(input.conditions), JSON.stringify(input.actions), fromAgent(), user.id],
    );
    await audit(db, { entity_type: 'automation_rule', entity_ref: `#${rows[0].id}`, action: 'propose', changes: ruleFields(rows[0]) });
    return rows[0];
  });
  return { ...(await getRule(user, saved.id)), note: 'Proposed and disabled. A problem manager reviews it and enables it in Kernel.' };
}

/**
 * Which recent records a rule's conditions match, read as the person asking (they only count what they may see).
 * Nothing is changed and no action runs.
 */
export async function dryRunRule(user: User, raw: unknown) {
  authorize(user, 'rule.read');
  const parsed = dryRunSchema.parse(raw);
  let input: RuleInput;
  if ('id' in parsed) {
    const { rows } = await query('SELECT * FROM automation_rules WHERE id = $1', [parsed.id]);
    if (!rows[0]) throw notFound('No such rule');
    const { enabled: _, ...fields } = ruleFields(rows[0]);
    input = ruleSchema.parse(fields);
  } else {
    input = normalised(parsed);
    checkAllowed(input);
    await checkRefs(input);
  }
  const facts = await factsOf(input.kind, { days: DRY_RUN_DAYS }, needsServices(input.conditions));
  const hits = facts.filter((f) => matches(input.conditions, f));
  return {
    days: DRY_RUN_DAYS,
    checked: facts.length,
    matched: hits.length,
    latest: hits.slice(0, 5).map((f) => ({ ref: f.ref, title: f.title })),
    note: `Checked against the ${input.kind}s updated in the last ${DRY_RUN_DAYS} days that you can see, as they are now. No actions ran.`,
  };
}

// ---- Plain sentences -------------------------------------------------------------------------

const words = (s: string) => s.replace(/_/g, ' ');
/** 0.25 → "15 minutes", 24 → "1 day", 120 → "5 days". */
export const duration = (hours: number) =>
  hours < 1 ? `${Math.round(hours * 60)} minutes` : hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hour${hours === 1 ? '' : 's'}`;
const OP_WORDS: Record<string, string> = { is: 'is', is_not: 'is not', in: 'is one of', is_empty: 'is empty', gt: 'is greater than', lt: 'is less than' };

/** "When an incident is created, if service is SVC000003, then assign to team #4" – names are resolved in the UI. */
export function describeRule(r: { kind: string; trigger: any; conditions: any[]; actions: any[] }) {
  const a = r.kind === 'incident' ? 'an incident' : `a ${r.kind}`;
  const when = r.trigger.type === 'created' ? `${a} is created`
    : r.trigger.type === 'field_changed' ? `the ${words(r.trigger.field)} of ${a} changes`
      : r.trigger.type === 'in_status_for' ? `${a} has been ${words(r.trigger.status)} for ${duration(r.trigger.hours)}`
        : r.trigger.type === 'due_in' ? `an action on ${a} is due within ${duration(r.trigger.hours)}`
          : r.trigger.to ? `${a} moves to ${words(r.trigger.to)}` : `${a} changes status`;
  const value = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v));
  const ifs = r.conditions.map((c) => `${words(c.field)} ${OP_WORDS[c.op]}${c.op === 'is_empty' ? '' : ` ${value(c.value)}`}`);
  const thens = r.actions.map((x) => {
    switch (x.type) {
      case 'set_field': return x.value === null ? `clear ${x.field}` : `set ${x.field} to ${x.field === 'priority' ? `P${x.value}` : `#${x.value}`}`;
      case 'assign_team': return `assign to team #${x.team_id}`;
      case 'add_comment': return 'add an internal note';
      case 'notify': return `notify ${[...(x.roles ?? []).map((r: string) => `the ${words(r)}`), ...x.users.map((u: number) => `person #${u}`), ...x.teams.map((t: number) => `team #${t}`)].join(', ')}`;
      case 'transition': return `move it to ${words(x.to)}`;
      case 'webhook': return `send it to webhook #${x.webhook_id}`;
      default: return x.type;
    }
  });
  return `When ${when}${ifs.length ? `, if ${ifs.join(' and ')}` : ''}, then ${thens.join(' and ')}.`;
}

// ---- Running rules ---------------------------------------------------------------------------

/** Impact and urgency for a priority set by a rule (priority = impact + urgency - 1). */
const LEVELS: Record<number, { impact: number; urgency: number }> = { 1: { impact: 1, urgency: 1 }, 2: { impact: 1, urgency: 2 }, 3: { impact: 2, urgency: 2 }, 4: { impact: 2, urgency: 3 }, 5: { impact: 3, urgency: 3 } };

/** The role a rule acts with: it can never do more than an analyst. */
export const RULE_ROLE = 'analyst' as const;

/** The rule as an actor: the rule role's permissions, no account of its own (histories name it from the channel). */
const actorOf = (rule: { id: number; name: string }): User => ({
  id: null as unknown as number, username: `rule:${rule.id}`, display_name: `Rule '${rule.name}'`, email: '', role: RULE_ROLE, preferences: {}, must_change_password: false, mfa_enabled: true,
});

/** The record's page, for notifications and webhook payloads. */
const pathOf = (kind: RuleKind, ref: string) => `/${kind === 'incident' ? 'incidents' : `${kind}s`}/${ref}`;

/** One line saying why the rule fired, with no record text. */
function why(rule: { name: string }, event: any) {
  if (event?.type === 'due_in') return `Rule '${rule.name}': a follow-up action is due ${event.due}.`;
  if (event?.type === 'in_status_for') return `Rule '${rule.name}': ${words(event.status)} for ${duration(event.hours)}.`;
  return `Rule '${rule.name}' matched.`;
}

/** The people a notify action reaches through the record: its assignee, its team's leads, approvers, an action's owner. */
async function recipients(db: Db, kind: RuleKind, ref: string, a: Extract<RuleAction, { type: 'notify' }>, facts: Facts, event: any) {
  const users: (number | null)[] = [...a.users];
  const { rows: members } = await db.query('SELECT user_id FROM team_members WHERE team_id = ANY($1)', [a.teams]);
  users.push(...members.map((x) => x.user_id));
  for (const role of a.roles) {
    if (role === 'assignee') users.push(facts.assignee);
    if (role === 'owner') users.push(event?.owner_id ?? null);
    if (role === 'team_lead' && facts.team) {
      const { rows } = await db.query("SELECT user_id FROM team_members WHERE team_id = $1 AND role = 'lead'", [facts.team]);
      users.push(...rows.map((x) => x.user_id));
    }
    if (role === 'approvers' && kind === 'request') {
      const { rows } = await db.query('SELECT approver_ids FROM requests WHERE ref = $1', [ref]);
      users.push(...(rows[0]?.approver_ids ?? []));
    }
  }
  return users;
}

/**
 * What a rule's webhook receives: the record as a ref, title, status and priority, never its text. A restricted record
 * leaves Kernel only as its ref (#53), like the problem webhooks.
 */
async function webhookPayload(kind: RuleKind, ref: string, rule: { id: number; name: string }, facts: Facts, event: any) {
  const a = await audienceOf(null, ref);
  const url = config.publicUrl ? `${config.publicUrl.replace(/\/$/, '')}${pathOf(kind, ref)}` : null;
  const base = { event: 'rule.matched', occurred_at: new Date().toISOString(), rule: { id: rule.id, name: rule.name }, trigger: event?.type ?? null };
  return a.restricted
    ? { ...base, record: { kind, ref, restricted: true, url }, summary: 'A restricted record matched a rule.' }
    : { ...base, record: { kind, ref, title: facts.title, status: facts.status, priority: facts.priority, url }, summary: why(rule, event) };
}

async function runAction(kind: RuleKind, ref: string, a: RuleAction, rule: { id: number; name: string }, run: { id: number; event: any }, facts: Facts) {
  const actor = actorOf(rule);
  const fields = (field: string, value: number | null): Record<string, unknown> =>
    field === 'priority' ? (kind === 'request' ? { priority: value } : LEVELS[value!]) : { [{ category: 'category_id', team: 'team_id', assignee: 'assignee_id' }[field]!]: value };
  const update = async (input: Record<string, unknown>) => {
    if (kind === 'incident') return (await import('./incidents.js')).updateIncidentLean(actor, ref, input);
    if (kind === 'problem') return (await import('./problems.js')).updateProblemLean(actor, ref, input);
    if (kind === 'change') return (await import('./changes.js')).updateChangeLean(actor, ref, input);
    return (await import('./requests.js')).updateRequestLean(actor, ref, input);
  };
  switch (a.type) {
    case 'set_field': return update(fields(a.field, a.value));
    case 'assign_team': return update({ team_id: a.team_id });
    case 'add_comment': {
      if (kind === 'incident') return void (await (await import('./incidents.js')).addIncidentComment(actor, ref, { body: a.text, kind: 'comment', to_requester: false }));
      if (kind === 'problem') return void (await (await import('./problems.js')).addComment(actor, ref, a.text));
      if (kind === 'change') return void (await (await import('./changes.js')).addChangeComment(actor, ref, a.text));
      return void (await (await import('./requests.js')).addRequestComment(actor, ref, a.text, false));
    }
    case 'transition': {
      const from = TRANSITIONS[kind]?.[a.to];
      if (facts.status !== from) return 'not needed';
      return (await import('./incidents.js')).transitionIncidentLean(actor, ref, { to: a.to as 'closed' });
    }
    case 'notify': {
      // Only people who may see the record are told (notify checks each one), and only its ref and title: never text.
      return tx(async (db) => {
        const sent = await notify(db, {
          users: await recipients(db, kind, ref, a, facts, run.event), event: 'automation', ref, title: facts.title, summary: why(rule, run.event),
          path: pathOf(kind, ref), dedupe: `rule:${rule.id}:${run.id}`,
        });
        return `${sent} notified`;
      });
    }
    case 'webhook': {
      const payload = await webhookPayload(kind, ref, rule, facts, run.event);
      const queued = await tx((db) => enqueueTo(db, a.webhook_id, 'rule.matched', payload));
      if (!queued) throw new Error('The webhook is turned off or removed');
      return 'queued';
    }
  }
}

/** The context a run acts in: the rule as the actor, the system as the viewer, and how deep in a chain it is. */
const ruleContext = (rule: { id: number; name: string }, run: { id: number; depth: number }): RequestContext => ({
  userId: null, userName: `rule '${rule.name}'`, actorType: 'rule', channel: `rule:${rule.id}`, tokenPrefix: '', ip: '', userAgent: '',
  requestId: `rule-run-${run.id}`, viewer: 'system', ruleDepth: run.depth,
});

const finish = (runId: number, status: string, detail = '', results: unknown[] = []) =>
  query('UPDATE rule_runs SET status = $2, detail = $3, results = $4, finished_at = now(), lease_until = NULL WHERE id = $1', [runId, status, detail, JSON.stringify(results)]);

/** Runs one queued run: the loop guards, the conditions, then the actions one by one. */
async function runOne(run: any) {
  const { rows } = await query('SELECT * FROM automation_rules WHERE id = $1', [run.rule_id]);
  const rule = rows[0];
  if (!rule?.enabled) return finish(run.id, 'skipped', 'The rule was turned off before it ran');
  const kind = run.kind as RuleKind;
  if (run.depth >= MAX_DEPTH) {
    const detail = `Stopped: ${MAX_DEPTH} rules already ran in a row on this record (the loop guard)`;
    await contextStore.run(ruleContext(rule, run), () => audit(null, { entity_type: kind, entity_ref: run.record_ref, action: 'rule_stopped', changes: { rule: rule.name, depth: run.depth } }));
    return finish(run.id, 'skipped', detail);
  }
  const [facts] = await factsOf(kind, { refs: [run.record_ref] }, needsServices(rule.conditions));
  if (!facts) return finish(run.id, 'skipped', 'The record no longer exists');
  // A time trigger is checked again when it runs: the record may have moved on since the scan.
  if (run.event.type === 'in_status_for' && facts.status !== run.event.status) return finish(run.id, 'skipped', `No longer ${words(run.event.status)}`);
  if (run.event.type === 'due_in') {
    const { rows: open } = await query("SELECT 1 FROM problem_actions WHERE id = $1 AND status = 'open' AND due_date = $2::date", [run.event.action_id, run.event.due]);
    if (!open[0]) return finish(run.id, 'skipped', 'The action is done or its due date moved');
  }
  if (!matches(rule.conditions, facts)) return finish(run.id, 'not_matched');
  // A time trigger fires once per window already (window_key); the 10-minute rule is for chains of changes.
  const { rows: recent } = run.window_key ? { rows: [] } : await query(
    `SELECT 1 FROM rule_runs WHERE rule_id = $1 AND record_ref = $2 AND status = 'matched' AND finished_at > now() - $3 * interval '1 minute' AND id <> $4 LIMIT 1`,
    [rule.id, run.record_ref, REFIRE_MINUTES, run.id],
  );
  if (recent[0]) return finish(run.id, 'skipped', `Already fired on this record in the last ${REFIRE_MINUTES} minutes`);
  // The circuit breaker: a rule that suddenly does a lot is turned off before it does more.
  const { rows: rate } = await query(
    `SELECT coalesce(sum(jsonb_array_length(results)), 0)::int AS n FROM rule_runs WHERE rule_id = $1 AND status = 'matched' AND finished_at > now() - interval '1 minute'`,
    [rule.id],
  );
  if (rate[0].n + rule.actions.length > MAX_ACTIONS_PER_MINUTE) {
    await trip(rule, run);
    return finish(run.id, 'skipped', `Turned off: more than ${MAX_ACTIONS_PER_MINUTE} actions in a minute (the circuit breaker)`);
  }
  const results: { type: string; ok: boolean; note?: string; error?: string }[] = [];
  await contextStore.run(ruleContext(rule, run), async () => {
    for (const a of rule.actions as RuleAction[]) {
      try {
        const note = await runAction(kind, run.record_ref, a, rule, run, facts);
        results.push({ type: a.type, ok: true, ...(typeof note === 'string' ? { note } : {}) });
      } catch (err) {
        results.push({ type: a.type, ok: false, error: (err as Error).message.slice(0, 300) });
      }
    }
  });
  const failed = results.filter((r) => !r.ok).length;
  return finish(run.id, failed === results.length ? 'failed' : 'matched', failed ? `${failed} of ${results.length} actions failed` : '', results);
}

/** Turns a rule off and tells its owner (or whoever wrote it). */
async function trip(rule: any, run: any) {
  await tx(async (db) => {
    const { rowCount } = (await db.query('UPDATE automation_rules SET enabled = false, tripped_at = now() WHERE id = $1 AND enabled', [rule.id])) as { rowCount: number | null };
    if (!rowCount) return;
    await contextStore.run(ruleContext(rule, run), () =>
      audit(db, { entity_type: 'automation_rule', entity_ref: `#${rule.id}`, action: 'tripped', changes: { name: rule.name, enabled: { from: true, to: false }, limit: MAX_ACTIONS_PER_MINUTE } }));
    await notify(db, {
      users: [rule.owner_id ?? rule.created_by], event: 'automation', ref: `RULE-${rule.id}`, title: rule.name,
      summary: `Turned off: it took more than ${MAX_ACTIONS_PER_MINUTE} actions in a minute. Check it, then enable it again.`,
      path: `/rules/${rule.id}`, dedupe: `rule-tripped:${rule.id}:${Date.now()}`,
    });
  });
  logger.warn({ event: { dataset: 'kernel.rules', action: 'rule.tripped' }, rule: rule.id }, 'automation rule turned off by its circuit breaker');
}

// ---- Time triggers ---------------------------------------------------------------------------
// #173: the scan queues into rule_runs like a change does; it moves with the shared outbox helper when that comes.

const RECORD_TABLES: Record<RuleKind, { table: string; activity: string; fk: string }> = {
  incident: { table: 'incidents', activity: 'incident_activity', fk: 'incident_id' },
  problem: { table: 'problems', activity: 'problem_activity', fk: 'problem_id' },
  change: { table: 'changes', activity: 'change_activity', fk: 'change_id' },
  request: { table: 'requests', activity: 'request_activity', fk: 'request_id' },
};
/** At most this many runs per rule and scan; the rest come in the next minute. */
const SCAN_BATCH = 200;

/**
 * Finds what the enabled time rules are waiting for and queues one run per record and window: the moment the record
 * entered the status, or the action and its due date. One replica scans at a time (an advisory lock as the lease);
 * the unique window key makes a second scan harmless anyway. Returns how many runs were queued.
 */
export async function scanTimeTriggers(): Promise<number> {
  return tx(async (db) => {
    const { rows: lock } = await db.query('SELECT pg_try_advisory_xact_lock(4949) AS ok');
    if (!lock[0].ok) return 0;
    const { rows: rules } = await db.query("SELECT id, kind, trigger FROM automation_rules WHERE enabled AND trigger->>'type' IN ('in_status_for', 'due_in')");
    let queued = 0;
    for (const r of rules) {
      const kind = r.kind as RuleKind;
      const t = RECORD_TABLES[kind];
      const { rowCount } = (r.trigger.type === 'in_status_for'
        ? await db.query(
          // When it entered the status: its latest move there, or its creation if it never moved.
          `INSERT INTO rule_runs (rule_id, kind, record_ref, event, window_key)
           SELECT $1, $2, x.ref, jsonb_build_object('type', 'in_status_for', 'status', $3::text, 'hours', $4::numeric, 'since', x.since),
                  'in:' || $3 || ':' || extract(epoch FROM x.since)::bigint
           FROM (SELECT r.ref, coalesce((SELECT max(a.created_at) FROM ${t.activity} a WHERE a.${t.fk} = r.id AND a.kind = 'status'
                                           AND coalesce(a.data->>'to', a.data->'status'->>'to') = $3), r.created_at) AS since
                 FROM ${t.table} r WHERE r.status = $3) x
           WHERE x.since <= now() - $4 * interval '1 hour'
           ORDER BY x.since LIMIT ${SCAN_BATCH}
           ON CONFLICT (rule_id, record_ref, window_key) WHERE window_key IS NOT NULL DO NOTHING`,
          [r.id, kind, r.trigger.status, r.trigger.hours],
        )
        : await db.query(
          `INSERT INTO rule_runs (rule_id, kind, record_ref, event, window_key)
           SELECT $1, 'problem', p.ref, jsonb_build_object('type', 'due_in', 'hours', $2::int, 'action_id', a.id, 'owner_id', a.owner_id, 'due', a.due_date::text),
                  'due:' || a.id || ':' || a.due_date::text
           FROM problem_actions a JOIN problems p ON p.id = a.problem_id
           WHERE a.status = 'open' AND a.due_date >= current_date AND a.due_date::timestamptz <= now() + $2 * interval '1 hour'
           ORDER BY a.due_date LIMIT ${SCAN_BATCH}
           ON CONFLICT (rule_id, record_ref, window_key) WHERE window_key IS NOT NULL DO NOTHING`,
          [r.id, r.trigger.hours],
        )) as { rowCount: number | null };
      queued += rowCount ?? 0;
    }
    return queued;
  });
}

let running: Promise<number> | null = null;

/** Claims queued runs with a lease and runs them in order. Returns how many ran. */
export async function processRuleRuns(): Promise<number> {
  if (running) return running;
  running = (async () => {
    let done = 0;
    for (;;) {
      // A run whose worker died is claimed again once its lease is over, three times at most.
      const { rows } = await query(
        `UPDATE rule_runs SET status = 'running', lease_until = now() + interval '2 minutes', attempts = attempts + 1
         WHERE id IN (SELECT id FROM rule_runs WHERE (status = 'pending' OR (status = 'running' AND lease_until < now())) AND attempts < 3
                      ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED)
         RETURNING *`,
      );
      if (!rows.length) break;
      for (const run of rows.sort((a, b) => Number(a.id) - Number(b.id))) {
        try {
          await runOne(run);
        } catch (err) {
          await finish(run.id, 'failed', (err as Error).message.slice(0, 300));
        }
        done++;
      }
    }
    await query("UPDATE rule_runs SET status = 'failed', detail = 'Gave up after 3 attempts', finished_at = now(), lease_until = NULL WHERE status = 'running' AND lease_until < now() AND attempts >= 3");
    return done;
  })().finally(() => {
    running = null;
  });
  return running;
}

const asWorker = <T>(fn: () => Promise<T>) => contextStore.run({ userId: null, userName: 'rules', actorType: 'system', channel: 'system', tokenPrefix: '', ip: '', userAgent: '', requestId: '', viewer: 'system' }, fn);

export function startRuleWorker(log: (msg: string) => void) {
  const run = () => asWorker(() => processRuleRuns()).catch((err) => log(`automation rules failed: ${err.message}`));
  // Woken right after a change commits; the interval picks up what another replica queued or a crash left behind.
  onRulesQueued(() => setImmediate(run));
  setInterval(run, 5_000).unref();
  // Time triggers are looked for every minute; what they queue runs right away.
  setInterval(() => asWorker(() => scanTimeTriggers()).then((n) => n && run()).catch((err) => log(`automation time triggers failed: ${err.message}`)), 60_000).unref();
  // The log keeps what a rule did for a year; runs that did not match only for a week.
  setInterval(() => asWorker(() => query(
    "DELETE FROM rule_runs WHERE (status = 'not_matched' AND created_at < now() - interval '7 days') OR created_at < now() - interval '365 days'",
  )).catch(() => {}), 3600_000).unref();
}
