// Problem record service. Shared by the REST API and the MCP server so both
// enforce the same rules, permissions and audit trail.
import { z } from 'zod';
import type pg from 'pg';
import type { User } from './auth.js';
import { query, tx } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { canEdit, checkTransition, CLOSURE_CODES, EC_DECISIONS, isManager, STATUSES, WORKAROUND_EFFECTIVENESS, type Status } from './workflow.js';

export const LINK_KINDS = ['incident', 'event', 'change', 'problem'] as const;

const level = z.number().int().min(1).max(3);
const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => v === '' || /^https?:\/\//i.test(v), 'URL must start with http:// or https://');

export const problemFields = {
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20000),
  category_id: z.number().int().nullable(),
  affected_service: z.string().trim().max(200),
  detection: z.enum(['reactive', 'proactive']),
  impact: level,
  urgency: level,
  is_major: z.boolean(),
  assignee_id: z.number().int().nullable(),
  root_cause: z.string().max(20000),
  workaround: z.string().max(20000),
  resolution: z.string().max(20000),
  major_review: z.string().max(20000),
};

export const createProblemSchema = z.object({
  ...problemFields,
  description: problemFields.description.default(''),
}).partial().required({ title: true });

export const updateProblemSchema = z.object(problemFields).partial();

export const transitionSchema = z.object({
  to: z.enum(STATUSES),
  closure_code: z.enum(CLOSURE_CODES).optional(),
  comment: z.string().max(20000).optional(),
  // Fields that can be completed as part of the transition, e.g. the resolution.
  root_cause: problemFields.root_cause.optional(),
  workaround: problemFields.workaround.optional(),
  resolution: problemFields.resolution.optional(),
  major_review: problemFields.major_review.optional(),
  // Closing with open follow-up actions must be acknowledged explicitly.
  acknowledge_open_actions: z.boolean().optional(),
});

export const linkSchema = z.object({
  kind: z.enum(LINK_KINDS),
  reference: z.string().trim().min(1).max(200),
  system: z.string().trim().max(100).default(''),
  url: httpUrl.default(''),
  note: z.string().trim().max(2000).default(''),
});

export const listSchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.union([z.enum(STATUSES), z.literal('open'), z.literal('all')]).default('open'),
  assignee_id: z.coerce.number().int().optional(),
  priority: z.coerce.number().int().min(1).max(5).optional(),
  category_id: z.coerce.number().int().optional(),
  is_major: z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean().optional()),
  needs_decision: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  review_due: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  sort: z.enum(['priority', 'updated', 'created', 'ref']).default('priority'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export type ProblemInput = z.infer<typeof updateProblemSchema>;
export type Db = Pick<pg.PoolClient, 'query'>;

const SELECT_PROBLEM = `
  SELECT p.id, p.ref, p.title, p.description, p.status, p.category_id, c.name AS category,
         p.affected_service, p.detection, p.impact, p.urgency, p.priority, p.is_major,
         p.assignee_id, a.display_name AS assignee, p.created_by, cb.display_name AS created_by_name,
         p.root_cause, p.workaround, p.resolution, p.closure_code, p.major_review,
         p.known_error_at, p.resolved_at, p.closed_at, p.created_at, p.updated_at,
         p.ec_risk_level, p.ec_risk, p.ec_fix_cost, p.ec_decision, p.ec_decision_note, p.ec_decided_by,
         db.display_name AS ec_decided_by_name, p.ec_decided_at, p.ec_review_date::text AS ec_review_date,
         p.workaround_effectiveness, p.workaround_reviewed_at,
         (p.status = 'known_error' AND p.ec_review_date <= current_date) AS ec_review_due
  FROM problems p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN users a ON a.id = p.assignee_id
  LEFT JOIN users cb ON cb.id = p.created_by
  LEFT JOIN users db ON db.id = p.ec_decided_by`;

export const SELECT_ACTION = `
  SELECT a.id, a.problem_id, p.ref, p.title AS problem_title, a.title, a.description, a.owner_id,
         o.display_name AS owner, a.due_date::text AS due_date, a.status, a.change_ref,
         (a.status = 'open' AND a.due_date < current_date) AS overdue,
         cb.display_name AS created_by, a.created_at, a.updated_at, a.completed_at
  FROM problem_actions a
  JOIN problems p ON p.id = a.problem_id
  LEFT JOIN users o ON o.id = a.owner_id
  LEFT JOIN users cb ON cb.id = a.created_by`;

const SHORT_FIELDS = new Set(['title', 'category_id', 'affected_service', 'detection', 'impact', 'urgency', 'is_major', 'assignee_id']);

export function requireEditor(user: User) {
  if (!canEdit(user.role)) throw forbidden('Your role cannot change problems');
}

export async function logActivity(db: Db, problemId: number, userId: number, kind: string, body = '', data: object = {}) {
  await db.query('INSERT INTO problem_activity (problem_id, user_id, kind, body, data) VALUES ($1, $2, $3, $4, $5)', [
    problemId,
    userId,
    kind,
    body,
    JSON.stringify(data),
  ]);
}

export async function loadForUpdate(db: Db, ref: string) {
  const { rows } = await db.query('SELECT * FROM problems WHERE ref = $1 FOR UPDATE', [ref.toUpperCase()]);
  if (!rows[0]) throw notFound(`Problem ${ref} not found`);
  return rows[0];
}

async function validateReferences(db: Db, input: ProblemInput) {
  if (input.assignee_id != null) {
    const { rows } = await db.query("SELECT 1 FROM users WHERE id = $1 AND active AND role <> 'viewer'", [input.assignee_id]);
    if (!rows[0]) throw badRequest('Assignee must be an active user who can work on problems');
  }
  if (input.category_id != null) {
    const { rows } = await db.query('SELECT 1 FROM categories WHERE id = $1', [input.category_id]);
    if (!rows[0]) throw badRequest('Unknown category');
  }
}

export async function listProblems(filter: z.infer<typeof listSchema>) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (filter.status === 'open') where.push("p.status NOT IN ('resolved', 'closed')");
  else if (filter.status !== 'all') add('p.status = ?', filter.status);
  if (filter.assignee_id !== undefined) add('p.assignee_id = ?', filter.assignee_id);
  if (filter.priority !== undefined) add('p.priority = ?', filter.priority);
  if (filter.category_id !== undefined) add('p.category_id = ?', filter.category_id);
  if (filter.is_major !== undefined) add('p.is_major = ?', filter.is_major);
  if (filter.needs_decision) where.push("p.status = 'known_error' AND coalesce(p.ec_decision, 'pending') = 'pending'");
  if (filter.review_due) where.push("p.status = 'known_error' AND p.ec_review_date <= current_date");
  if (filter.q) {
    // Prefix match on every word, so "data cor" finds "database corruption".
    const terms = filter.q.split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, '')).filter(Boolean);
    if (terms.length) add("p.search @@ to_tsquery('simple', ?)", terms.map((t) => `${t}:*`).join(' & '));
  }
  const order = {
    priority: 'p.priority, p.updated_at DESC',
    updated: 'p.updated_at DESC',
    created: 'p.created_at DESC',
    ref: 'p.id DESC',
  }[filter.sort];
  params.push(filter.limit);
  const { rows } = await query(
    `${SELECT_PROBLEM} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export async function getProblem(ref: string) {
  const { rows } = await query(`${SELECT_PROBLEM} WHERE p.ref = $1`, [ref.toUpperCase()]);
  if (!rows[0]) throw notFound(`Problem ${ref} not found`);
  const problem = rows[0];
  const [links, activity, actions] = await Promise.all([
    query(
      `SELECT l.id, l.kind, l.reference, l.system, l.url, l.note, l.created_at, u.display_name AS created_by
       FROM problem_links l JOIN users u ON u.id = l.created_by WHERE l.problem_id = $1 ORDER BY l.kind, l.created_at`,
      [problem.id],
    ),
    query(
      `SELECT a.id, a.kind, a.body, a.data, a.created_at, u.display_name AS user_name
       FROM problem_activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.problem_id = $1 ORDER BY a.created_at DESC, a.id DESC`,
      [problem.id],
    ),
    query(`${SELECT_ACTION} WHERE a.problem_id = $1 ORDER BY a.status = 'open' DESC, a.due_date NULLS LAST, a.id`, [problem.id]),
  ]);
  return { ...problem, links: links.rows, activity: activity.rows, actions: actions.rows };
}

export async function createProblem(user: User, input: z.infer<typeof createProblemSchema>) {
  requireEditor(user);
  if (input.is_major && !isManager(user.role)) throw forbidden('Only a problem manager can flag a major problem');
  const ref = await tx(async (db) => {
    await validateReferences(db, input);
    const cols = Object.keys(input);
    const { rows } = await db.query(
      `INSERT INTO problems (${[...cols, 'created_by'].join(', ')})
       VALUES (${[...cols, 'created_by'].map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, ref`,
      [...Object.values(input), user.id],
    );
    await logActivity(db, rows[0].id, user.id, 'created', `Problem record ${rows[0].ref} logged`);
    return rows[0].ref as string;
  });
  return getProblem(ref);
}

export async function updateProblem(user: User, ref: string, input: ProblemInput) {
  requireEditor(user);
  await tx(async (db) => {
    const current = await loadForUpdate(db, ref);
    if (current.status === 'closed') throw conflict('Reopen the problem before editing it');
    if (input.is_major !== undefined && input.is_major !== current.is_major && !isManager(user.role)) {
      throw forbidden('Only a problem manager can change the major problem flag');
    }
    await validateReferences(db, input);
    const changed = Object.entries(input).filter(([k, v]) => v !== undefined && current[k] !== v);
    if (!changed.length) return;
    await db.query(
      `UPDATE problems SET ${changed.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
      [current.id, ...changed.map(([, v]) => v)],
    );
    const data = Object.fromEntries(
      changed.map(([k, v]) => [k, SHORT_FIELDS.has(k) ? { from: current[k], to: v } : { edited: true }]),
    );
    await logActivity(db, current.id, user.id, 'update', `Updated ${changed.map(([k]) => k).join(', ')}`, data);
  });
  return getProblem(ref);
}

export async function transitionProblem(user: User, ref: string, input: z.infer<typeof transitionSchema>) {
  await tx(async (db) => {
    const current = await loadForUpdate(db, ref);
    const fields = {
      root_cause: input.root_cause ?? current.root_cause,
      workaround: input.workaround ?? current.workaround,
      resolution: input.resolution ?? current.resolution,
      major_review: input.major_review ?? current.major_review,
    };
    const closure_code = input.to === 'closed' ? (input.closure_code ?? null) : null;
    const reason = checkTransition({ ...current, ...fields, closure_code }, input.to, user.role);
    if (reason) throw conflict(reason);
    if (input.to === 'closed' && !input.acknowledge_open_actions) {
      const { rows } = await db.query("SELECT count(*)::int AS n FROM problem_actions WHERE problem_id = $1 AND status = 'open'", [current.id]);
      if (rows[0].n > 0) {
        throw conflict(`${rows[0].n} follow-up action(s) are still open. Complete or cancel them, or set acknowledge_open_actions to close anyway.`);
      }
    }

    const from = current.status as Status;
    const reopening = input.to === 'analysis' && (from === 'resolved' || from === 'closed');
    await db.query(
      `UPDATE problems SET status = $2, root_cause = $3, workaround = $4, resolution = $5, major_review = $6,
         closure_code = $7,
         known_error_at = CASE WHEN $2 = 'known_error' THEN coalesce(known_error_at, now()) ELSE known_error_at END,
         resolved_at = CASE WHEN $2 = 'resolved' THEN now() WHEN $8 THEN NULL ELSE resolved_at END,
         closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE NULL END,
         updated_at = now()
       WHERE id = $1`,
      [current.id, input.to, fields.root_cause, fields.workaround, fields.resolution, fields.major_review, closure_code, reopening],
    );
    await logActivity(db, current.id, user.id, 'status', input.comment ?? '', { from, to: input.to, closure_code });
  });
  return getProblem(ref);
}

export async function addComment(user: User, ref: string, body: string) {
  requireEditor(user);
  if (!body.trim()) throw badRequest('Comment cannot be empty');
  await tx(async (db) => {
    const current = await loadForUpdate(db, ref);
    await logActivity(db, current.id, user.id, 'comment', body.trim());
    await db.query('UPDATE problems SET updated_at = now() WHERE id = $1', [current.id]);
  });
  return getProblem(ref);
}

export async function addLink(user: User, ref: string, input: z.infer<typeof linkSchema>) {
  requireEditor(user);
  await tx(async (db) => {
    const current = await loadForUpdate(db, ref);
    const { rowCount } = await db.query(
      `INSERT INTO problem_links (problem_id, kind, reference, system, url, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [current.id, input.kind, input.reference, input.system, input.url, input.note, user.id],
    );
    if (!rowCount) throw conflict(`${input.kind} ${input.reference} is already linked`);
    await logActivity(db, current.id, user.id, 'link', `Linked ${input.kind} ${input.reference}`, { ...input, action: 'add' });
    await db.query('UPDATE problems SET updated_at = now() WHERE id = $1', [current.id]);
  });
  return getProblem(ref);
}

export async function removeLink(user: User, ref: string, linkId: number) {
  requireEditor(user);
  await tx(async (db) => {
    const current = await loadForUpdate(db, ref);
    const { rows } = await db.query('DELETE FROM problem_links WHERE id = $1 AND problem_id = $2 RETURNING kind, reference', [
      linkId,
      current.id,
    ]);
    if (!rows[0]) throw notFound('Link not found');
    await logActivity(db, current.id, user.id, 'link', `Unlinked ${rows[0].kind} ${rows[0].reference}`, { ...rows[0], action: 'remove' });
  });
  return getProblem(ref);
}

/** Known error database: problems in error control, plus optionally resolved ones that kept a workaround. */
export async function searchKnownErrors(q?: string, includeResolved = false) {
  const params: unknown[] = [];
  const where = [includeResolved ? "p.status IN ('known_error', 'resolved', 'closed') AND p.known_error_at IS NOT NULL" : "p.status = 'known_error'"];
  const terms = (q ?? '').split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, '')).filter(Boolean);
  if (terms.length) {
    params.push(terms.map((t) => `${t}:*`).join(' & '));
    where.push(`p.search @@ to_tsquery('simple', $1)`);
  }
  const { rows } = await query(`${SELECT_PROBLEM} WHERE ${where.join(' AND ')} ORDER BY p.priority, p.known_error_at DESC LIMIT 200`, params);
  return rows;
}

export async function dashboard(user: User) {
  const [byStatus, byPriority, aging, mine, recent, links, myActions, actionSummary] = await Promise.all([
    query('SELECT status, count(*)::int AS count FROM problems GROUP BY status'),
    query("SELECT priority, count(*)::int AS count FROM problems WHERE status NOT IN ('resolved', 'closed') GROUP BY priority ORDER BY priority"),
    query(`SELECT
             count(*) FILTER (WHERE now() - created_at < interval '30 days')::int AS under_30,
             count(*) FILTER (WHERE now() - created_at BETWEEN interval '30 days' AND interval '90 days')::int AS d30_90,
             count(*) FILTER (WHERE now() - created_at > interval '90 days')::int AS over_90,
             count(*) FILTER (WHERE is_major)::int AS major,
             count(*) FILTER (WHERE assignee_id IS NULL)::int AS unassigned,
             count(*) FILTER (WHERE status = 'known_error' AND coalesce(ec_decision, 'pending') = 'pending')::int AS needs_decision,
             count(*) FILTER (WHERE status = 'known_error' AND ec_review_date <= current_date)::int AS review_due
           FROM problems WHERE status NOT IN ('resolved', 'closed')`),
    query(`${SELECT_PROBLEM} WHERE p.assignee_id = $1 AND p.status NOT IN ('resolved', 'closed') ORDER BY p.priority, p.updated_at DESC LIMIT 20`, [user.id]),
    query(`SELECT a.id, a.kind, a.body, a.data, a.created_at, u.display_name AS user_name, p.ref, p.title
           FROM problem_activity a JOIN problems p ON p.id = a.problem_id LEFT JOIN users u ON u.id = a.user_id
           ORDER BY a.created_at DESC, a.id DESC LIMIT 15`),
    query(`SELECT l.kind, count(*)::int AS count FROM problem_links l JOIN problems p ON p.id = l.problem_id
           WHERE p.status NOT IN ('resolved', 'closed') GROUP BY l.kind`),
    query(`${SELECT_ACTION} WHERE a.owner_id = $1 AND a.status = 'open' ORDER BY a.due_date NULLS LAST, a.id LIMIT 20`, [user.id]),
    query(`SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
                  count(*) FILTER (WHERE status = 'open' AND due_date < current_date)::int AS overdue
           FROM problem_actions`),
  ]);
  return {
    by_status: Object.fromEntries(byStatus.rows.map((r) => [r.status, r.count])),
    open_by_priority: byPriority.rows,
    open_summary: aging.rows[0],
    open_links_by_kind: Object.fromEntries(links.rows.map((r) => [r.kind, r.count])),
    my_problems: mine.rows,
    my_actions: myActions.rows,
    actions: actionSummary.rows[0],
    recent_activity: recent.rows,
  };
}

export const assessmentSchema = z.object({
  ec_risk_level: z.number().int().min(1).max(3).nullable(),
  ec_risk: z.string().max(20000),
  ec_fix_cost: z.string().max(20000),
  ec_decision: z.enum(EC_DECISIONS).nullable(),
  ec_decision_note: z.string().max(20000),
  ec_review_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable(),
  workaround_effectiveness: z.enum(WORKAROUND_EFFECTIVENESS).nullable(),
}).partial();

const ASSESSMENT_LABELS: Record<string, string> = {
  ec_risk_level: 'risk level',
  ec_risk: 'risk',
  ec_fix_cost: 'cost of fixing',
  ec_decision: 'decision',
  ec_decision_note: 'decision rationale',
  ec_review_date: 'review date',
  workaround_effectiveness: 'workaround effectiveness',
};

/**
 * Records the error control assessment of a known error. Accepting or deferring the risk is a
 * management decision, so only problem managers can record those.
 */
export async function assessProblem(user: User, ref: string, input: z.infer<typeof assessmentSchema>) {
  requireEditor(user);
  if ((input.ec_decision === 'accept' || input.ec_decision === 'defer') && !isManager(user.role)) {
    throw forbidden('Only a problem manager can accept or defer the risk of a known error');
  }
  await tx(async (db) => {
    const current = await loadForUpdate(db, ref);
    if (current.status === 'closed') throw conflict('Reopen the problem before changing its assessment');
    if (current.status === 'new' || current.status === 'analysis') {
      if (input.ec_decision) throw conflict('Raise the problem as a known error before recording a decision');
    }
    const currentReview = current.ec_review_date;
    const changed = Object.entries(input).filter(([k, v]) => v !== undefined && (k === 'ec_review_date' ? currentReview : current[k]) !== v);
    if (!changed.length) return;
    const sets = changed.map(([k], i) => `${k} = $${i + 2}`);
    const decisionChanged = input.ec_decision !== undefined && input.ec_decision !== current.ec_decision;
    if (decisionChanged) sets.push(`ec_decided_by = ${input.ec_decision ? user.id : 'NULL'}`, `ec_decided_at = ${input.ec_decision ? 'now()' : 'NULL'}`);
    if (input.workaround_effectiveness !== undefined) sets.push('workaround_reviewed_at = now()');
    await db.query(`UPDATE problems SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, [current.id, ...changed.map(([, v]) => v)]);
    const body = decisionChanged && input.ec_decision
      ? `Recorded decision: ${input.ec_decision}`
      : `Updated error control assessment (${changed.map(([k]) => ASSESSMENT_LABELS[k]).join(', ')})`;
    await logActivity(db, current.id, user.id, 'assessment', body, Object.fromEntries(changed));
  });
  return getProblem(ref);
}
