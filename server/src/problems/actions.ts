// Follow-up actions (e.g. "vendor to deliver patch", "add alerting"), with owner and due date: their own register
// (#184). An action hangs off a record of a kind in the record registry – a problem, an incident, a change, a request,
// an improvement or a post-incident review – and is visible to whoever can see that record (row-level security).
import { notify } from '../notifications/notifications.js';
import { z } from 'zod';
import { logActivity } from '../records/activity.js';
import type { User } from '../security/auth.js';
import { type Db, query, tx } from '../core/db.js';
import { badRequest, notFound } from '../core/errors.js';
import { assertMayWriteText } from '../security/confidential.js';
import { authorize, can } from '../security/policy.js';
import { recordType, typeForRef } from '../records/records.js';

export const ACTION_STATUSES = ['open', 'done', 'cancelled'] as const;
/** The kinds an action can hang off (migration 157 checks the same list). */
export const ACTION_PARENTS = ['problem', 'incident', 'change', 'request', 'improvement', 'review'] as const;
export type ParentKind = (typeof ACTION_PARENTS)[number];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const actionFields = {
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20000),
  owner_id: z.number().int().nullable(),
  due_date: date.nullable(),
  status: z.enum(ACTION_STATUSES),
  change_ref: z.string().trim().max(200),
};

export const createActionSchema = z.object(actionFields).partial().required({ title: true });
export const updateActionSchema = z.object(actionFields).partial();
/** POST /api/actions: the action and the record it follows up, by ref. */
export const newActionSchema = createActionSchema.extend({ parent: z.string().trim().min(1).max(30) });
export const listActionsSchema = z.object({
  status: z.enum([...ACTION_STATUSES, 'all']).default('open'),
  owner_id: z.coerce.number().int().optional(),
  overdue: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  /** The actions of one record, by its ref. */
  parent: z.string().trim().max(30).optional(),
  /** The actions on records of one kind. */
  parent_kind: z.enum(ACTION_PARENTS).optional(),
  /** The records one bulk request changed (#125), as its summary notification links to them. */
  bulk: z.uuid().optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const isParent = (kind: string): kind is ParentKind => (ACTION_PARENTS as readonly string[]).includes(kind);

/** The parent kinds whose records this user may read (a switched-off module's records are not readable). */
const readableKinds = (user: User) => ACTION_PARENTS.filter((k) => can(user.role, recordType(k).readAction));

/**
 * Every action with its parent's ref and title, from the registry: each kind's table, and for a kind whose notes go
 * in another record's (a review, its incident's) that record's title. `ref` is the parent's ref, so confidential
 * masking (#61) follows the parent; `problem_id` and `problem_title` stay for problem parents (the API before #184).
 */
function parentColumns() {
  const joins: string[] = [];
  const refs: string[] = [];
  const titles: string[] = [];
  for (const kind of ACTION_PARENTS) {
    const t = recordType(kind);
    joins.push(`LEFT JOIN ${t.table} p_${kind} ON a.parent_kind = '${kind}' AND p_${kind}.id = a.parent_id`);
    refs.push(`p_${kind}.ref`);
    if (t.notesIn) {
      const owner = recordType(t.notesIn.type);
      joins.push(`LEFT JOIN ${owner.table} n_${kind} ON n_${kind}.id = p_${kind}.${t.notesIn.fk}`);
      titles.push(`n_${kind}.title`);
    } else titles.push(`p_${kind}.title`);
  }
  return { joins: joins.join('\n  '), ref: `coalesce(${refs.join(', ')})`, title: `coalesce(${titles.join(', ')})` };
}

function selectAction() {
  const parent = parentColumns();
  return `
  SELECT a.id, a.parent_kind, a.parent_id, ${parent.ref} AS ref, ${parent.title} AS parent_title,
         CASE WHEN a.parent_kind = 'problem' THEN a.parent_id END AS problem_id,
         CASE WHEN a.parent_kind = 'problem' THEN p_problem.title END AS problem_title,
         a.title, a.description, a.owner_id, o.display_name AS owner, a.due_date::text AS due_date, a.status, a.change_ref,
         (a.status = 'open' AND a.due_date < current_date) AS overdue,
         cb.display_name AS created_by, a.created_at, a.updated_at, a.completed_at
  FROM actions a
  ${parent.joins}
  LEFT JOIN users o ON o.id = a.owner_id
  LEFT JOIN users cb ON cb.id = a.created_by`;
}

/** Each row with the path of its parent in the web UI. */
const withPath = (rows: any[]) => rows.map((r) => ({ ...r, path: recordType(r.parent_kind).uiPath(r.ref) }));

async function selectActions(where: string[], params: unknown[], tail: string) {
  const { rows } = await query(`${selectAction()} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ${tail}`, params);
  return withPath(rows);
}

async function validateOwner(db: Db, ownerId: number | null | undefined) {
  if (ownerId == null) return;
  const { rows } = await db.query('SELECT 1 FROM users WHERE id = $1 AND active', [ownerId]);
  if (!rows[0]) throw badRequest('Owner must be an active user');
}

export async function listActions(user: User, filter: z.infer<typeof listActionsSchema>) {
  authorize(user, 'action.read');
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };
  add('a.parent_kind = ANY(?)', readableKinds(user));
  if (filter.status !== 'all') add('a.status = ?', filter.status);
  if (filter.owner_id !== undefined) add('a.owner_id = ?', filter.owner_id);
  if (filter.parent_kind) add('a.parent_kind = ?', filter.parent_kind);
  if (filter.parent) {
    const p = await findParent(user, filter.parent);
    add('a.parent_kind = ?', p.kind);
    add('a.parent_id = ?', p.id);
  }
  if (filter.bulk) add('a.id::text IN (SELECT unnest(refs) FROM bulk_requests WHERE id = ?)', filter.bulk);
  if (filter.overdue) where.push("a.status = 'open' AND a.due_date < current_date");
  if (filter.q) {
    const parent = parentColumns();
    add(`(a.title ILIKE ? OR ${parent.ref} ILIKE ? OR ${parent.title} ILIKE ?)`, `%${filter.q}%`);
  }
  params.push(filter.limit);
  return selectActions(where, params, `ORDER BY a.status = 'open' DESC, a.due_date NULLS LAST, a.id LIMIT $${params.length}`);
}

/** The actions on one record, open first, the next due first. */
export const actionsOf = async (kind: ParentKind, id: number) =>
  selectActions(['a.parent_kind = $1', 'a.parent_id = $2'], [kind, id], "ORDER BY a.status = 'open' DESC, a.due_date NULLS LAST, a.id");

/** One action by its id, as its viewer sees it. */
export async function getAction(user: User, id: number) {
  authorize(user, 'action.read');
  if (!Number.isInteger(id)) throw notFound('Action not found');
  const [row] = await selectActions(['a.id = $1', 'a.parent_kind = ANY($2)'], [id, readableKinds(user)], '');
  if (!row) throw notFound('Action not found');
  return row;
}

/** Open actions on records of these kinds that are overdue (the problem review agenda), the oldest due first. */
export const overdueActions = async (kinds: readonly ParentKind[]) =>
  selectActions(["a.status = 'open'", 'a.due_date < current_date', 'a.parent_kind = ANY($1)'], [kinds], 'ORDER BY a.due_date');

/** My Work (#110): my open follow-up actions, the next due first. */
export const myActions = async (user: User, limit = 50) =>
  selectActions(['a.owner_id = $1', "a.status = 'open'", 'a.parent_kind = ANY($2)'], [user.id, readableKinds(user)], `ORDER BY a.due_date NULLS LAST, a.id LIMIT ${limit}`);

/** The menu badges and the dashboard: open actions, my open actions and the overdue ones. */
export async function actionCounts(user: User) {
  const { rows } = await query(
    `SELECT count(*)::int AS open, count(*) FILTER (WHERE owner_id = $1)::int AS mine, count(*) FILTER (WHERE due_date < current_date)::int AS overdue
     FROM actions WHERE status = 'open' AND parent_kind = ANY($2)`,
    [user.id, readableKinds(user)],
  );
  return rows[0] as { open: number; mine: number; overdue: number };
}

/** How many actions on this record are still open (closing a problem asks about them). */
export async function openActionCount(db: Db, kind: ParentKind, id: number) {
  const { rows } = await db.query("SELECT count(*)::int AS n FROM actions WHERE parent_kind = $1 AND parent_id = $2 AND status = 'open'", [kind, id]);
  return rows[0].n as number;
}

/** These actions, those the caller can see (RLS), with their parents (an improvement's links to actions). */
export const actionsById = async (ids: number[]) => selectActions(['a.id = ANY($1::int[])'], [ids], 'ORDER BY a.id');

// ---- Writing ---------------------------------------------------------------------------------

export interface Parent { kind: ParentKind; id: number; ref: string }

/** The record an action follows up, by its ref through the registry; RLS hides what the caller cannot see. */
async function findParent(user: User, ref: string, db: Db = { query } as unknown as Db, lock = false, kind?: ParentKind): Promise<Parent> {
  const t = typeForRef(ref);
  if (kind && t.type !== kind) throw notFound(`${ref.toUpperCase()} not found`);
  if (!isParent(t.type)) throw badRequest(`Actions follow up problems, incidents, changes, requests, improvements and reviews, not a ${t.type}`);
  authorize(user, t.readAction);
  const { rows } = await db.query(`SELECT id, ref FROM ${t.table} WHERE ref = $1${lock ? ' FOR UPDATE' : ''}`, [ref.toUpperCase()]);
  if (!rows[0]) throw notFound(`${ref.toUpperCase()} not found`);
  return { kind: t.type, id: rows[0].id, ref: rows[0].ref };
}

/** The parent of an action, locked, by the action's id. */
async function parentOfAction(db: Db, actionId: number): Promise<Parent & { action: any }> {
  if (!Number.isInteger(actionId)) throw notFound('Action not found');
  const { rows } = await db.query('SELECT * FROM actions WHERE id = $1', [actionId]);
  const action = rows[0];
  if (!action) throw notFound('Action not found');
  const t = recordType(action.parent_kind);
  const { rows: p } = await db.query(`SELECT id, ref FROM ${t.table} WHERE id = $1 FOR UPDATE`, [action.parent_id]);
  if (!p[0]) throw notFound('Action not found');
  return { kind: action.parent_kind, id: p[0].id, ref: p[0].ref, action };
}

/**
 * An entry in the parent's history (a review's goes in its incident's, tagged with the review), then the parent's
 * updated_at. The parent's own `after` hook does the rest: audit, rules, webhooks for problems.
 */
async function logOnParent(db: Db, p: Parent, userId: number, body: string, data: object) {
  const t = recordType(p.kind);
  if (t.notesIn) {
    const { rows } = await db.query(`SELECT ${t.notesIn.fk} AS id FROM ${t.table} WHERE id = $1`, [p.id]);
    await logActivity(db, t.notesIn.type, rows[0].id, userId, 'action', body, { ...data, [p.kind]: p.ref });
  } else await logActivity(db, p.kind, p.id, userId, 'action', body, data);
  await db.query(`UPDATE ${t.table} SET updated_at = now() WHERE id = $1`, [p.id]);
}

const assignedNotice = (p: Parent, ownerId: number, title: string, actorId: number, dedupe: string) => ({
  users: [ownerId], event: 'assigned' as const, ref: p.ref, title, summary: `An action on ${p.ref} was assigned to you.`,
  path: recordType(p.kind).uiPath(p.ref), dedupe, actorId,
});

/** Adds an action to a record the caller has locked (or finds and locks it by ref); returns its id. */
export async function insertAction(db: Db, user: User, parent: Parent | string, input: z.infer<typeof createActionSchema>) {
  authorize(user, 'action.write');
  const p = typeof parent === 'string' ? await findParent(user, parent, db, true) : parent;
  await validateOwner(db, input.owner_id);
  const cols = Object.keys(input);
  const { rows } = await db.query(
    `INSERT INTO actions (${[...cols, 'parent_kind', 'parent_id', 'created_by'].join(', ')})
     VALUES (${[...cols, 'k', 'p', 'c'].map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    [...Object.values(input), p.kind, p.id, user.id],
  );
  const id = rows[0].id as number;
  await logOnParent(db, p, user.id, `Added action: ${input.title}`, { action_id: id, change: 'added' });
  if (input.owner_id) await notify(db, assignedNotice(p, input.owner_id, input.title, user.id, `action:${id}:${input.owner_id}`));
  return id;
}

/** Adds an action to the record `ref` names (of this kind, when given); returns the action. */
export async function createAction(user: User, ref: string, input: z.infer<typeof createActionSchema>, kind?: ParentKind) {
  authorize(user, 'action.write');
  const id = await tx(async (db) => insertAction(db, user, await findParent(user, ref, db, true, kind), input));
  return getAction(user, id);
}

/**
 * Changes an action, or completes, cancels or reopens it through its status. When `ref` is given the action must be
 * on that record (the problem routes before #184). Returns the action.
 */
export async function updateAction(user: User, actionId: number, input: z.infer<typeof updateActionSchema>, ref?: string) {
  authorize(user, 'action.write');
  await tx(async (db) => {
    const { action: current, ...p } = await parentOfAction(db, actionId);
    if (ref && p.ref !== ref.toUpperCase()) throw notFound('Action not found');
    authorize(user, recordType(p.kind).readAction);
    // No blind overwrites of masked text (#61, #156).
    await assertMayWriteText(user, p.ref, input);
    await validateOwner(db, input.owner_id);
    const changed = Object.entries(input).filter(([k, v]) => v !== undefined && current[k] !== v);
    if (!changed.length) return;
    const statusChange = input.status !== undefined && input.status !== current.status;
    await db.query(
      `UPDATE actions SET ${changed.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now(),
         completed_at = ${statusChange ? (input.status === 'open' ? 'NULL' : 'now()') : 'completed_at'}
       WHERE id = $1`,
      [actionId, ...changed.map(([, v]) => v)],
    );
    const title = input.title ?? current.title;
    if (input.owner_id && input.owner_id !== current.owner_id) {
      await notify(db, assignedNotice(p, input.owner_id, title, user.id, `action:${actionId}:${input.owner_id}:${Date.now()}`));
    }
    const body = statusChange
      ? `${input.status === 'done' ? 'Completed' : input.status === 'cancelled' ? 'Cancelled' : 'Reopened'} action: ${title}`
      : `Updated action: ${title}`;
    await logOnParent(db, p, user.id, body, {
      action_id: actionId,
      change: statusChange ? input.status : 'updated',
      fields: changed.map(([k]) => k),
    });
  });
  return getAction(user, actionId);
}
