// Sprints, the board, burndown and retrospectives (#166, epic #164). A sprint belongs to one team and goes
// planned → active → completed, at most one active per team. Planning puts items from the team's backlog into it,
// with the sum of points against the capacity (a warning, not a block); completing sends the unfinished items back to
// the backlog or on to the next sprint, one choice per item, logged on each. Kanban teams use the same board without
// sprints, with WIP limits per column. Each item's stay in a sprint is kept (sprint_items), so the burndown, the
// velocity and the unplanned share come from what happened, read through row-level security like everything else.
// Shared by REST, MCP and the web UI; off unless the development module is on.
import { z } from 'zod';
import type { User } from '../security/auth.js';
import { audit } from '../security/audit.js';
import { type Db, query, tx } from '../core/db.js';
import { badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { createImprovementInTx } from '../improvements/improvements.js';
import { BROADEST, startNarrow } from '../security/audience.js';
import { authorize, can } from '../security/policy.js';
import { teamScoped } from '../security/visibility.js';
import { validTeam } from '../people/teams.js';
import { logActivity } from '../records/activity.js';
import { seeingAll } from '../security/visibility.js';
import { BOARD_COLUMNS, leaveSprint, refuseSourceOwned, WORK_ITEM_TRANSITIONS, wipLimitsOf, workItemUrl, type WorkItemStatus } from './work-items.js';

export const SPRINT_STATUSES = ['planned', 'active', 'completed'] as const;
const RETRO_KINDS = ['went_well', 'hard', 'to_change'] as const;
/** How long a done item stays on a Kanban board, which has no sprint end to clear it. */
const KANBAN_DONE_DAYS = 14;
const VELOCITY_SPRINTS = 6;
type SprintStatus = (typeof SPRINT_STATUSES)[number];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const ref = z.string().trim().min(1).max(30);
const fields = {
  name: z.string().trim().min(1).max(100),
  goal: z.string().max(2000),
  starts_on: date,
  ends_on: date,
  /** Story points the team expects to finish. */
  capacity: z.number().int().min(1).max(999).nullable(),
};
export const createSprintSchema = z.object({ team_id: z.number().int(), ...fields }).partial().required({ team_id: true, name: true, starts_on: true, ends_on: true });
export const updateSprintSchema = z.object({ ...fields, review_notes: z.string().max(20000) }).partial();
export const listSprintsSchema = z.object({
  team: z.coerce.number().int().optional(),
  /** open is planned and active. */
  status: z.enum([...SPRINT_STATUSES, 'open', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const sprintItemsSchema = z
  .object({ add: z.array(ref).max(100).default([]), remove: z.array(ref).max(100).default([]) })
  .refine((s) => s.add.length + s.remove.length > 0, { message: 'Give items to add or remove' });
export const completeSprintSchema = z.object({
  /** Where each unfinished item goes (WI… → choice); the ones left out go back to the backlog. */
  unfinished: z.record(ref, z.enum(['backlog', 'next_sprint'])).default({}),
  /** The planned sprint that next_sprint means; by default the team's next one by start date. */
  next_sprint_id: z.number().int().optional(),
});
export const retroItemSchema = z.object({ kind: z.enum(RETRO_KINDS), body: z.string().trim().min(1).max(2000) });
export const retroImprovementSchema = z.object({ title: z.string().trim().min(1).max(300).optional(), owner_id: z.number().int().nullable().optional() });
export const boardSchema = z.object({
  type: z.enum(['epic', 'story', 'bug', 'task']).optional(),
  assignee: z.union([z.literal('me'), z.literal('none'), z.coerce.number().int()]).optional(),
  label: z.string().trim().max(50).optional(),
});

const logItem = (db: Db, id: number, userId: number, body: string, data: object) => logActivity(db, 'work_item', id, userId, 'sprint', body, data);

async function loadSprint(db: Db, id: number) {
  const { rows } = await db.query('SELECT s.*, t.name AS team FROM sprints s JOIN teams t ON t.id = s.team_id WHERE s.id = $1 FOR UPDATE OF s', [id]);
  if (!rows[0]) throw notFound('Sprint not found');
  return rows[0];
}

/** A sprint the caller can see (row-level security), or 404. */
async function visibleSprint(id: number) {
  const { rows } = await query('SELECT 1 FROM sprints WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Sprint not found');
}

function checkDates(startsOn: string, endsOn: string) {
  if (endsOn < startsOn) throw badRequest('A sprint ends on or after the day it starts');
}

// ---- The numbers ------------------------------------------------------------------------------
//
// A stay is in the sprint's scope while it is there, and at the end when it left with the sprint's completion (its
// outcome). An active sprint counts the items as they are now; a completed one counts what was kept when it ended,
// so its numbers do not move later. Stays the reader may not see are left out (row-level security).

const FROZEN = "(si.removed_at IS NOT NULL OR s.status = 'completed')";
const POINTS = `coalesce(CASE WHEN ${FROZEN} THEN si.points ELSE w.points END, 0)`;
const IN_SCOPE = '(si.removed_at IS NULL OR si.outcome IS NOT NULL)';
const DONE = "(CASE WHEN s.status = 'completed' THEN si.outcome = 'done' ELSE w.status = 'done' END)";
const DONE_AT = "(CASE WHEN s.status = 'completed' THEN si.done_at WHEN w.status = 'done' THEN w.done_at END)";

/** Committed, scope, completed and unplanned points (and items) per sprint. */
async function totals(ids: number[]) {
  if (!ids.length) return new Map<number, Totals>();
  const { rows } = await query(
    `SELECT s.id, coalesce(sum(si.points_at_start), 0)::int AS committed,
            coalesce(sum(${POINTS}) FILTER (WHERE ${IN_SCOPE}), 0)::int AS scope,
            coalesce(sum(${POINTS}) FILTER (WHERE ${IN_SCOPE} AND ${DONE}), 0)::int AS completed,
            coalesce(sum(${POINTS}) FILTER (WHERE ${IN_SCOPE} AND si.unplanned), 0)::int AS unplanned,
            count(si.id) FILTER (WHERE ${IN_SCOPE})::int AS items, count(si.id) FILTER (WHERE ${IN_SCOPE} AND ${DONE})::int AS items_done
     FROM sprints s LEFT JOIN sprint_items si ON si.sprint_id = s.id LEFT JOIN work_items w ON w.id = si.work_item_id
     WHERE s.id = ANY($1) GROUP BY s.id`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id as number, r as Totals]));
}
interface Totals { committed: number; scope: number; completed: number; unplanned: number; items: number; items_done: number }

const share = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 10 : null);

/**
 * Points left at the end of each day of the sprint, up to today (or the day it was completed), and the ideal line
 * from the points committed at the start down to nothing on the last day. Null before the sprint starts.
 */
async function burndown(s: { id: number; status: SprintStatus; starts_on: string; ends_on: string }, committed: number) {
  if (s.status === 'planned') return null;
  const { rows } = await query(
    `WITH d AS (SELECT gs::date AS day FROM generate_series($2::date, $3::date, interval '1 day') gs)
     SELECT d.day::text AS day,
            CASE WHEN d.day > least(current_date, coalesce(s.completed_at::date, current_date)) THEN NULL ELSE (
              SELECT coalesce(sum(${POINTS}), 0)::int FROM sprint_items si JOIN work_items w ON w.id = si.work_item_id
              WHERE si.sprint_id = s.id AND si.added_at < d.day + 1
                AND (si.removed_at IS NULL OR si.removed_at >= d.day + 1 OR si.outcome IS NOT NULL)
                AND NOT coalesce(${DONE} AND ${DONE_AT} < d.day + 1, false)) END AS left
     FROM d CROSS JOIN sprints s WHERE s.id = $1 ORDER BY d.day`,
    [s.id, s.starts_on, s.ends_on],
  );
  const last = Math.max(rows.length - 1, 1);
  return rows.map((r, i) => ({ day: r.day as string, left: r.left as number | null, ideal: Math.round((committed * (last - i) / last) * 10) / 10 }));
}

/** Committed against completed points for the team's last six completed sprints, up to this one; oldest first. */
async function velocity(teamId: number, upTo: number | null) {
  const { rows } = await query(
    `SELECT id, name, completed_at FROM sprints WHERE team_id = $1 AND status = 'completed' AND ($2::int IS NULL OR completed_at <= (SELECT completed_at FROM sprints WHERE id = $2))
     ORDER BY completed_at DESC LIMIT ${VELOCITY_SPRINTS}`,
    [teamId, upTo],
  );
  const t = await totals(rows.map((r) => r.id));
  const sprints = rows.reverse().map((r) => ({ id: r.id, name: r.name, committed: t.get(r.id)!.committed, completed: t.get(r.id)!.completed }));
  return { sprints, average: sprints.length ? Math.round(sprints.reduce((a, s) => a + s.completed, 0) / sprints.length) : null };
}

// ---- Reading ---------------------------------------------------------------------------------

const SELECT = `SELECT s.id, s.team_id, t.name AS team, s.name, s.goal, s.starts_on::text AS starts_on, s.ends_on::text AS ends_on, s.capacity, s.status,
                       s.review_notes, s.started_at, s.completed_at, s.created_at, s.updated_at
                FROM sprints s JOIN teams t ON t.id = s.team_id`;

function summary(s: any, t: Totals | undefined) {
  const n = t ?? { committed: 0, scope: 0, completed: 0, unplanned: 0, items: 0, items_done: 0 };
  return {
    ...s,
    points: {
      committed: s.status === 'planned' ? null : n.committed, scope: n.scope, completed: n.completed, left: n.scope - n.completed,
      unplanned: n.unplanned, unplanned_share: s.status === 'planned' ? null : share(n.unplanned, n.scope),
    },
    items: { total: n.items, done: n.items_done },
    over_capacity: s.capacity !== null && n.scope > s.capacity,
  };
}

export async function listSprints(user: User, f: z.infer<typeof listSprintsSchema>) {
  authorize(user, 'work.read');
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.team !== undefined) where.push(`s.team_id = $${params.push(f.team)}`);
  if (f.status === 'open') where.push("s.status IN ('planned', 'active')");
  else if (f.status !== 'all') where.push(`s.status = $${params.push(f.status)}`);
  params.push(f.limit);
  const { rows } = await query(
    `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, CASE WHEN s.status = 'planned' THEN s.starts_on END, s.starts_on DESC, s.id DESC
     LIMIT $${params.length}`,
    params,
  );
  const t = await totals(rows.map((r) => r.id));
  return rows.map((s) => summary(s, t.get(s.id)));
}

export async function getSprint(user: User, id: number) {
  authorize(user, 'work.read');
  const { rows } = await query(`${SELECT} WHERE s.id = $1`, [id]);
  const s = rows[0];
  if (!s) throw notFound('Sprint not found');
  const [t, items, retro, vel] = await Promise.all([
    totals([s.id]),
    query(
      `SELECT w.ref, w.type AS item_type, w.title, w.status, w.points, w.assignee_id, a.display_name AS assignee, si.added_at, si.unplanned, si.outcome
       FROM sprint_items si JOIN work_items w ON w.id = si.work_item_id LEFT JOIN users a ON a.id = w.assignee_id
       WHERE si.sprint_id = $1 AND ${IN_SCOPE} ORDER BY w.rank, w.id`,
      [s.id],
    ),
    query(
      `SELECT r.id, r.kind, r.body, r.created_at, r.created_by, u.display_name AS created_by_name, m.ref AS improvement
       FROM sprint_retro_items r LEFT JOIN users u ON u.id = r.created_by LEFT JOIN improvements m ON m.id = r.improvement_id
       WHERE r.sprint_id = $1 ORDER BY r.created_at, r.id`,
      [s.id],
    ),
    velocity(s.team_id, s.status === 'completed' ? s.id : null),
  ]);
  const sum = summary(s, t.get(s.id));
  return {
    ...sum,
    work_items: items.rows.map((w) => ({ ...w, url: workItemUrl(w.ref) })),
    burndown: await burndown(s, sum.points.committed ?? 0),
    velocity: vel,
    retrospective: retro.rows,
    may_manage_retro: can(user.role, 'work.manage'),
    next_steps: sprintGuidance(sum),
  };
}

/** Guided mode (#37): the sprint's way from planning to the retrospective. */
function sprintGuidance(s: ReturnType<typeof summary>) {
  if (s.status === 'planned') {
    return {
      phase: 'Planned', purpose: 'Agree on a goal and pull in what the team can finish.',
      next: !s.goal.trim() ? 'Write the sprint goal' : s.items.total === 0 ? 'Pull items from the top of the backlog' : s.over_capacity ? 'Take something out: the sprint is over capacity' : 'Start the sprint',
    };
  }
  if (s.status === 'active') return { phase: 'Active', purpose: 'Finish what was planned; the burndown shows how it goes.', next: s.items.total > s.items.done ? 'Move the items across the board' : 'Complete the sprint' };
  return { phase: 'Completed', purpose: 'Look back: what went well, what was hard, what to change.', next: 'Hold the review and the retrospective' };
}

/** The team's board: the active sprint's items, or for a Kanban team without one its open items, in status columns. */
export async function getBoard(user: User, teamId: number, f: z.infer<typeof boardSchema>) {
  authorize(user, 'work.read');
  const team = (await query('SELECT id, name FROM teams WHERE id = $1', [teamId])).rows[0];
  if (!team) throw notFound('Team not found');
  const sprint = (await query("SELECT id, name, goal, starts_on::text AS starts_on, ends_on::text AS ends_on, capacity FROM sprints WHERE team_id = $1 AND status = 'active'", [teamId])).rows[0] ?? null;
  const where = [sprint ? 'w.sprint_id = $1' : `w.team_id = $1 AND w.status <> 'removed' AND (w.status <> 'done' OR w.done_at > now() - interval '${KANBAN_DONE_DAYS} days')`];
  const params: unknown[] = [sprint ? sprint.id : teamId];
  if (f.type) where.push(`w.type = $${params.push(f.type)}`);
  if (f.assignee === 'none') where.push('w.assignee_id IS NULL');
  else if (f.assignee !== undefined) where.push(`w.assignee_id = $${params.push(f.assignee === 'me' ? user.id : f.assignee)}`);
  if (f.label) where.push(`$${params.push(f.label)} = ANY(w.labels)`);
  // Epics are not worked on the board; their stories, bugs and tasks are.
  const { rows } = await query(
    `SELECT w.ref, w.type AS item_type, w.title, w.status, w.points, w.labels, w.assignee_id, a.display_name AS assignee, p.ref AS parent_ref
     FROM work_items w LEFT JOIN users a ON a.id = w.assignee_id LEFT JOIN work_items p ON p.id = w.parent_id
     WHERE w.type <> 'epic' AND ${where.join(' AND ')} ORDER BY w.rank, w.id`,
    params,
  );
  const limits = await wipLimitsOf(teamId);
  return {
    team_id: team.id,
    team: team.name,
    sprint,
    columns: BOARD_COLUMNS.map((status) => {
      const items = rows.filter((w) => w.status === status).map((w) => ({ ...w, transitions: WORK_ITEM_TRANSITIONS[status as WorkItemStatus], url: workItemUrl(w.ref) }));
      const limit = limits[status] ?? null;
      return { status, wip_limit: limit, over_limit: limit !== null && items.length > limit, items };
    }),
  };
}

// ---- Planning ---------------------------------------------------------------------------------

export async function createSprint(user: User, input: z.infer<typeof createSprintSchema>) {
  authorize(user, 'work.write');
  checkDates(input.starts_on, input.ends_on);
  const id = await tx(async (db) => {
    await validTeam(db, input.team_id);
    const { rows } = await db.query(
      'INSERT INTO sprints (team_id, name, goal, starts_on, ends_on, capacity, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [input.team_id, input.name, input.goal ?? '', input.starts_on, input.ends_on, input.capacity ?? null, user.id],
    );
    await audit(db, { entity_type: 'sprint', entity_ref: String(rows[0].id), action: 'create', changes: { team_id: input.team_id, name: input.name, starts_on: input.starts_on, ends_on: input.ends_on } });
    return rows[0].id as number;
  });
  return getSprint(user, id);
}

export async function updateSprint(user: User, id: number, input: z.infer<typeof updateSprintSchema>) {
  authorize(user, 'work.write');
  await tx(async (db) => {
    const s = await loadSprint(db, id);
    checkDates(input.starts_on ?? s.starts_on, input.ends_on ?? s.ends_on);
    const changed = Object.entries(input).filter(([k, v]) => v !== undefined && (s[k] ?? null) !== v);
    if (!changed.length) return;
    if (s.status === 'completed' && changed.some(([k]) => ['starts_on', 'ends_on', 'capacity'].includes(k))) throw conflict('A completed sprint keeps its dates and capacity');
    await db.query(`UPDATE sprints SET ${changed.map(([k], n) => `${k} = $${n + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...changed.map(([, v]) => v)]);
    await audit(db, { entity_type: 'sprint', entity_ref: String(id), action: 'update', changes: Object.fromEntries(changed.map(([k, v]) => [k, { from: s[k] ?? null, to: v }])) });
  });
  return getSprint(user, id);
}

/**
 * Puts items from the team's backlog into a planned or active sprint, or takes them out (back to the backlog). An
 * item added after the start is unplanned work. An item is in one sprint at a time.
 */
export async function planSprint(user: User, id: number, input: z.infer<typeof sprintItemsSchema>) {
  authorize(user, 'work.write');
  await tx(async (db) => {
    const s = await loadSprint(db, id);
    if (s.status === 'completed') throw conflict('The sprint is completed');
    const refs = [...input.add, ...input.remove].map((r) => r.toUpperCase());
    const { rows } = await db.query('SELECT id, ref, type, status, team_id, sprint_id, points, source, mirror_id FROM work_items WHERE ref = ANY($1) FOR UPDATE', [refs]);
    const byRef = new Map(rows.map((w) => [w.ref as string, w]));
    for (const r of refs) if (!byRef.has(r)) throw badRequest(`Work item ${r} not found`);
    // A mirrored item's sprint is its iteration in the source (#168).
    for (const w of rows) refuseSourceOwned(w, ['sprint']);
    for (const r of input.add.map((x) => x.toUpperCase())) {
      const w = byRef.get(r)!;
      if (w.sprint_id === s.id) continue;
      if (w.type === 'epic') throw badRequest(`${r} is an epic: plan its stories and bugs instead`);
      if (w.status === 'done' || w.status === 'removed') throw badRequest(`${r} is ${w.status}`);
      if (w.team_id !== s.team_id) throw badRequest(`${r} is not in ${s.team}'s backlog`);
      if (w.sprint_id) {
        const other = (await db.query("SELECT name FROM sprints WHERE id = $1 AND status <> 'completed'", [w.sprint_id])).rows[0];
        if (other) throw conflict(`${r} is already in ${other.name}: take it out there first`);
      }
      await db.query('INSERT INTO sprint_items (sprint_id, work_item_id, unplanned) VALUES ($1, $2, $3)', [s.id, w.id, s.status === 'active']);
      await db.query('UPDATE work_items SET sprint_id = $2 WHERE id = $1', [w.id, s.id]);
      await logItem(db, w.id, user.id, s.status === 'active' ? `Added to ${s.name} after it started` : `Planned into ${s.name}`, { sprint: { id: s.id, name: s.name }, action: 'add', unplanned: s.status === 'active' });
    }
    for (const r of input.remove.map((x) => x.toUpperCase())) {
      const w = byRef.get(r)!;
      if (w.sprint_id !== s.id) throw badRequest(`${r} is not in ${s.name}`);
      await leaveSprint(db, w.id, s.id);
      await logItem(db, w.id, user.id, `Taken out of ${s.name}, back to the backlog`, { sprint: { id: s.id, name: s.name }, action: 'remove' });
    }
  });
  return getSprint(user, id);
}

export async function startSprint(user: User, id: number) {
  authorize(user, 'work.write');
  await tx(async (db) => {
    const s = await loadSprint(db, id);
    if (s.status !== 'planned') throw conflict(`The sprint is already ${s.status}`);
    const active = (await db.query("SELECT name FROM sprints WHERE team_id = $1 AND status = 'active'", [s.team_id])).rows[0];
    if (active) throw conflict(`${s.team} already has an active sprint, ${active.name}: complete it first`);
    await db.query("UPDATE sprints SET status = 'active', started_at = now(), started_by = $2, updated_at = now() WHERE id = $1", [id, user.id]);
    // What the team committed to: the points of everything in the sprint now, each kept with its stay.
    await db.query('UPDATE sprint_items si SET points_at_start = w.points FROM work_items w WHERE w.id = si.work_item_id AND si.sprint_id = $1 AND si.removed_at IS NULL', [id]);
    await audit(db, { entity_type: 'sprint', entity_ref: String(id), action: 'start', changes: { status: { from: 'planned', to: 'active' } } });
  });
  return getSprint(user, id);
}

/**
 * Completes the active sprint. Done items stay in it; each unfinished one goes back to the backlog or on to the next
 * planned sprint, as chosen (the backlog by default), and the move is logged on the item.
 */
export async function completeSprint(user: User, id: number, input: z.infer<typeof completeSprintSchema>) {
  authorize(user, 'work.write');
  await visibleSprint(id);
  // Every stay moves, the ones the caller cannot see too: completing is the team's, whoever presses the button.
  await seeingAll(() => tx(async (db) => {
    const s = await loadSprint(db, id);
    if (s.status !== 'active') throw conflict(s.status === 'planned' ? 'Start the sprint before completing it' : 'The sprint is already completed');
    const { rows: stays } = await db.query(
      'SELECT si.id, w.id AS work_item_id, w.ref, w.status, w.points, w.done_at FROM sprint_items si JOIN work_items w ON w.id = si.work_item_id WHERE si.sprint_id = $1 AND si.removed_at IS NULL',
      [id],
    );
    const choices = new Map(Object.entries(input.unfinished).map(([r, c]) => [r.toUpperCase(), c]));
    const unfinished = stays.filter((x) => x.status !== 'done');
    for (const r of choices.keys()) if (!unfinished.some((x) => x.ref === r)) throw badRequest(`${r} is not an unfinished item of ${s.name}`);
    let next: { id: number; name: string } | null = null;
    if ([...choices.values()].includes('next_sprint')) {
      const { rows } = input.next_sprint_id
        ? await db.query("SELECT id, name FROM sprints WHERE id = $1 AND team_id = $2 AND status = 'planned' FOR UPDATE", [input.next_sprint_id, s.team_id])
        : await db.query("SELECT id, name FROM sprints WHERE team_id = $1 AND status = 'planned' ORDER BY starts_on, id LIMIT 1 FOR UPDATE", [s.team_id]);
      if (!rows[0]) throw badRequest(input.next_sprint_id ? `That is not a planned sprint of ${s.team}` : `Plan ${s.team}'s next sprint first, or send the items back to the backlog`);
      next = rows[0];
    }
    await db.query("UPDATE sprints SET status = 'completed', completed_at = now(), completed_by = $2, updated_at = now() WHERE id = $1", [id, user.id]);
    const moved: Record<string, string> = {};
    for (const x of stays) {
      if (x.status === 'done') {
        await db.query("UPDATE sprint_items SET outcome = 'done', points = $2, done_at = $3 WHERE id = $1", [x.id, x.points, x.done_at]);
        continue;
      }
      const choice = choices.get(x.ref) ?? 'backlog';
      moved[x.ref] = choice;
      await db.query('UPDATE sprint_items SET outcome = $2, points = $3, removed_at = now() WHERE id = $1', [x.id, choice, x.points]);
      if (choice === 'next_sprint') {
        await db.query('INSERT INTO sprint_items (sprint_id, work_item_id) VALUES ($1, $2)', [next!.id, x.work_item_id]);
        await db.query('UPDATE work_items SET sprint_id = $2 WHERE id = $1', [x.work_item_id, next!.id]);
        await logItem(db, x.work_item_id, user.id, `Unfinished when ${s.name} was completed: on to ${next!.name}`, { sprint: { id: s.id, name: s.name }, action: 'carry_over', to: { id: next!.id, name: next!.name } });
      } else {
        await db.query('UPDATE work_items SET sprint_id = NULL WHERE id = $1', [x.work_item_id]);
        await logItem(db, x.work_item_id, user.id, `Unfinished when ${s.name} was completed: back to the backlog`, { sprint: { id: s.id, name: s.name }, action: 'carry_over', to: 'backlog' });
      }
    }
    await audit(db, { entity_type: 'sprint', entity_ref: String(id), action: 'complete', changes: { status: { from: 'active', to: 'completed' }, unfinished: moved, ...(next ? { next_sprint: next.name } : {}) } });
  }));
  return getSprint(user, id);
}

// ---- The retrospective ------------------------------------------------------------------------

export async function addRetroItem(user: User, id: number, input: z.infer<typeof retroItemSchema>) {
  authorize(user, 'work.write');
  await tx(async (db) => {
    const s = await loadSprint(db, id);
    if (s.status === 'planned') throw conflict('The retrospective opens when the sprint starts');
    await db.query('INSERT INTO sprint_retro_items (sprint_id, kind, body, created_by) VALUES ($1, $2, $3, $4)', [id, input.kind, input.body, user.id]);
  });
  return getSprint(user, id);
}

export async function removeRetroItem(user: User, id: number, itemId: number) {
  authorize(user, 'work.write');
  await tx(async (db) => {
    await loadSprint(db, id);
    const { rows } = await db.query('SELECT created_by, improvement_id FROM sprint_retro_items WHERE id = $1 AND sprint_id = $2 FOR UPDATE', [itemId, id]);
    if (!rows[0]) throw notFound('Retrospective item not found');
    if (rows[0].created_by !== user.id && !can(user.role, 'work.manage')) throw forbidden('Only the person who wrote it or a manager can remove it');
    if (rows[0].improvement_id) throw conflict('It became an improvement and stays as its source');
    await db.query('DELETE FROM sprint_retro_items WHERE id = $1', [itemId]);
  });
  return getSprint(user, id);
}

/**
 * A "to change" item → an improvement (#52, source retrospective), with one click; same model as a review's follow-up.
 * When work items are team-scoped the retrospective is the team's, so the improvement starts restricted to the team
 * (#158); the person can widen it through the ordinary visibility step. Otherwise it starts broad.
 */
export async function retroItemToImprovement(user: User, id: number, itemId: number, input: z.infer<typeof retroImprovementSchema>) {
  authorize(user, 'work.write');
  authorize(user, 'improvement.write');
  await tx(async (db) => {
    const s = await loadSprint(db, id);
    const { rows } = await db.query('SELECT * FROM sprint_retro_items WHERE id = $1 AND sprint_id = $2 FOR UPDATE', [itemId, id]);
    const item = rows[0];
    if (!item) throw notFound('Retrospective item not found');
    if (item.kind !== 'to_change') throw badRequest('Only something to change becomes an improvement');
    if (item.improvement_id) throw conflict('It already became an improvement');
    const audience = (await teamScoped('work_item')) ? { ...BROADEST, restricted: true, restricted_teams: [s.team_id as number] } : BROADEST;
    const m = await createImprovementInTx(db, user, {
      title: (input.title ?? item.body.split('\n')[0]).slice(0, 300),
      description: `From the retrospective of ${s.name} (${s.team}):\n\n${item.body}`,
      source: 'retrospective', owner_id: input.owner_id,
    }, startNarrow(audience));
    await db.query('UPDATE sprint_retro_items SET improvement_id = $2 WHERE id = $1', [itemId, m.id]);
    await audit(db, { entity_type: 'sprint', entity_ref: String(id), action: 'retro_improvement', changes: { item_id: itemId, improvement: m.ref } });
  });
  return getSprint(user, id);
}
