// Change enablement (#29): maximise successful changes by assessing risk, authorising, scheduling without collisions
// or freezes, and reviewing. Problems raise changes for their permanent fix; incidents on CIs shortly after a change on
// what they depend on are flagged as possibly change-related.
import { checkAssigneeInTeam, validTeam } from './teams.js';
import { inheritRestriction } from './visibility.js';
import { z } from 'zod';
import type { User } from './auth.js';
import { audit } from './audit.js';
import { computeImpact, impactSchema } from './cmdb-graph.js';
import { loadCi, logCi, registerCiExtra } from './cmdb.js';
import { currentContext } from './context.js';
import { query, tx } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { authorize, can } from './policy.js';
import { getProblem, loadForUpdate, logActivity, registerProblemExtra, type Db } from './problems.js';
import { managers, notify } from './notifications.js';
import { recordUrl, registerRecordType, type RecordType } from './records.js';

export const CHANGE_TYPES = ['standard', 'normal', 'emergency'] as const;
export const CHANGE_STATUSES = ['draft', 'assess', 'authorize', 'scheduled', 'implementing', 'review', 'closed', 'rejected', 'cancelled'] as const;
export const OUTCOMES = ['successful', 'failed', 'rolled_back'] as const;
export const RISKS = ['low', 'medium', 'high'] as const;
type Status = (typeof CHANGE_STATUSES)[number];
type Risk = (typeof RISKS)[number];

/** Who moves a change where; votes move authorize → scheduled/rejected, not a transition. */
const TRANSITIONS: Record<Status, Status[]> = {
  draft: ['assess', 'scheduled', 'cancelled'],
  assess: ['authorize', 'draft', 'cancelled'],
  authorize: ['implementing', 'cancelled'],
  scheduled: ['implementing', 'assess', 'cancelled'],
  implementing: ['review'],
  review: ['closed'],
  closed: [],
  rejected: ['draft'],
  cancelled: [],
};

const text = z.string().max(20000);
const instant = z.iso.datetime({ offset: true });
export const changeFields = {
  title: z.string().trim().min(1).max(300),
  description: text,
  change_type: z.enum(CHANGE_TYPES),
  risk: z.enum(RISKS).nullable(),
  planned_start: instant.nullable(),
  planned_end: instant.nullable(),
  implementation_plan: text,
  test_plan: text,
  backout_plan: text,
  team_id: z.number().int().nullable(),
  assignee_id: z.number().int().nullable(),
};
export const createChangeSchema = z
  .object({
    ...changeFields,
    template_id: z.number().int().optional(),
    cis: z.array(z.string().trim().min(1).max(30)).max(100).optional(),
    problem: z.string().max(20).optional(),
  })
  .partial()
  .required({ title: true });
export const updateChangeSchema = z.object(changeFields).partial().extend({ base: z.object(changeFields).partial().optional() });
export const transitionChangeSchema = z.object({
  to: z.enum(CHANGE_STATUSES),
  outcome: z.enum(OUTCOMES).optional(),
  review: text.optional(),
  cancel_reason: z.string().trim().max(2000).optional(),
  comment: text.optional(),
  /** Schedule into a freeze anyway (change authority only), with the reason recorded. */
  override_freeze_reason: z.string().trim().max(1000).optional(),
});
export const voteSchema = z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().trim().max(5000).default('') });
export const listChangesSchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.union([z.enum(CHANGE_STATUSES), z.literal('open'), z.literal('all')]).default('open'),
  type: z.enum(CHANGE_TYPES).optional(),
  ci: z.string().max(30).optional(),
  awaiting_my_vote: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
/** A deployment pipeline registers a standard change it has carried out (or is carrying out). */
export const registerSchema = z.object({
  template_id: z.number().int(),
  title: z.string().trim().min(1).max(300),
  description: text.default(''),
  cis: z.array(z.string().trim().min(1).max(30)).max(100).default([]),
  actual_start: instant,
  actual_end: instant.optional(),
  outcome: z.enum(OUTCOMES).optional(),
  links: z.array(z.object({ kind: z.enum(['pull_request', 'pipeline', 'document']), reference: z.string().max(200), url: z.string().max(2000).default('') })).max(50).default([]),
});

// ---- Policy ------------------------------------------------------------------------------------

interface Policy { approvals: Record<Risk, number>; related_hours: number; allow_self_approval?: boolean }
async function policy(): Promise<Policy> {
  const { rows } = await query("SELECT value FROM settings WHERE key = 'change_policy'");
  return { approvals: { low: 1, medium: 1, high: 2 }, related_hours: 24, ...(rows[0]?.value ?? {}) };
}

const sourceOf = (): 'user' | 'api' | 'mcp' => ({ mcp: 'mcp' as const, api: 'api' as const })[currentContext().channel as 'mcp' | 'api'] ?? 'user';

export async function logChange(db: Db, changeId: number, userId: number | null, kind: string, body = '', data: object = {}) {
  await db.query('INSERT INTO change_activity (change_id, user_id, kind, body, data, channel) VALUES ($1, $2, $3, $4, $5, $6)', [
    changeId, userId, kind, body, JSON.stringify(data), currentContext().channel,
  ]);
  const { rows } = await db.query('UPDATE changes SET updated_at = now() WHERE id = $1 RETURNING ref', [changeId]);
  await audit(db, { entity_type: 'change', entity_ref: rows[0].ref, action: kind, changes: kind === 'comment' ? { body } : (data as Record<string, unknown>) });
}

/** Comparable form of a field value: timestamps as ISO strings, so '…+02:00' and a Date compare equal. */
const norm = (key: string, v: unknown) => (v === null || v === undefined ? null : key.startsWith('planned_') ? new Date(v as string).toISOString() : JSON.stringify(v));

async function loadChange(db: Db, ref: string) {
  const { rows } = await db.query('SELECT * FROM changes WHERE ref = $1 FOR UPDATE', [ref.toUpperCase()]);
  if (!rows[0]) throw notFound(`Change ${ref} not found`);
  return rows[0];
}

// ---- Risk, collisions, freezes -----------------------------------------------------------------

const RISK_FROM_CRITICALITY: Record<number, Risk> = { 1: 'high', 2: 'medium', 3: 'low', 4: 'low' };
const bump = (r: Risk): Risk => (r === 'low' ? 'medium' : 'high');

/** Risk from the most critical CI or service affected through the CMDB; emergency changes are one level higher. */
async function assessRisk(cis: { ref: string; name: string; criticality: number }[], type: string) {
  let worst: { name: string; criticality: number } | null = null;
  const services: { ref: string; name: string; criticality: number; via: string[] }[] = [];
  for (const ci of cis) if (!worst || ci.criticality < worst.criticality) worst = ci;
  for (const ci of cis.slice(0, 10)) {
    const r = await computeImpact(null, ci.ref, impactSchema.parse({ direction: 'up' }));
    for (const s of r.services) {
      const seen = services.find((x) => x.ref === s.ref);
      if (seen) seen.via.push(ci.ref);
      else services.push({ ref: s.ref, name: s.name, criticality: s.criticality, via: [ci.ref] });
      if (!worst || s.criticality < worst.criticality) worst = s;
    }
  }
  let risk: Risk = worst ? RISK_FROM_CRITICALITY[worst.criticality] : 'low';
  if (type === 'emergency') risk = bump(risk);
  const reason = worst ? `Affects ${worst.name} (criticality ${worst.criticality})${type === 'emergency' ? '; emergency change' : ''}` : 'No CIs recorded';
  return { risk, reason, services: services.sort((a, b) => a.criticality - b.criticality) };
}

/** Other changes in the same window on the same CIs, and freezes the window overlaps. */
async function conflictsFor(changeId: number, start: string | Date | null, end: string | Date | null) {
  if (!start || !end) return { collisions: [], freezes: [] };
  const [collisions, freezes] = await Promise.all([
    query(
      `SELECT DISTINCT c.ref, c.title, c.status, c.planned_start, c.planned_end, ci.ref AS ci
       FROM changes c JOIN change_cis x ON x.change_id = c.id JOIN change_cis mine ON mine.ci_id = x.ci_id AND mine.change_id = $1
       JOIN configuration_items ci ON ci.id = x.ci_id
       WHERE c.id <> $1 AND c.status NOT IN ('rejected', 'cancelled', 'closed', 'draft')
         AND c.planned_start < $3 AND c.planned_end > $2
       ORDER BY c.planned_start`,
      [changeId, start, end],
    ),
    query('SELECT id, name, starts_at, ends_at, reason FROM change_freezes WHERE starts_at < $2 AND ends_at > $1 ORDER BY starts_at', [start, end]),
  ]);
  return { collisions: collisions.rows, freezes: freezes.rows };
}

// ---- Reading -----------------------------------------------------------------------------------

const SELECT_CHANGE = `
  SELECT c.*, a.display_name AS assignee, (SELECT name FROM teams WHERE id = c.team_id) AS team, r.display_name AS requested_by, p.ref AS problem_ref, p.title AS problem_title, p.status AS problem_status,
         t.name AS template
  FROM changes c LEFT JOIN users a ON a.id = c.assignee_id LEFT JOIN users r ON r.id = c.created_by
  LEFT JOIN problems p ON p.id = c.problem_id LEFT JOIN change_templates t ON t.id = c.template_id`;

export async function listChanges(user: User, f: z.infer<typeof listChangesSchema>) {
  authorize(user, 'change.read');
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (f.status === 'open') where.push("c.status NOT IN ('closed', 'rejected', 'cancelled')");
  else if (f.status !== 'all') add('c.status = ?', f.status);
  if (f.type) add('c.change_type = ?', f.type);
  if (f.ci) add('EXISTS (SELECT 1 FROM change_cis x JOIN configuration_items ci ON ci.id = x.ci_id WHERE x.change_id = c.id AND ci.ref = ?)', f.ci.toUpperCase());
  if (f.awaiting_my_vote) {
    where.push("c.status = 'authorize'");
    add('c.created_by IS DISTINCT FROM ? AND c.assignee_id IS DISTINCT FROM ? AND NOT EXISTS (SELECT 1 FROM change_votes v WHERE v.change_id = c.id AND v.user_id = ?)', user.id);
  }
  if (f.q) {
    const terms = f.q.split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}_.-]/gu, '')).filter(Boolean);
    if (terms.length) add("c.search @@ to_tsquery('simple', ?)", terms.map((t) => `${t}:*`).join(' & '));
  }
  params.push(f.limit);
  const { rows } = await query(
    `SELECT c.id, c.ref, c.title, c.change_type, c.status, c.risk, c.planned_start, c.planned_end, c.actual_start, c.outcome, c.source,
            a.display_name AS assignee, p.ref AS problem_ref, c.created_at,
            (SELECT array_agg(ci.name ORDER BY ci.criticality) FROM change_cis x JOIN configuration_items ci ON ci.id = x.ci_id WHERE x.change_id = c.id) AS cis
     FROM changes c LEFT JOIN users a ON a.id = c.assignee_id LEFT JOIN problems p ON p.id = c.problem_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY c.status IN ('closed', 'rejected', 'cancelled'), c.planned_start NULLS LAST, c.created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({ ...r, url: changeUrl(r.ref) }));
}

export async function getChange(user: User, ref: string) {
  authorize(user, 'change.read');
  const { rows } = await query(`${SELECT_CHANGE} WHERE c.ref = $1`, [ref.toUpperCase()]);
  const c = rows[0];
  if (!c) throw notFound(`Change ${ref} not found`);
  const [cis, votes, activity, links, incidents, pol] = await Promise.all([
    query(
      `SELECT ci.id, ci.ref, ci.name, ci.class, ci.ci_type, t.label AS type_label, ci.status, ci.environment, ci.criticality
       FROM change_cis x JOIN configuration_items ci ON ci.id = x.ci_id JOIN ci_types t ON t.name = ci.ci_type WHERE x.change_id = $1 ORDER BY ci.criticality, ci.name`,
      [c.id],
    ),
    query('SELECT v.decision, v.comment, v.created_at, u.id AS user_id, u.display_name AS approver FROM change_votes v JOIN users u ON u.id = v.user_id WHERE v.change_id = $1 ORDER BY v.created_at', [c.id]),
    query(
      `SELECT a.id, a.kind, a.body, a.data, a.channel, a.created_at, u.display_name AS user_name
       FROM change_activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.change_id = $1 ORDER BY a.created_at DESC, a.id DESC`,
      [c.id],
    ),
    query('SELECT id, kind, reference, system, url, note, created_at FROM change_links WHERE change_id = $1 ORDER BY kind, created_at', [c.id]),
    relatedIncidentsForChange(c),
    policy(),
  ]);
  const assessed = await assessRisk(cis.rows, c.change_type);
  const risk: Risk = c.risk ?? assessed.risk;
  const approvals = { required: c.change_type === 'standard' ? 0 : pol.approvals[risk], approved: votes.rows.filter((v) => v.decision === 'approve').length };
  const detail = {
    ...c,
    risk,
    risk_assessed: assessed.risk,
    risk_reason: assessed.reason,
    risk_overridden: !!c.risk && c.risk !== assessed.risk,
    affected_cis: cis.rows.map(({ id: _, ...ci }) => ({ ...ci, type: ci.class === 'service' ? 'service' : 'ci' })),
    affected_services: assessed.services,
    votes: votes.rows,
    approvals,
    can_vote: c.status === 'authorize' && can(user.role, 'change.approve') && (pol.allow_self_approval || (c.created_by !== user.id && c.assignee_id !== user.id)) && !votes.rows.some((v) => v.user_id === user.id),
    ...(await conflictsFor(c.id, c.planned_start, c.planned_end)),
    activity: activity.rows,
    links: links.rows,
    related_incidents: incidents,
  };
  return { type: 'change', ...detail, url: changeUrl(c.ref), next_steps: changeGuidance(detail) };
}

function changeGuidance(c: any) {
  const standard = c.change_type === 'standard';
  const steps = [
    { id: 'cis', label: 'Record the affected CIs and services', hint: 'Risk, collisions and change-related incidents come from them.', done: c.affected_cis.length > 0 },
    { id: 'plans', label: 'Write the implementation and backout plans', hint: 'How to do it, how to test it, and how to undo it if it goes wrong.', done: !!c.implementation_plan.trim() && !!c.backout_plan.trim() },
    { id: 'window', label: 'Plan the window', hint: 'Planned start and end; Kernel checks collisions and freezes.', done: !!c.planned_start && !!c.planned_end },
    ...(standard ? [] : [{ id: 'authorize', label: `Get it authorised (${c.approvals.required} approval${c.approvals.required === 1 ? '' : 's'})`, hint: `${c.risk} risk: ${c.risk_reason}`, done: ['scheduled', 'implementing', 'review', 'closed'].includes(c.status) || (c.status === 'authorize' && c.approvals.approved >= c.approvals.required) }]),
    { id: 'implement', label: 'Implement and record the outcome', hint: 'Successful, failed or rolled back.', done: !!c.outcome },
    { id: 'review', label: 'Review', hint: c.outcome && c.outcome !== 'successful' ? 'A failed or rolled back change needs a review.' : 'What went well, what to improve.', done: c.status === 'closed' },
  ];
  const handover = c.status === 'closed' && c.outcome === 'successful' && c.problem_ref && !['resolved', 'closed'].includes(c.problem_status)
    ? { label: `The fix is in: resolve ${c.problem_ref}`, hint: 'Then verify that its incidents stop before closing the problem.', action: 'resolve_problem' as const, target: c.problem_ref }
    : null;
  return {
    handover,
    phase: { draft: 'Request', assess: 'Assess', authorize: 'Authorise', scheduled: 'Scheduled', implementing: 'Implement', review: 'Review', closed: 'Closed', rejected: 'Rejected', cancelled: 'Cancelled' }[c.status as Status],
    purpose: 'Maximise successful changes: assess the risk, authorise, schedule and review.',
    steps,
    next: steps.find((s) => !s.done)?.label ?? 'Nothing pending.',
  };
}

/** Incidents on the change's CIs, or on CIs that depend on them, within the related window after it started. */
async function relatedIncidentsForChange(c: any) {
  const start = c.actual_start ?? (['implementing', 'review', 'closed'].includes(c.status) ? c.planned_start : null);
  if (!start) return [];
  const { related_hours } = await policy();
  const { rows: cis } = await query('SELECT ci.ref FROM change_cis x JOIN configuration_items ci ON ci.id = x.ci_id WHERE x.change_id = $1 LIMIT 10', [c.id]);
  const refs = new Set<string>(cis.map((r) => r.ref));
  for (const ci of cis) {
    const up = await computeImpact(null, ci.ref, impactSchema.parse({ direction: 'up', max_depth: 5 }));
    up.nodes.forEach((n) => refs.add(n.ref));
  }
  const { rows } = await query(
    `SELECT DISTINCT i.ref, i.title, i.status, i.priority, i.created_at FROM incidents i
     JOIN incident_cis x ON x.incident_id = i.id JOIN configuration_items ci ON ci.id = x.ci_id
     WHERE ci.ref = ANY($1) AND i.created_at >= $2 AND i.created_at < $2::timestamptz + $3 * interval '1 hour'
     ORDER BY i.created_at LIMIT 50`,
    [[...refs], start, related_hours],
  );
  return rows;
}

/** Changes that started shortly before an incident, on its CIs or on what they depend on. */
export async function possibleCausesForIncident(incident: { created_at: Date; affected_cis: { ref: string }[] }) {
  if (!incident.affected_cis.length) return [];
  const { related_hours } = await policy();
  const refs = new Set<string>(incident.affected_cis.map((c) => c.ref));
  for (const ci of incident.affected_cis.slice(0, 5)) {
    const down = await computeImpact(null, ci.ref, impactSchema.parse({ direction: 'down', max_depth: 5 }));
    down.nodes.forEach((n) => refs.add(n.ref));
  }
  const { rows } = await query(
    `SELECT DISTINCT c.ref, c.title, c.status, c.change_type, c.outcome, coalesce(c.actual_start, c.planned_start) AS started_at, ci.ref AS ci, ci.name AS ci_name
     FROM changes c JOIN change_cis x ON x.change_id = c.id JOIN configuration_items ci ON ci.id = x.ci_id
     WHERE ci.ref = ANY($1) AND c.status IN ('implementing', 'review', 'closed')
       AND coalesce(c.actual_start, c.planned_start) BETWEEN $2::timestamptz - $3 * interval '1 hour' AND $2::timestamptz
     ORDER BY started_at DESC LIMIT 10`,
    [[...refs], incident.created_at, related_hours],
  );
  return rows;
}

// ---- Changing ----------------------------------------------------------------------------------

async function attachCis(db: Db, changeId: number, refs: string[], userId: number | null) {
  for (const ref of refs) {
    const ci = await loadCi(db, ref);
    await db.query('INSERT INTO change_cis (change_id, ci_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [changeId, ci.id, userId]);
  }
}

async function validateAssignee(db: Db, id: number | null | undefined) {
  if (!id) return;
  const { rows } = await db.query("SELECT 1 FROM users WHERE id = $1 AND active AND role NOT IN ('viewer', 'integration')", [id]);
  if (!rows[0]) throw badRequest('Assignee must be an active user who can work on changes');
}

export async function createChange(user: User, input: z.infer<typeof createChangeSchema>, source?: 'pipeline') {
  authorize(user, 'change.create');
  const { cis, problem, template_id, ...fields } = input;
  const ref = await tx(async (db) => {
    await validateAssignee(db, fields.assignee_id);
    await validTeam(db, fields.team_id);
    await checkAssigneeInTeam(db, fields.team_id, fields.assignee_id);
    let values: Record<string, unknown> = { ...fields };
    if (template_id) {
      const t = await checkTemplateScope(user, template_id, cis ?? [], fields.planned_start ?? null, fields.planned_end ?? null);
      const rows = [t];
      // A standard change is pre-approved: its plans come from the template.
      values = {
        ...values, change_type: 'standard', template_id,
        description: fields.description || rows[0].description, implementation_plan: rows[0].implementation_plan,
        test_plan: rows[0].test_plan, backout_plan: rows[0].backout_plan,
      };
    } else if (fields.change_type === 'standard') throw badRequest('A standard change needs a pre-approved template');
    let problemRow: { id: number; ref: string } | null = null;
    if (problem) {
      const found: { id: number; ref: string } = await loadForUpdate(db, problem);
      problemRow = found;
      values.problem_id = found.id;
    }
    values.source = source ?? sourceOf();
    values.created_by = user.id;
    const cols = Object.keys(values).filter((k) => values[k] !== undefined);
    const { rows } = await db.query(`INSERT INTO changes (${cols.join(', ')}) VALUES (${cols.map((_, n) => `$${n + 1}`).join(', ')}) RETURNING id, ref`, cols.map((k) => values[k]));
    await attachCis(db, rows[0].id, cis ?? [], user.id);
    if (problemRow) await linkToProblem(db, user, rows[0], problemRow);
    await logChange(db, rows[0].id, user.id, 'created', `Change ${rows[0].ref} requested`, { title: fields.title, type: values.change_type, cis: cis ?? [], problem: problemRow?.ref ?? null });
    return rows[0].ref as string;
  });
  return getChange(user, ref);
}

async function linkToProblem(db: Db, user: User, change: { id: number; ref: string }, problem: { id: number; ref: string }) {
  await db.query(
    "INSERT INTO problem_links (problem_id, kind, reference, system, note, created_by) VALUES ($1, 'change', $2, 'Kernel', 'Change for the fix', $3) ON CONFLICT DO NOTHING",
    [problem.id, change.ref, user.id],
  );
  await logActivity(db, problem.id, user.id, 'link', `Change ${change.ref} raised for the fix`, { kind: 'change', reference: change.ref, system: 'Kernel', action: 'add' });
}

export async function updateChange(user: User, ref: string, { base, ...input }: z.infer<typeof updateChangeSchema>) {
  authorize(user, 'change.update');
  await tx(async (db) => {
    const current = await loadChange(db, ref);
    if (base) {
      const stale = Object.keys(base).filter((k) => k in input && norm(k, current[k]) !== norm(k, (base as any)[k]));
      if (stale.length) throw conflict(`${stale.join(', ')} changed while you were editing`, { conflicts: stale.map((f) => ({ field: f, current: current[f] ?? null })) });
    }
    if (['closed', 'rejected', 'cancelled'].includes(current.status)) throw conflict(`A ${current.status} change cannot be edited`);
    // Once authorised, what was approved must not change silently: plans, type and risk are locked.
    const locked = ['change_type', 'risk', 'implementation_plan', 'backout_plan', 'test_plan', 'planned_start', 'planned_end'].filter((k) => k in input && norm(k, (input as any)[k]) !== norm(k, current[k]));
    if (['authorize', 'scheduled', 'implementing', 'review'].includes(current.status) && locked.length) {
      throw conflict(`${locked.join(', ')} cannot change after the change was submitted for authorisation: what was approved is what happens. Move it back to assess to re-plan (it is then authorised again).`);
    }
    if (input.change_type === 'standard' && !current.template_id) throw badRequest('A standard change needs a pre-approved template');
    if (input.change_type && current.template_id && input.change_type !== 'standard') throw badRequest('A change from a standard template stays standard');
    await validateAssignee(db, input.assignee_id);
    await validTeam(db, input.team_id);
    await checkAssigneeInTeam(db, input.team_id !== undefined ? input.team_id : current.team_id, input.assignee_id !== undefined ? input.assignee_id : current.assignee_id);
    const changed = Object.entries(input).filter(([k, v]) => v !== undefined && norm(k, current[k]) !== norm(k, v));
    if (!changed.length) return;
    await db.query(`UPDATE changes SET ${changed.map(([k], n) => `${k} = $${n + 2}`).join(', ')} WHERE id = $1`, [current.id, ...changed.map(([, v]) => v)]);
    if (input.assignee_id && input.assignee_id !== current.assignee_id) {
      await notify(db, { users: [input.assignee_id], event: 'assigned', ref: current.ref, title: input.title ?? current.title, summary: 'A change was assigned to you.', path: `/changes/${current.ref}`, dedupe: `assigned:${current.ref}:${Date.now()}`, actorId: user.id });
    }
    await logChange(db, current.id, user.id, 'update', `Updated ${changed.map(([k]) => k).join(', ')}`, Object.fromEntries(changed.map(([k, v]) => [k, { from: current[k] ?? null, to: v }])));
  });
  return getChange(user, ref);
}

export async function transitionChange(user: User, ref: string, input: z.infer<typeof transitionChangeSchema>) {
  authorize(user, 'change.update');
  const before = await getChange(user, ref);
  await tx(async (db) => {
    const c = await loadChange(db, ref);
    const from = c.status as Status;
    if (!TRANSITIONS[from].includes(input.to)) throw conflict(`A change cannot move from ${from} to ${input.to}`);
    const standard = c.change_type === 'standard';
    const plans = c.implementation_plan.trim() && c.backout_plan.trim();
    const window = c.planned_start && c.planned_end;
    if (input.to === 'scheduled' && from === 'draft' && !standard) throw conflict('Only standard changes are scheduled without authorisation; submit it for assessment');
    if (input.to === 'assess' && !before.affected_cis.length) throw conflict('Record the affected CIs or services first');
    if (input.to === 'authorize' && !plans) throw conflict('Write the implementation and backout plans before authorisation');
    if (['scheduled', 'authorize'].includes(input.to) && !window && c.change_type !== 'emergency') throw conflict('Plan the window (planned start and end) first');
    if (input.to === 'scheduled' || (input.to === 'authorize' && c.change_type !== 'emergency')) {
      if (before.freezes.length && c.change_type !== 'emergency') {
        if (!input.override_freeze_reason) throw conflict(`The window overlaps the change freeze "${before.freezes[0].name}"; choose another window or override with a reason (change authority)`);
        authorize(user, 'change.approve');
      }
    }
    if (input.to === 'implementing' && from === 'authorize') {
      // Only emergency changes go from authorisation straight to implementation, once approved.
      if (c.change_type !== 'emergency') throw conflict('Normal changes are scheduled when authorised; start them from the schedule');
      if (before.approvals.approved < before.approvals.required) throw conflict('The emergency change is not approved yet');
    }
    if (input.to === 'review' && !input.outcome) throw conflict('Record the outcome: successful, failed or rolled back');
    const review = input.review ?? c.review;
    if (input.to === 'closed' && !review.trim() && (c.outcome !== 'successful' || c.change_type === 'emergency')) {
      throw conflict('A failed, rolled back or emergency change needs a post-implementation review before closing');
    }
    if (input.to === 'cancelled' && !input.cancel_reason) throw conflict('Give a reason for cancelling');
    const back = input.to === 'draft' || (input.to === 'assess' && from === 'scheduled');
    await db.query(
      `UPDATE changes SET status = $2,
         actual_start = CASE WHEN $2 = 'implementing' THEN coalesce(actual_start, now()) ELSE actual_start END,
         actual_end = CASE WHEN $2 = 'review' THEN coalesce(actual_end, now()) ELSE actual_end END,
         outcome = coalesce($3, outcome), review = $4, cancel_reason = coalesce($5, cancel_reason),
         closed_at = CASE WHEN $2 IN ('closed', 'cancelled') THEN now() ELSE closed_at END
       WHERE id = $1`,
      [c.id, input.to, input.outcome ?? null, review, input.cancel_reason ?? null],
    );
    // Going back (rework or re-scheduling) invalidates earlier votes: the authority decides on what is in front of them.
    if (back) await db.query('DELETE FROM change_votes WHERE change_id = $1', [c.id]);
    await logChange(db, c.id, user.id, 'status', input.comment ?? input.cancel_reason ?? '', {
      from, to: input.to, ...(input.outcome ? { outcome: input.outcome } : {}), ...(input.override_freeze_reason ? { override_freeze_reason: input.override_freeze_reason } : {}),
    });
    const path = `/changes/${c.ref}`;
    if (input.to === 'authorize') {
      await notify(db, { users: await managers(db, [c.created_by, c.assignee_id]), event: 'approval_needed', ref: c.ref, title: c.title, summary: `A ${c.change_type} change waits for authorisation.`, path, dedupe: `approve:${c.ref}:${Date.now()}`, actorId: user.id });
    }
    if (c.problem_id && input.to === 'review') {
      await logActivity(db, c.problem_id, user.id, 'link', `Change ${c.ref} implemented: ${input.outcome?.replace('_', ' ')}`, { kind: 'change', reference: c.ref, outcome: input.outcome });
    }
  });
  return getChange(user, ref);
}

/** A vote by the change authority. Enough approvals schedule the change; one rejection rejects it. */
export async function voteOnChange(user: User, ref: string, input: z.infer<typeof voteSchema>) {
  authorize(user, 'change.approve');
  await tx(async (db) => {
    const c = await loadChange(db, ref);
    if (c.status !== 'authorize') throw conflict('The change is not waiting for authorisation');
    // Segregation of duties: neither the requester nor the implementer approves, unless policy allows it with a reason.
    if (c.created_by === user.id || c.assignee_id === user.id) {
      if (!(await policy()).allow_self_approval) throw forbidden('You requested or will implement this change, so you cannot approve it');
      if (!input.comment.trim()) throw badRequest('Give a reason for approving a change you requested or implement');
    }
    const { rowCount } = await db.query('INSERT INTO change_votes (change_id, user_id, decision, comment) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [c.id, user.id, input.decision, input.comment]);
    if (!rowCount) throw conflict('You have already voted on this change');
    await logChange(db, c.id, user.id, 'vote', input.comment, { decision: input.decision });
    if (input.decision === 'reject') {
      await db.query("UPDATE changes SET status = 'rejected' WHERE id = $1", [c.id]);
      await logChange(db, c.id, null, 'status', 'Rejected by the change authority', { from: 'authorize', to: 'rejected' });
      await notify(db, { users: [c.created_by], event: 'decision', ref: c.ref, title: c.title, summary: `${user.display_name} rejected the change${input.comment ? `: ${input.comment}` : ''}.`, path: `/changes/${c.ref}`, dedupe: `decision:${c.ref}:${Date.now()}`, actorId: user.id });
      return;
    }
    const { rows: cis } = await db.query('SELECT ci.ref, ci.name, ci.criticality FROM change_cis x JOIN configuration_items ci ON ci.id = x.ci_id WHERE x.change_id = $1', [c.id]);
    const risk: Risk = c.risk ?? (await assessRisk(cis, c.change_type)).risk;
    const required = (await policy()).approvals[risk];
    const { rows: n } = await db.query("SELECT count(*)::int AS n FROM change_votes WHERE change_id = $1 AND decision = 'approve'", [c.id]);
    if (n[0].n >= required && c.change_type !== 'emergency') {
      await db.query("UPDATE changes SET status = 'scheduled' WHERE id = $1", [c.id]);
      await logChange(db, c.id, null, 'status', `Authorised (${n[0].n} of ${required} approvals)`, { from: 'authorize', to: 'scheduled' });
      await notify(db, { users: [c.created_by, c.assignee_id], event: 'decision', ref: c.ref, title: c.title, summary: 'The change is authorised and scheduled.', path: `/changes/${c.ref}`, dedupe: `decision:${c.ref}:${Date.now()}`, actorId: user.id });
    }
  });
  return getChange(user, ref);
}

export async function setChangeCi(user: User, ref: string, ciRef: string, linked: boolean) {
  authorize(user, 'change.update');
  await tx(async (db) => {
    const c = await loadChange(db, ref);
    if (['authorize', 'scheduled', 'implementing', 'review', 'closed', 'rejected', 'cancelled'].includes(c.status)) {
      throw conflict('The affected CIs are fixed once the change is submitted for authorisation');
    }
    const ci = await loadCi(db, ciRef);
    const { rowCount } = linked
      ? await db.query('INSERT INTO change_cis (change_id, ci_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [c.id, ci.id, user.id])
      : await db.query('DELETE FROM change_cis WHERE change_id = $1 AND ci_id = $2', [c.id, ci.id]);
    if (!rowCount) throw linked ? conflict(`${ci.ref} is already linked`) : notFound(`${ci.ref} is not linked`);
    await logChange(db, c.id, user.id, 'link', `${linked ? 'Affects' : 'No longer affects'} ${ci.ref} ${ci.name}`, { kind: ci.class, reference: ci.ref, action: linked ? 'add' : 'remove' });
    await logCi(db, ci.id, user.id, 'link', `${linked ? 'Changed by' : 'Unlinked from'} change ${c.ref}`, { kind: 'change', reference: c.ref, action: linked ? 'add' : 'remove' });
  });
  return getChange(user, ref);
}

export async function addChangeComment(user: User, ref: string, body: string) {
  authorize(user, 'change.update');
  if (!body.trim()) throw badRequest('Comment cannot be empty');
  await tx(async (db) => {
    const c = await loadChange(db, ref);
    await logChange(db, c.id, user.id, 'comment', body.trim());
  });
  return getChange(user, ref);
}

export const changeLinkSchema = z.object({
  kind: z.enum(['change', 'incident', 'pull_request', 'pipeline', 'document']),
  reference: z.string().trim().min(1).max(200),
  system: z.string().trim().max(100).default(''),
  url: z.string().trim().max(2000).refine((v) => v === '' || /^https?:\/\//i.test(v), 'URL must start with http:// or https://').default(''),
  note: z.string().trim().max(2000).default(''),
});

export async function addChangeLink(user: User, ref: string, input: z.infer<typeof changeLinkSchema>) {
  authorize(user, 'change.update');
  await tx(async (db) => {
    const c = await loadChange(db, ref);
    const { rowCount } = await db.query(
      'INSERT INTO change_links (change_id, kind, reference, system, url, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING',
      [c.id, input.kind, input.reference, input.system, input.url, input.note, user.id],
    );
    if (!rowCount) throw conflict(`${input.kind} ${input.reference} is already linked`);
    await logChange(db, c.id, user.id, 'link', `Linked ${input.kind} ${input.reference}`, { ...input, action: 'add' });
  });
  return getChange(user, ref);
}

/** Problem → "Raise change for fix": prefilled from the known error, CIs carried over, linked both ways. */
export async function raiseChangeForProblem(user: User, problemRef: string, overrides: Partial<z.infer<typeof createChangeSchema>> = {}) {
  const p: any = await getProblem(problemRef);
  const change = await createChange(user, createChangeSchema.parse({
    title: `Fix: ${p.title}`.slice(0, 300),
    description: [p.root_cause && `Root cause:\n${p.root_cause}`, p.resolution && `Proposed fix:\n${p.resolution}`, `Raised from problem ${p.ref}.`].filter(Boolean).join('\n\n'),
    change_type: 'normal',
    cis: p.affected_cis.map((c: any) => c.ref),
    problem: p.ref,
    ...overrides,
  }));
  await inheritRestriction(p.ref, change.ref); // the change carries the problem's root cause
  return getChange(user, change.ref);
}

/**
 * A standard change is only pre-approved within its template's scope: the account may use the template (integration
 * accounts are bound to theirs), the CIs are of an allowed type, the assessed risk is within max_risk, and the window
 * is not in a change freeze. Anything else needs a normal change.
 */
async function checkTemplateScope(user: User, templateId: number, ciRefs: string[], start: string | null, end: string | null) {
  const { rows } = await query('SELECT * FROM change_templates WHERE id = $1 AND active', [templateId]);
  const t = rows[0];
  if (!t) throw badRequest('Unknown or inactive standard change template');
  if (user.role === 'integration') {
    const { rows: me } = await query('SELECT change_templates FROM users WHERE id = $1', [user.id]);
    if (!(me[0]?.change_templates ?? []).includes(t.id)) throw forbidden(`This account may not use the standard change "${t.name}". An administrator can allow it under Users.`);
  }
  if (!ciRefs.length) throw badRequest('A standard change must name the CIs it changes');
  const { rows: cis } = await query('SELECT ref, name, ci_type, criticality FROM configuration_items WHERE ref = ANY($1)', [ciRefs.map((r) => r.toUpperCase())]);
  if (cis.length !== new Set(ciRefs.map((r) => r.toUpperCase())).size) throw badRequest('Unknown CI in cis');
  const wrongType = t.ci_types.length ? cis.filter((c) => !t.ci_types.includes(c.ci_type)) : [];
  if (wrongType.length) throw forbidden(`"${t.name}" does not cover ${wrongType.map((c) => c.name).join(', ')} (${wrongType[0].ci_type}); request a normal change`);
  const { risk, reason } = await assessRisk(cis, 'standard');
  if (RISKS.indexOf(risk) > RISKS.indexOf(t.max_risk)) throw forbidden(`${risk} risk (${reason}) exceeds what "${t.name}" is pre-approved for (${t.max_risk}); request a normal change`);
  if (start && end) {
    const { rows: frozen } = await query('SELECT name FROM change_freezes WHERE starts_at < $2 AND ends_at > $1 LIMIT 1', [start, end]);
    if (frozen[0]) throw conflict(`Change freeze "${frozen[0].name}" is in force; standard changes may not run`);
  }
  return t;
}

/** A pipeline registers a standard change it carried out; no approval (the template is pre-approved). */
export async function registerStandardChange(user: User, input: z.infer<typeof registerSchema>) {
  authorize(user, 'change.register');
  const t = await checkTemplateScope(user, input.template_id, input.cis, input.actual_start, input.actual_end ?? input.actual_start);
  const created = await tx(async (db) => {
    const status = input.outcome ? 'closed' : 'implementing';
    const { rows } = await db.query(
      `INSERT INTO changes (title, description, change_type, template_id, status, implementation_plan, test_plan, backout_plan,
                            actual_start, actual_end, outcome, source, created_by, closed_at, planned_start, planned_end)
       VALUES ($1, $2, 'standard', $3, $4, $5, $6, $7, $8, $9, $10, 'pipeline', $11, CASE WHEN $4 = 'closed' THEN now() END, $8, coalesce($9, $8::timestamptz + interval '1 hour'))
       RETURNING id, ref`,
      [input.title, input.description || t.description, t.id, status, t.implementation_plan, t.test_plan, t.backout_plan,
        input.actual_start, input.actual_end ?? (input.outcome ? new Date().toISOString() : null), input.outcome ?? null, user.id],
    );
    await attachCis(db, rows[0].id, input.cis, user.id);
    for (const l of input.links) {
      await db.query('INSERT INTO change_links (change_id, kind, reference, url, created_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING', [rows[0].id, l.kind, l.reference, l.url, user.id]);
    }
    await logChange(db, rows[0].id, user.id, 'created', `Standard change ${rows[0].ref} registered by a pipeline`, { template: t.name, cis: input.cis, outcome: input.outcome ?? null });
    return rows[0];
  });
  return { ref: created.ref, url: changeUrl(created.ref) };
}

// ---- Templates and freezes ---------------------------------------------------------------------

export const templateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /** The highest assessed risk the template may be used for; above it, a normal change is needed. */
  max_risk: z.enum(RISKS).default('low'),
  /** CI types the template may change; empty means any type (within max_risk). */
  ci_types: z.array(z.string().max(50)).max(30).default([]),
  description: text.default(''),
  implementation_plan: text.min(1),
  test_plan: text.default(''),
  backout_plan: text.min(1),
  active: z.boolean().default(true),
});

export async function listTemplates(user: User) {
  authorize(user, 'change.read');
  return (await query('SELECT * FROM change_templates ORDER BY active DESC, name')).rows;
}

export async function saveTemplate(user: User, id: number | null, input: z.infer<typeof templateSchema>) {
  authorize(user, 'change.manage');
  const cols = Object.keys(input) as (keyof typeof input)[];
  try {
    const { rows } = id
      ? await query(`UPDATE change_templates SET ${cols.map((k, n) => `${k} = $${n + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [id, ...cols.map((k) => input[k])])
      : await query(`INSERT INTO change_templates (${cols.join(', ')}, created_by) VALUES (${cols.map((_, n) => `$${n + 1}`).join(', ')}, $${cols.length + 1}) RETURNING *`, [...cols.map((k) => input[k]), user.id]);
    if (!rows[0]) throw notFound('Template not found');
    await audit(null, { entity_type: 'change_template', entity_ref: input.name, action: id ? 'update' : 'create', changes: input });
    return rows[0];
  } catch (err: any) {
    if (err.code === '23505') throw conflict('A template with that name already exists');
    throw err;
  }
}

export const freezeSchema = z.object({ name: z.string().trim().min(1).max(200), starts_at: instant, ends_at: instant, reason: z.string().trim().max(1000).default('') });

export async function listFreezes(user: User) {
  authorize(user, 'change.read');
  return (await query("SELECT f.*, u.display_name AS created_by_name FROM change_freezes f LEFT JOIN users u ON u.id = f.created_by WHERE f.ends_at > now() - interval '30 days' ORDER BY f.starts_at")).rows;
}

export async function addFreeze(user: User, input: z.infer<typeof freezeSchema>) {
  authorize(user, 'change.manage');
  if (new Date(input.ends_at) <= new Date(input.starts_at)) throw badRequest('The freeze must end after it starts');
  const { rows } = await query('INSERT INTO change_freezes (name, starts_at, ends_at, reason, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *', [input.name, input.starts_at, input.ends_at, input.reason, user.id]);
  await audit(null, { entity_type: 'change_freeze', entity_ref: input.name, action: 'create', changes: input });
  return rows[0];
}

export async function deleteFreeze(user: User, id: number) {
  authorize(user, 'change.manage');
  const { rows } = await query('DELETE FROM change_freezes WHERE id = $1 RETURNING name', [id]);
  if (!rows[0]) throw notFound('Freeze not found');
  await audit(null, { entity_type: 'change_freeze', entity_ref: rows[0].name, action: 'delete', changes: {} });
}

// ---- Schedule ----------------------------------------------------------------------------------

export const scheduleSchema = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() });

/** Planned changes and freezes in a period, with collisions (same CI, overlapping windows) marked. */
export async function changeSchedule(user: User, f: z.infer<typeof scheduleSchema>) {
  authorize(user, 'change.read');
  const from = f.from ?? new Date().toISOString().slice(0, 10);
  const to = f.to ?? new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
  const [changes, freezes, collisions] = await Promise.all([
    query(
      `SELECT c.ref, c.title, c.change_type, c.status, c.risk, c.planned_start, c.planned_end, c.outcome,
              (SELECT array_agg(ci.name ORDER BY ci.criticality) FROM change_cis x JOIN configuration_items ci ON ci.id = x.ci_id WHERE x.change_id = c.id) AS cis
       FROM changes c
       WHERE c.status NOT IN ('rejected', 'cancelled', 'draft') AND c.planned_start < $2::date + 1 AND c.planned_end > $1::date
       ORDER BY c.planned_start LIMIT 500`,
      [from, to],
    ),
    query('SELECT id, name, starts_at, ends_at, reason FROM change_freezes WHERE starts_at < $2::date + 1 AND ends_at > $1::date ORDER BY starts_at', [from, to]),
    query(
      `SELECT DISTINCT a.ref AS change, b.ref AS with, ci.ref AS ci, ci.name AS ci_name
       FROM changes a JOIN change_cis xa ON xa.change_id = a.id JOIN change_cis xb ON xb.ci_id = xa.ci_id JOIN changes b ON b.id = xb.change_id AND b.id <> a.id
       JOIN configuration_items ci ON ci.id = xa.ci_id
       WHERE a.status NOT IN ('rejected', 'cancelled', 'draft', 'closed') AND b.status NOT IN ('rejected', 'cancelled', 'draft', 'closed')
         AND a.planned_start < b.planned_end AND a.planned_end > b.planned_start
         AND a.planned_start < $2::date + 1 AND a.planned_end > $1::date`,
      [from, to],
    ),
  ]);
  return { from, to, changes: changes.rows, freezes: freezes.rows, collisions: collisions.rows };
}

// ---- Elsewhere ---------------------------------------------------------------------------------

registerProblemExtra(async (p) => {
  const { rows } = await query('SELECT ref, title, status, change_type, outcome, planned_start FROM changes WHERE problem_id = $1 ORDER BY created_at DESC LIMIT 50', [p.id]);
  return { changes: rows };
});

registerCiExtra(async (ciId) => {
  const { rows } = await query(
    `SELECT c.ref, c.title, c.status, c.change_type, c.planned_start, c.planned_end, c.outcome FROM change_cis x JOIN changes c ON c.id = x.change_id
     WHERE x.ci_id = $1 ORDER BY coalesce(c.actual_start, c.planned_start, c.created_at) DESC LIMIT 25`,
    [ciId],
  );
  return { changes: rows };
});

const CHANGE_TYPE: RecordType = {
  type: 'change',
  prefix: 'CHG',
  // Exactly six digits, so ServiceNow and Jira references (CHG0030012…) stay external.
  pattern: /^CHG\d{6}$/,
  readAction: 'change.read',
  uiPath: (ref) => `/changes/${ref}`,
  get: getChange,
  search: async (user, q, limit) =>
    (await listChanges(user, listChangesSchema.parse({ q, status: 'all', limit }))).map((c) => ({
      type: 'change', ref: c.ref, title: c.title, status: c.status, url: c.url, summary: [c.change_type, (c.cis ?? []).join(', ')].filter(Boolean).join(' · '),
    })),
  rest: {
    list: '/api/changes',
    create: '/api/changes',
    get: '/api/changes/:ref',
    update: '/api/changes/:ref',
    transition: '/api/changes/:ref/transition',
    links: '/api/changes/:ref/links',
    comments: '/api/changes/:ref/comments',
  },
  mcp: { list: 'list_changes', get: 'get_change', create: 'create_change', update: 'update_change', transition: 'transition_change' },
};
registerRecordType(CHANGE_TYPE);

function changeUrl(ref: string) {
  return recordUrl(CHANGE_TYPE, ref);
}
