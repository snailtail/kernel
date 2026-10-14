// Problem record service. Shared by the REST API and the MCP server so both
// enforce the same rules, permissions and audit trail.
import { forgetExists, onlyTitleMatches, textFilterSql } from './confidential.js';
import { z } from 'zod';
import type pg from 'pg';
import type { User } from './auth.js';
import { afterCommit, query, tx } from './db.js';
import { audit } from './audit.js';
import { currentContext } from './context.js';
import { recordUrl, registerRecordType, type RecordType } from './records.js';
import { authorize } from './policy.js';
import { logDomainEvent } from './log.js';
import { recordActivity } from './metrics.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { guidanceFor } from './guidance.js';
import { notify } from './notifications.js';
import { enqueue as enqueueWebhooks, eventFor } from './webhooks.js';
import { checkAssigneeInTeam, validTeam } from './teams.js';
import { restrictedByCategory } from './visibility.js';
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
  team_id: z.number().int().nullable(),
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

/**
 * Updates carry an optional `base`: the values the client's edit started from. If someone else has changed one of
 * those fields since, the update is rejected with 409 and the current values, instead of silently overwriting.
 */
export const updateProblemSchema = z.object(problemFields).partial().extend({
  base: z.object(problemFields).partial().optional(),
});

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

export type ProblemInput = Omit<z.infer<typeof updateProblemSchema>, 'base'>;
export type Db = Pick<pg.PoolClient, 'query'>;

const SELECT_PROBLEM = `
  SELECT p.id, p.ref, p.title, p.description, p.status, p.category_id, c.name AS category,
         p.affected_service, p.detection, p.impact, p.urgency, p.priority, p.is_major,
         p.assignee_id, a.display_name AS assignee, p.restricted, p.restricted_teams, p.team_id, (SELECT name FROM teams WHERE id = p.team_id) AS team, p.created_by, cb.display_name AS created_by_name,
         p.root_cause, p.workaround, p.resolution, p.closure_code, p.major_review,
         p.known_error_at, p.resolved_at, p.closed_at, p.created_at, p.updated_at, p.contains_personal_data, p.classification,
         p.ec_risk_level, p.ec_risk, p.ec_fix_cost, p.ec_decision, p.ec_decision_note, p.ec_decided_by,
         db.display_name AS ec_decided_by_name, p.ec_decided_at, p.ec_review_date::text AS ec_review_date,
         p.workaround_effectiveness, p.workaround_reviewed_at, p.mcp_proposed,
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



export async function logActivity(db: Db, problemId: number, userId: number, kind: string, body = '', data: object = {}) {
  const { rows: inserted } = await db.query('INSERT INTO problem_activity (problem_id, user_id, kind, body, data, channel) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [
    problemId,
    userId,
    kind,
    body,
    JSON.stringify(data),
    currentContext().channel,
  ]);
  const { rows } = await db.query(
    `SELECT p.ref, p.status, p.priority, p.is_major, p.detection, p.affected_service, c.name AS category, u.username
     FROM problems p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN users u ON u.id = $2 WHERE p.id = $1`,
    [problemId, userId],
  );
  const p = rows[0];
  // The unified audit trail (#57): same transaction, full before/after values.
  await audit(db, { entity_type: 'problem', entity_ref: p?.ref ?? String(problemId), action: kind, changes: kind === 'comment' ? { body } : { ...(data as object), ...(body && kind !== 'update' ? { summary: body } : {}) } });
  // People: watchers hear about notes and status changes (in-app by default), assignees about assignments.
  if (p && (kind === 'comment' || kind === 'status')) {
    const { rows: watchers } = await db.query('SELECT user_id FROM problem_watchers WHERE problem_id = $1', [problemId]);
    const { rows: t } = await db.query('SELECT title FROM problems WHERE id = $1', [problemId]);
    await notify(db, {
      users: watchers.map((w) => w.user_id), event: 'watched_update', ref: p.ref, title: t[0]?.title ?? '',
      summary: kind === 'comment' ? `${p.username ?? 'Someone'} added a note` : `Moved to ${(data as any).to?.replace('_', ' ')}`,
      path: `/problems/${p.ref}`, dedupe: `watch:${inserted[0].id}`, actorId: userId,
    });
  }
  if (p && kind === 'update' && (data as any).assignee_id?.to) {
    const { rows: t } = await db.query('SELECT title FROM problems WHERE id = $1', [problemId]);
    await notify(db, { users: [(data as any).assignee_id.to], event: 'assigned', ref: p.ref, title: t[0]?.title ?? '', summary: 'A problem was assigned to you.', path: `/problems/${p.ref}`, dedupe: `assigned:${p.ref}:${inserted[0].id}`, actorId: userId });
  }
  const event = eventFor(kind, data);
  const summary = body || defaultSummary(kind, data);
  await enqueueWebhooks(db, event, problemId, userId, summary, data);
  if (p) {
    afterCommit(db, () => {
      logDomainEvent({
        action: event,
        problem: { ref: p.ref, status: p.status, priority: p.priority, is_major: p.is_major, category: p.category, service: p.affected_service },
        actor: p.username,
        summary,
        data: kind === 'comment' ? undefined : (data as Record<string, unknown>),
      });
      recordActivity(kind, data, { priority: p.priority, detection: p.detection });
    });
  }
}

function defaultSummary(kind: string, data: any) {
  if (kind === 'status') return `Moved from ${data.from} to ${data.to}`;
  if (kind === 'comment') return 'Added a note';
  return kind;
}

export async function watch(db: Db, problemId: number, userId: number | null | undefined) {
  if (userId) await db.query('INSERT INTO problem_watchers (problem_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [problemId, userId]);
}

export async function setWatching(user: User, ref: string, watching: boolean) {
  authorize(user, 'problem.watch');
  await tx(async (db) => {
    const p = await loadForUpdate(db, ref);
    if (watching) await watch(db, p.id, user.id);
    else await db.query('DELETE FROM problem_watchers WHERE problem_id = $1 AND user_id = $2', [p.id, user.id]);
  });
  return getProblem(ref);
}

export async function loadForUpdate(db: Db, ref: string) {
  const { rows } = await db.query('SELECT * FROM problems WHERE ref = $1 FOR UPDATE', [ref.toUpperCase()]);
  if (!rows[0]) throw notFound(`Problem ${ref} not found`);
  return rows[0];
}

async function validateReferences(db: Db, input: ProblemInput) {
  await validTeam(db, input.team_id);
  if (input.assignee_id != null) {
    const { rows } = await db.query("SELECT 1 FROM users WHERE id = $1 AND active AND role NOT IN ('viewer', 'integration')", [input.assignee_id]);
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
    if (terms.length) where.push(textFilterSql('p', 'problem', terms.map((t) => `${t}:*`).join(' & '), params));
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

/** Related data other modules add to a problem (affected CIs…), registered at startup. */
type ProblemExtra = (problem: { id: number; impact: number }) => Promise<Record<string, unknown>>;
const problemExtras: ProblemExtra[] = [];
export const registerProblemExtra = (fn: ProblemExtra) => problemExtras.push(fn);

export async function getProblem(ref: string) {
  const { rows } = await query(`${SELECT_PROBLEM} WHERE p.ref = $1`, [ref.toUpperCase()]);
  if (!rows[0]) throw notFound(`Problem ${ref} not found`);
  const problem = rows[0];
  const [links, activity, actions, analyses, watchers] = await Promise.all([
    query(
      `SELECT l.id, l.kind, l.reference, l.system, l.url, l.note, l.created_at, u.display_name AS created_by
       FROM problem_links l JOIN users u ON u.id = l.created_by WHERE l.problem_id = $1 ORDER BY l.kind, l.created_at`,
      [problem.id],
    ),
    query(
      `SELECT a.id, a.kind, a.body, a.data, a.channel, a.created_at, u.display_name AS user_name
       FROM problem_activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.problem_id = $1 ORDER BY a.created_at DESC, a.id DESC`,
      [problem.id],
    ),
    query(`${SELECT_ACTION} WHERE a.problem_id = $1 ORDER BY a.status = 'open' DESC, a.due_date NULLS LAST, a.id`, [problem.id]),
    query(
      `SELECT a.id, a.technique, a.title, a.data, a.conclusion, a.created_at, a.updated_at, u.display_name AS updated_by,
              a.proposed_via_mcp, a.confirmed_at, cu.display_name AS confirmed_by
       FROM problem_analyses a JOIN users u ON u.id = a.updated_by LEFT JOIN users cu ON cu.id = a.confirmed_by
       WHERE a.problem_id = $1 ORDER BY a.created_at`,
      [problem.id],
    ),
    query(
      `SELECT u.id, u.display_name FROM problem_watchers w JOIN users u ON u.id = w.user_id WHERE w.problem_id = $1 ORDER BY u.display_name`,
      [problem.id],
    ),
  ]);
  const { resolveLinkUrls } = await import('./integrations.js');
  const { rows: approvals } = await query(
    `SELECT a.id, a.kind, a.summary, a.payload, a.human_confirmation, a.created_at, u.display_name AS requested_by, a.requested_via,
            $2::timestamptz > a.created_at AS changed_since_request
     FROM pending_approvals a JOIN users u ON u.id = a.requested_by
     WHERE a.problem_id = $1 AND a.status = 'pending' AND a.created_at > now() - interval '14 days' ORDER BY a.created_at`,
    [problem.id, problem.updated_at],
  );
  const extra = Object.assign({}, ...(await Promise.all(problemExtras.map((fn) => fn(problem)))));
  const detail = { ...problem, ...extra, links: await resolveLinkUrls(links.rows), activity: activity.rows, actions: actions.rows, analyses: analyses.rows, watchers: watchers.rows, pending_approvals: approvals };
  return { type: 'problem', ...detail, url: problemUrl(detail.ref), next_steps: guidanceFor(detail) };
}

export async function createProblem(user: User, input: z.infer<typeof createProblemSchema>) {
  const ref = await tx(async (db) => createProblemInTx(db, user, input));
  return getProblem(ref);
}

/** How narrow a record made from another starts (#117): set at insert, before any notice or webhook goes out. */
export interface StartNarrow { restricted: boolean; restricted_teams: number[]; classification: 'normal' | 'confidential'; from: string | null }

/** Creates a problem in the caller's transaction, optionally as narrow as the record it was made from. */
export async function createProblemInTx(db: Db, user: User, input: z.infer<typeof createProblemSchema>, narrow?: StartNarrow) {
  authorize(user, 'problem.create');
  if (input.is_major) authorize(user, 'problem.flag_major');
  await validateReferences(db, input);
  await checkAssigneeInTeam(db, input.team_id, input.assignee_id);
  // Categories such as security problems start restricted (#53), and so does a problem made from a restricted record.
  const values: Record<string, unknown> = { ...input, ...((await restrictedByCategory(input.category_id)) ? { restricted: true } : {}) };
  if (narrow?.restricted) Object.assign(values, { restricted: true, restricted_teams: narrow.restricted_teams });
  if (narrow?.classification === 'confidential') values.classification = 'confidential';
  const cols = Object.keys(values);
  if (values.classification === 'confidential') forgetExists(); // and every instance, below
  const { rows } = await db.query(
    `INSERT INTO problems (${[...cols, 'created_by'].join(', ')})
     VALUES (${[...cols, 'created_by'].map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, ref`,
    [...Object.values(values), user.id],
  );
  if (values.classification === 'confidential') await db.query("SELECT pg_notify('kernel_live', 'classification:' || $1)", [rows[0].id]);
  await watch(db, rows[0].id, user.id);
  await watch(db, rows[0].id, input.assignee_id);
  const inherited = narrow && (narrow.restricted || narrow.classification === 'confidential')
    ? { inherited_from: narrow.from, restricted: narrow.restricted, classification: narrow.classification }
    : undefined;
  await logActivity(db, rows[0].id, user.id, 'created', `Problem record ${rows[0].ref} logged${inherited ? `, ${[narrow!.restricted && 'restricted', narrow!.classification === 'confidential' && 'confidential'].filter(Boolean).join(' and ')} like ${narrow!.from}` : ''}`, inherited ?? {});
  if (input.assignee_id) {
    await notify(db, { users: [input.assignee_id], event: 'assigned', ref: rows[0].ref, title: input.title, summary: 'A problem was assigned to you.', path: `/problems/${rows[0].ref}`, dedupe: `assigned:${rows[0].ref}:created`, actorId: user.id });
  }
  return rows[0].ref as string;
}

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

/** Text fields an agent writes stay "proposed via MCP" until a person edits or confirms them (#76). */
export const PROPOSABLE = ['description', 'root_cause', 'workaround', 'resolution', 'major_review', 'ec_risk', 'ec_fix_cost', 'ec_decision_note'];

export async function trackProposals(db: Db, problemId: number, fields: string[]) {
  const texts = fields.filter((f) => PROPOSABLE.includes(f));
  if (!texts.length) return;
  if (currentContext().channel === 'mcp') {
    await db.query('UPDATE problems SET mcp_proposed = ARRAY(SELECT DISTINCT unnest(mcp_proposed || $2::text[])) WHERE id = $1', [problemId, texts]);
  } else {
    await db.query('UPDATE problems SET mcp_proposed = ARRAY(SELECT unnest(mcp_proposed) EXCEPT SELECT unnest($2::text[])) WHERE id = $1', [problemId, texts]);
  }
}

/** A person confirms content an agent proposed. */
export async function confirmProposals(user: User, ref: string, fields: string[]) {
  authorize(user, 'problem.update');
  if (currentContext().channel === 'mcp') throw forbidden('Proposals can only be confirmed by a person in the web UI or REST API');
  await tx(async (db) => {
    const p = await loadForUpdate(db, ref);
    const confirm = fields.filter((f) => p.mcp_proposed.includes(f));
    if (!confirm.length) return;
    await db.query('UPDATE problems SET mcp_proposed = ARRAY(SELECT unnest(mcp_proposed) EXCEPT SELECT unnest($2::text[])) WHERE id = $1', [p.id, confirm]);
    await logActivity(db, p.id, user.id, 'update', `Confirmed ${confirm.join(', ')} proposed via MCP`, { confirmed: confirm });
  });
  return getProblem(ref);
}

/** Rejects an edit whose base values no longer match the record (someone else changed those fields). */
export async function checkBase(db: Db, problemId: number, current: Record<string, unknown>, input: object, base?: Record<string, unknown>) {
  if (!base) return;
  const fields = Object.keys(base).filter((k) => k in input && !same(current[k], base[k]));
  if (!fields.length) return;
  const { rows } = await db.query(
    `SELECT a.created_at, u.display_name FROM problem_activity a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.problem_id = $1 AND a.kind IN ('update', 'status', 'assessment') AND a.data ?| $2
     ORDER BY a.id DESC LIMIT 1`,
    [problemId, fields],
  );
  const by = rows[0];
  throw conflict(
    `${fields.join(', ')} ${fields.length > 1 ? 'were' : 'was'} changed${by ? ` by ${by.display_name ?? 'someone'}` : ''} while you were editing`,
    { conflicts: fields.map((f) => ({ field: f, current: current[f] ?? null })), changed_by: by?.display_name ?? null, changed_at: by?.created_at ?? null },
  );
}

export async function updateProblem(user: User, ref: string, { base, ...input }: z.infer<typeof updateProblemSchema>) {
  authorize(user, 'problem.update');
  await tx(async (db) => {
    const current = await loadForUpdate(db, ref);
    await checkBase(db, current.id, current, input, base);
    if (current.status === 'closed') throw conflict('Reopen the problem before editing it');
    if (input.is_major !== undefined && input.is_major !== current.is_major) authorize(user, 'problem.flag_major');
    await validateReferences(db, input);
    await checkAssigneeInTeam(db, input.team_id !== undefined ? input.team_id : current.team_id, input.assignee_id !== undefined ? input.assignee_id : current.assignee_id);
    const changed = Object.entries(input).filter(([k, v]) => v !== undefined && current[k] !== v);
    if (!changed.length) return;
    await db.query(
      `UPDATE problems SET ${changed.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
      [current.id, ...changed.map(([, v]) => v)],
    );
    // Full before/after, also for long texts, so no earlier version is ever lost.
    const data = Object.fromEntries(changed.map(([k, v]) => [k, { from: current[k] ?? null, to: v }]));
    await trackProposals(db, current.id, changed.map(([k]) => k));
    if (input.assignee_id) await watch(db, current.id, input.assignee_id);
    await logActivity(db, current.id, user.id, 'update', `Updated ${changed.map(([k]) => k).join(', ')}`, data);
  });
  return getProblem(ref);
}

export async function transitionProblem(user: User, ref: string, input: z.infer<typeof transitionSchema>) {
  authorize(user, 'problem.transition');
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
    const texts = Object.fromEntries(
      (['root_cause', 'workaround', 'resolution', 'major_review'] as const)
        .filter((k) => fields[k] !== current[k])
        .map((k) => [k, { from: current[k], to: fields[k] }]),
    );
    await trackProposals(db, current.id, Object.keys(texts));
    await logActivity(db, current.id, user.id, 'status', input.comment ?? '', { from, to: input.to, closure_code, ...texts });
  });
  return getProblem(ref);
}

export async function addComment(user: User, ref: string, body: string) {
  authorize(user, 'problem.comment');
  if (!body.trim()) throw badRequest('Comment cannot be empty');
  await tx(async (db) => {
    const current = await loadForUpdate(db, ref);
    await logActivity(db, current.id, user.id, 'comment', body.trim());
    await db.query('UPDATE problems SET updated_at = now() WHERE id = $1', [current.id]);
  });
  return getProblem(ref);
}

export async function addLink(user: User, ref: string, input: z.infer<typeof linkSchema>) {
  authorize(user, 'problem.link');
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
  authorize(user, 'problem.link');
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
    where.push(textFilterSql('p', 'problem', terms.map((t) => `${t}:*`).join(' & '), params));
  }
  const { rows } = await query(`${SELECT_PROBLEM} WHERE ${where.join(' AND ')} ORDER BY p.priority, p.known_error_at DESC LIMIT 200`, params);
  return rows;
}

export async function dashboard(user: User) {
  const [byStatus, byPriority, aging, mine, recent, links, myActions, actionSummary, watched] = await Promise.all([
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
    query(`SELECT a.id, a.kind, a.body, a.data, a.created_at, u.display_name AS user_name, p.ref, p.title
           FROM problem_activity a JOIN problems p ON p.id = a.problem_id LEFT JOIN users u ON u.id = a.user_id
           JOIN problem_watchers w ON w.problem_id = a.problem_id AND w.user_id = $1
           WHERE a.user_id IS DISTINCT FROM $1 AND a.created_at > now() - interval '14 days'
           ORDER BY a.created_at DESC, a.id DESC LIMIT 10`, [user.id]),
  ]);
  return {
    by_status: Object.fromEntries(byStatus.rows.map((r) => [r.status, r.count])),
    open_by_priority: byPriority.rows,
    open_summary: aging.rows[0],
    open_links_by_kind: Object.fromEntries(links.rows.map((r) => [r.kind, r.count])),
    my_problems: mine.rows,
    my_actions: myActions.rows,
    actions: actionSummary.rows[0],
    watched_activity: watched.rows,
    recent_activity: recent.rows,
  };
}

const assessmentFields = {
  ec_risk_level: z.number().int().min(1).max(3).nullable(),
  ec_risk: z.string().max(20000),
  ec_fix_cost: z.string().max(20000),
  ec_decision: z.enum(EC_DECISIONS).nullable(),
  ec_decision_note: z.string().max(20000),
  ec_review_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable(),
  workaround_effectiveness: z.enum(WORKAROUND_EFFECTIVENESS).nullable(),
};
export const assessmentSchema = z.object(assessmentFields).partial().extend({ base: z.object(assessmentFields).partial().optional() });

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
export async function assessProblem(user: User, ref: string, { base, ...input }: z.infer<typeof assessmentSchema>) {
  authorize(user, 'problem.assess');
  if (input.ec_decision === 'accept' || input.ec_decision === 'defer') authorize(user, 'problem.accept_risk');
  await tx(async (db) => {
    const current = await loadForUpdate(db, ref);
    if (current.status === 'closed') throw conflict('Reopen the problem before changing its assessment');
    await checkBase(db, current.id, { ...current, ec_review_date: current.ec_review_date }, input, base);
    if (current.status === 'new' || current.status === 'analysis') {
      if (input.ec_decision) throw conflict('Raise the problem as a known error before recording a decision');
    }
    const currentReview = current.ec_review_date;
    const changed = Object.entries(input).filter(([k, v]) => v !== undefined && (k === 'ec_review_date' ? currentReview : current[k]) !== v);
    if (!changed.length) return;
    const sets = changed.map(([k], i) => `${k} = $${i + 2}`);
    const decisionChanged = input.ec_decision !== undefined && input.ec_decision !== current.ec_decision;
    // Only actual decisions (not "pending") record who decided and when.
    const decided = !!input.ec_decision && input.ec_decision !== 'pending';
    if (decisionChanged) sets.push(`ec_decided_by = ${decided ? user.id : 'NULL'}`, `ec_decided_at = ${decided ? 'now()' : 'NULL'}`);
    if (input.workaround_effectiveness !== undefined) sets.push('workaround_reviewed_at = now()');
    await db.query(`UPDATE problems SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, [current.id, ...changed.map(([, v]) => v)]);
    const body = decisionChanged && decided
      ? `Recorded decision: ${input.ec_decision}`
      : `Updated error control assessment (${changed.map(([k]) => ASSESSMENT_LABELS[k]).join(', ')})`;
    await trackProposals(db, current.id, changed.map(([k]) => k));
    await logActivity(db, current.id, user.id, 'assessment', body, Object.fromEntries(changed.map(([k, v]) => [k, { from: current[k] ?? null, to: v }])));
  });
  return getProblem(ref);
}

// Words too common to say anything about similarity.
const STOPWORDS = new Set(
  'the and for with from that this are was were has have not but when after before into onto over under about than then there their they them our you your can cannot does did doing during each some such only same other more most very also just been being which while where what who how why all any both few its it’s off out own too again further once here same should would could will shall may might must per via'.split(' '),
);

/** Problems similar to a free text (e.g. a draft title and description), best matches first. */
/** Problems like this text; a confidential problem the viewer may not read matches on its title only (#61). */
export async function findSimilar(viewer: { id: number } | null, text: string, excludeRef?: string, limit = 5) {
  const words = [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOPWORDS.has(w)))].slice(0, 16);
  if (!words.length) return [];
  const { rows } = await query(
    `WITH q AS (SELECT to_tsquery('simple', $1) AS q)
     SELECT p.ref, p.title, p.status, p.priority, p.affected_service, p.workaround, p.root_cause,
            round(ts_rank(p.search, q.q)::numeric, 4)::float AS score
     FROM problems p, q
     WHERE p.search @@ q.q AND ($2::text IS NULL OR p.ref <> $2)
     ORDER BY ts_rank(p.search, q.q) * CASE p.status WHEN 'known_error' THEN 1.5 WHEN 'closed' THEN 0.6 ELSE 1 END DESC, p.updated_at DESC
     LIMIT $3`,
    [words.map((w) => `${w}:*`).join(' | '), excludeRef?.toUpperCase() ?? null, limit],
  );
  // Require a reasonable overlap so a single shared word does not count as similar.
  return onlyTitleMatches(viewer, rows.filter((r) => r.score >= 0.03 || words.length <= 2), text);
}

/**
 * Marks a problem as a duplicate of another: links the two, copies its incident/event links to the original,
 * and closes it with closure code "duplicate". Closing is reserved for problem managers.
 */
export async function markDuplicate(user: User, ref: string, ofRef: string) {
  authorize(user, 'problem.mark_duplicate');
  if (ref.toUpperCase() === ofRef.toUpperCase()) throw badRequest('A problem cannot be a duplicate of itself');
  await tx(async (db) => {
    const dup = await loadForUpdate(db, ref);
    const original = await loadForUpdate(db, ofRef);
    if (dup.status === 'closed') throw conflict(`${dup.ref} is already closed`);
    if (original.status === 'closed') throw conflict(`${original.ref} is closed; reopen it or pick another problem`);
    const link = (from: { id: number }, to: { ref: string }, note: string) =>
      db.query(
        `INSERT INTO problem_links (problem_id, kind, reference, note, created_by) VALUES ($1, 'problem', $2, $3, $4) ON CONFLICT DO NOTHING`,
        [from.id, to.ref, note, user.id],
      );
    await link(dup, original, 'Duplicate of');
    await link(original, dup, 'Duplicate');
    const { rowCount: moved } = await db.query(
      `INSERT INTO problem_links (problem_id, kind, reference, system, url, note, created_by)
       SELECT $1, kind, reference, system, url, note, $3 FROM problem_links WHERE problem_id = $2 AND kind IN ('incident', 'event')
       ON CONFLICT DO NOTHING`,
      [original.id, dup.id, user.id],
    );
    await db.query('UPDATE external_records SET problem_id = $1 WHERE problem_id = $2', [original.id, dup.id]);
    await db.query(
      `UPDATE problems SET status = 'closed', closure_code = 'duplicate', closed_at = now(), updated_at = now() WHERE id = $1`,
      [dup.id],
    );
    await logActivity(db, dup.id, user.id, 'status', `Duplicate of ${original.ref}`, { from: dup.status, to: 'closed', closure_code: 'duplicate', duplicate_of: original.ref });
    await logActivity(db, original.id, user.id, 'link', `Merged duplicate ${dup.ref}${moved ? ` (${moved} incident/event link${moved === 1 ? '' : 's'} moved)` : ''}`, { duplicate: dup.ref });
    await db.query('UPDATE problems SET updated_at = now() WHERE id = $1', [original.id]);
  });
  return getProblem(ofRef);
}

// ---- Record type registration (see records.ts and docs/api-conventions.md) ---------------------------

const PROBLEM_TYPE: RecordType = {
  type: 'problem',
  prefix: 'PRB',
  readAction: 'problem.read',
  uiPath: (ref) => `/problems/${ref}`,
  get: (_user, ref) => getProblem(ref),
  search: async (_user, q, limit) =>
    (await listProblems(listSchema.parse({ q, status: 'all', sort: 'updated', limit }))).map((p) => ({
      type: 'problem',
      ref: p.ref,
      title: p.title,
      status: p.status,
      url: problemUrl(p.ref),
      summary: [p.affected_service, p.category].filter(Boolean).join(' · '),
    })),
  rest: {
    list: '/api/problems',
    create: '/api/problems',
    get: '/api/problems/:ref',
    update: '/api/problems/:ref',
    transition: '/api/problems/:ref/transition',
    links: '/api/problems/:ref/links',
    comments: '/api/problems/:ref/comments',
  },
  mcp: { list: 'search_problems', get: 'get_problem', create: 'create_problem', update: 'update_problem', transition: 'transition_problem' },
};
registerRecordType(PROBLEM_TYPE);

function problemUrl(ref: string) {
  return recordUrl(PROBLEM_TYPE, ref);
}
