// Follow-up actions on problems (e.g. "vendor to deliver patch", "add alerting"), with owner and due date.
import { notify } from './notifications.js';
import { z } from 'zod';
import type { User } from './auth.js';
import { query, tx } from './db.js';
import { badRequest, notFound } from './errors.js';
import { assertMayWriteText } from './confidential.js';
import { authorize } from './policy.js';
import { getProblem, loadForUpdate, logActivity, SELECT_ACTION, type Db } from './problems.js';

export const ACTION_STATUSES = ['open', 'done', 'cancelled'] as const;

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
export const listActionsSchema = z.object({
  status: z.enum([...ACTION_STATUSES, 'all']).default('open'),
  owner_id: z.coerce.number().int().optional(),
  overdue: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  /** The records one bulk request changed (#125), as its summary notification links to them. */
  bulk: z.uuid().optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

async function validateOwner(db: Db, ownerId: number | null | undefined) {
  if (ownerId == null) return;
  const { rows } = await db.query('SELECT 1 FROM users WHERE id = $1 AND active', [ownerId]);
  if (!rows[0]) throw badRequest('Owner must be an active user');
}

export async function listActions(filter: z.infer<typeof listActionsSchema>) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (filter.status !== 'all') add('a.status = ?', filter.status);
  if (filter.owner_id !== undefined) add('a.owner_id = ?', filter.owner_id);
  if (filter.bulk) add('a.id::text IN (SELECT unnest(refs) FROM bulk_requests WHERE id = ?)', filter.bulk);
  if (filter.overdue) where.push("a.status = 'open' AND a.due_date < current_date");
  if (filter.q) {
    params.push(`%${filter.q}%`);
    const n = `$${params.length}`;
    where.push(`(a.title ILIKE ${n} OR p.ref ILIKE ${n} OR p.title ILIKE ${n})`);
  }
  params.push(filter.limit);
  const { rows } = await query(
    `${SELECT_ACTION} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY a.status = 'open' DESC, a.due_date NULLS LAST, a.id LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export async function createAction(user: User, ref: string, input: z.infer<typeof createActionSchema>) {
  authorize(user, 'action.write');
  await tx(async (db) => insertAction(db, user, await loadForUpdate(db, ref), input));
  return getProblem(ref);
}

/** Adds an action to a problem the caller has locked; returns its id. Post-incident reviews (#109) use it too. */
export async function insertAction(db: Db, user: User, problem: { id: number; ref: string }, input: z.infer<typeof createActionSchema>) {
  authorize(user, 'action.write');
  await validateOwner(db, input.owner_id);
  const cols = Object.keys(input);
  const { rows } = await db.query(
    `INSERT INTO problem_actions (${[...cols, 'problem_id', 'created_by'].join(', ')})
     VALUES (${[...cols, 'p', 'c'].map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    [...Object.values(input), problem.id, user.id],
  );
  await logActivity(db, problem.id, user.id, 'action', `Added action: ${input.title}`, { action_id: rows[0].id, change: 'added' });
  if (input.owner_id) {
    await notify(db, { users: [input.owner_id], event: 'assigned', ref: problem.ref, title: input.title, summary: `An action on ${problem.ref} was assigned to you.`, path: `/problems/${problem.ref}`, dedupe: `action:${rows[0].id}:${input.owner_id}`, actorId: user.id });
  }
  await db.query('UPDATE problems SET updated_at = now() WHERE id = $1', [problem.id]);
  return rows[0].id as number;
}

export async function updateAction(user: User, ref: string, actionId: number, input: z.infer<typeof updateActionSchema>) {
  authorize(user, 'action.write');
  // No blind overwrites of masked text (#61, #156).
  await assertMayWriteText(user, ref, input);
  await tx(async (db) => {
    const problem = await loadForUpdate(db, ref);
    const { rows } = await db.query('SELECT * FROM problem_actions WHERE id = $1 AND problem_id = $2', [actionId, problem.id]);
    const current = rows[0];
    if (!current) throw notFound('Action not found');
    await validateOwner(db, input.owner_id);
    const changed = Object.entries(input).filter(([k, v]) => v !== undefined && current[k] !== v);
    if (!changed.length) return;
    const statusChange = input.status !== undefined && input.status !== current.status;
    await db.query(
      `UPDATE problem_actions SET ${changed.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now(),
         completed_at = ${statusChange ? (input.status === 'open' ? 'NULL' : 'now()') : 'completed_at'}
       WHERE id = $1`,
      [actionId, ...changed.map(([, v]) => v)],
    );
    const title = input.title ?? current.title;
    if (input.owner_id && input.owner_id !== current.owner_id) {
      await notify(db, { users: [input.owner_id], event: 'assigned', ref: problem.ref, title, summary: `An action on ${problem.ref} was assigned to you.`, path: `/problems/${problem.ref}`, dedupe: `action:${actionId}:${input.owner_id}:${Date.now()}`, actorId: user.id });
    }
    const body = statusChange
      ? `${input.status === 'done' ? 'Completed' : input.status === 'cancelled' ? 'Cancelled' : 'Reopened'} action: ${title}`
      : `Updated action: ${title}`;
    await logActivity(db, problem.id, user.id, 'action', body, {
      action_id: actionId,
      change: statusChange ? input.status : 'updated',
      fields: changed.map(([k]) => k),
    });
    await db.query('UPDATE problems SET updated_at = now() WHERE id = $1', [problem.id]);
  });
  return getProblem(ref);
}
