// Development work (#165, epic #164): epics, stories, bugs and tasks (WI000012) in a backlog per team, ordered by rank.
// A task is a work item (it lives in sprints and on the board, #166); follow-ups outside the sprint flow are actions.
// A team's Definition of Ready and Definition of Done are guidance shown when an item moves to ready or done: not a
// gate, but what was not confirmed is logged. Shared by REST, MCP and the web UI; off unless the module is on.
import { z } from 'zod';
import { historyOf, logActivity, touchAndAudit } from '../records/activity.js';
import { audienceOf, forDevSource, startNarrow } from '../security/audience.js';
import { audit } from '../security/audit.js';
import type { User } from '../security/auth.js';
import { assertMayWriteText, forgetExists, textFilterSql } from '../security/confidential.js';
import { type Db, query, tx } from '../core/db.js';
import { badRequest, conflict, notFound } from '../core/errors.js';
import { authorize, can } from '../security/policy.js';
import { checkAssigneeInTeam, validTeam } from '../people/teams.js';
import { recordType, recordUrl, registerRecordType, typeOfPrefix, type RecordType } from '../records/records.js';
import { assertVisibleRef, seeingAll } from '../security/visibility.js';
import { recordSummaries } from '../records/summaries.js';
import type { StartNarrow } from '../problems/problems.js';
import { PLATFORM_LABELS, type Platform } from '../integrations/dev-platform.js';

export const WORK_ITEM_TYPES = ['epic', 'story', 'bug', 'task'] as const;
export const WORK_ITEM_STATUSES = ['new', 'ready', 'in_progress', 'in_review', 'done', 'removed'] as const;
/** The service management records a work item belongs to (#167), linked from either side. */
export const ITSM_LINK_KINDS = ['problem', 'incident', 'change', 'improvement', 'request'] as const;
const WORK_ITEM_LINK_KINDS = ['work_item', 'document', ...ITSM_LINK_KINDS] as const;
type ItsmKind = (typeof ITSM_LINK_KINDS)[number];
type Type = WorkItemType;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];
type Status = WorkItemStatus;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

/** Where an item can go from each status. Kanban teams may skip ready and review. */
export const WORK_ITEM_TRANSITIONS: Record<Status, Status[]> = {
  new: ['ready', 'in_progress', 'removed'],
  ready: ['new', 'in_progress', 'removed'],
  in_progress: ['ready', 'in_review', 'done', 'removed'],
  in_review: ['in_progress', 'done', 'removed'],
  done: ['in_progress'],
  removed: ['new'],
};

/**
 * The parents each type can have (none is always allowed): epic → story or bug → task. Each level is below the one
 * before, so the hierarchy has at most three levels and cannot have a cycle.
 */
export const WORK_ITEM_PARENT_TYPES: Record<Type, Type[]> = { epic: [], story: ['epic'], bug: ['epic'], task: ['story', 'bug'] };
const BUG_FIELDS = ['found_in', 'steps_to_reproduce', 'expected_result', 'actual_result'] as const;

const criterion = z.object({ criterion: z.string().trim().min(1).max(500), done: z.boolean().default(false) });
const label = z.string().trim().min(1).max(50).regex(/^[^,\s][^,]*$/, 'A label has no commas');
const fields = {
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20000),
  type: z.enum(WORK_ITEM_TYPES),
  /** Story points: a fixed scale, so estimates stay rough on purpose. */
  points: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5), z.literal(8), z.literal(13)]).nullable(),
  team_id: z.number().int().nullable(),
  assignee_id: z.number().int().nullable(),
  /** The parent by ref (WI…), or null. */
  parent: z.string().trim().max(30).nullable(),
  acceptance_criteria: z.array(criterion).max(30),
  labels: z.array(label).max(20).transform((l) => [...new Set(l)]),
  /** Where it happens: the version, browser or environment. */
  found_in: z.string().max(5000),
  steps_to_reproduce: z.string().max(20000),
  expected_result: z.string().max(5000),
  actual_result: z.string().max(5000),
};
export const createWorkItemSchema = z.object(fields).partial().required({ title: true, type: true });
export const updateWorkItemSchema = z.object(fields).partial();
export const transitionWorkItemSchema = z.object({
  to: z.enum(WORK_ITEM_STATUSES),
  /** Moving to ready or done: the items of the team's definition that were checked; the rest is logged as skipped. */
  checked: z.array(z.string().max(200)).max(30).optional(),
  /** Required to remove an item from the backlog. */
  reason: z.string().trim().max(2000).optional(),
});
export const moveWorkItemSchema = z
  .object({
    /** Put it just before this item (WI…) in the same backlog, */
    before: z.string().trim().max(30).optional(),
    /** or just after this one, */
    after: z.string().trim().max(30).optional(),
    /** or at the top or the bottom. */
    position: z.enum(['top', 'bottom']).optional(),
  })
  .refine((m) => [m.before, m.after, m.position].filter((v) => v !== undefined).length === 1, { message: 'Give one of before, after or position' });
export const listWorkItemsSchema = z.object({
  /** open is the backlog: everything not done or removed. */
  status: z.enum([...WORK_ITEM_STATUSES, 'open', 'all']).default('open'),
  type: z.enum(WORK_ITEM_TYPES).optional(),
  team: z.union([z.literal('none'), z.coerce.number().int()]).optional(),
  assignee: z.union([z.literal('me'), z.literal('none'), z.coerce.number().int()]).optional(),
  label: z.string().trim().max(50).optional(),
  /** The items under this epic (WI…), at any level. */
  epic: z.string().trim().max(30).optional(),
  /** In this sprint, or none: not in a planned or active sprint (what is left to plan). */
  sprint: z.union([z.literal('none'), z.coerce.number().int()]).optional(),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(['rank', 'updated', 'created']).default('rank'),
  bulk: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export const workItemLinkSchema = z.object({
  kind: z.enum(WORK_ITEM_LINK_KINDS),
  reference: z.string().trim().min(1).max(200),
  system: z.string().trim().max(100).default(''),
  url: z.string().trim().max(2000).refine((v) => v === '' || /^https?:\/\//i.test(v), 'URL must start with http:// or https://').default(''),
  note: z.string().trim().max(2000).default(''),
});
const definition = z.array(z.string().trim().min(1).max(200)).max(15);
/** The board's columns (#166), in order: every status but removed. */
export const BOARD_COLUMNS = ['new', 'ready', 'in_progress', 'in_review', 'done'] as const satisfies readonly Status[];
/** WIP limits per board column: a warning on the board when a column holds more, never a block. */
const wipLimits = z.partialRecord(z.enum(BOARD_COLUMNS), z.number().int().min(1).max(99));
export const workDefinitionsSchema = z.object({ ready: definition, done: definition, wip_limits: wipLimits.optional(), reason: z.string().trim().max(1000).optional() });

const logWorkItem = (db: Db, id: number, userId: number | null, kind: string, body = '', data: object = {}) => logActivity(db, 'work_item', id, userId, kind, body, data);
const words = (s: string) => s.replace('_', ' ');

// ---- Mirrored items (#168) ----------------------------------------------------------------------

const sourceLabel = (source: string | null) => PLATFORM_LABELS[source as Platform] ?? source;
/** What a mirror's source owns: read-only here, the same over REST, MCP and the web. Its status and sprint too. */
const SOURCE_OWNED = ['title', 'type', 'points', 'team_id', 'assignee_id', 'parent'] as const;

/** Refuses a change to fields the source of a mirrored item owns, saying where to make it. */
export function refuseSourceOwned(w: { ref: string; source: string | null; mirror_id: number | null }, fields: string[]) {
  if (!w.mirror_id || !fields.length) return;
  const names = fields.map((f) => words(f.replace(/_id$/, '')));
  throw conflict(`${w.ref} is mirrored from ${sourceLabel(w.source)}, which owns its ${names.join(', ')}: change ${names.length > 1 ? 'them' : 'it'} there`);
}

/**
 * A mirrored item linked to a Kernel record: the source gets a comment saying so, once per record, unless its mirror
 * turned that off. A restricted record is not announced (its reference alone tells the source it exists).
 */
async function queueSourceComment(db: Db, w: { id: number; mirror_id: number | null }, reference: string) {
  if (!w.mirror_id) return;
  const { rows } = await db.query('SELECT comment_links FROM work_item_mirrors WHERE id = $1', [w.mirror_id]);
  if (!rows[0]?.comment_links || !(await forDevSource(db, reference))) return;
  await db.query('INSERT INTO work_item_source_comments (work_item_id, reference) VALUES ($1, $2) ON CONFLICT DO NOTHING', [w.id, reference]);
}

async function loadWorkItem(db: Db, ref: string) {
  const { rows } = await db.query('SELECT * FROM work_items WHERE ref = $1 FOR UPDATE', [ref.toUpperCase()]);
  if (!rows[0]) throw notFound(`Work item ${ref.toUpperCase()} not found`);
  return rows[0];
}

/** A work item the caller can see, by ref (row-level security), or 404. */
async function visibleId(ref: string) {
  const { rows } = await query('SELECT id FROM work_items WHERE ref = $1', [ref.toUpperCase()]);
  if (!rows[0]) throw notFound(`Work item ${ref.toUpperCase()} not found`);
  return rows[0].id as number;
}

async function validateAssignee(db: Db, id: number | null | undefined) {
  if (id == null) return;
  const { rows } = await db.query("SELECT 1 FROM users WHERE id = $1 AND active AND role NOT IN ('viewer', 'integration')", [id]);
  if (!rows[0]) throw badRequest('The assignee must be an active user who can work on items');
}

function checkBugFields(type: Type, input: Partial<Record<(typeof BUG_FIELDS)[number], string>>) {
  if (type !== 'bug' && BUG_FIELDS.some((f) => input[f]?.trim())) throw badRequest('Only a bug has where it was found, steps to reproduce and expected and actual results');
}

/** The parent's id for an item of this type, checked against the hierarchy (epic → story or bug → task). */
async function parentFor(db: Db, type: Type, parentRef: string | null | undefined, selfId?: number) {
  if (parentRef == null) return null;
  const { rows } = await db.query('SELECT id, ref, type FROM work_items WHERE ref = $1', [parentRef.toUpperCase()]);
  const p = rows[0];
  if (!p) throw badRequest(`Work item ${parentRef.toUpperCase()} not found`);
  if (p.id === selfId) throw badRequest('An item cannot be its own parent');
  if (!WORK_ITEM_PARENT_TYPES[type].includes(p.type)) {
    throw badRequest(type === 'epic' ? 'An epic is at the top: it has no parent' : `A ${type} goes under ${WORK_ITEM_PARENT_TYPES[type].map((t) => `a ${t}`).join(' or ')}, not under a ${p.type}`);
  }
  return p.id as number;
}

/** Changing an item's type must leave its children where the hierarchy allows them. */
async function checkChildren(db: Db, id: number, type: Type) {
  const { rows } = await db.query('SELECT ref, type FROM work_items WHERE parent_id = $1', [id]);
  const wrong = rows.find((c) => !WORK_ITEM_PARENT_TYPES[c.type as Type].includes(type));
  if (wrong) throw badRequest(`${wrong.ref} is a ${wrong.type} and cannot sit under a ${type}: move it first`);
}

// ---- The backlog's order -----------------------------------------------------------------------
//
// Each team's backlog (and one for items without a team) is ordered by rank. A new item goes last; a drag takes a
// rank between its new neighbours, and only when there is no room left between them is the backlog renumbered.
// Concurrent drags in one backlog wait for each other (a transaction-level advisory lock), and the ranks are unique
// per backlog. The ranks of items the caller cannot see count too, so this runs with every row visible (seeingAll),
// after the caller's own access was checked.

const GAP = 1024;
export const lockBacklog = (db: Db, teamId: number | null) => db.query("SELECT pg_advisory_xact_lock(hashtext('kernel.backlog'), $1)", [teamId ?? 0]);
const inBacklog = 'coalesce(team_id, 0) = coalesce($1::int, 0)';

export async function bottomRank(db: Db, teamId: number | null) {
  const { rows } = await db.query(`SELECT coalesce(max(rank), 0) + ${GAP} AS rank FROM work_items WHERE ${inBacklog}`, [teamId]);
  return rows[0].rank as number;
}

async function renumber(db: Db, teamId: number | null) {
  // Two steps, so no rank is ever taken twice on the way (the unique index checks every row).
  const ordered = `SELECT id, row_number() OVER (ORDER BY rank, id) AS n FROM work_items WHERE ${inBacklog}`;
  await db.query(`UPDATE work_items w SET rank = 1e15 + o.n FROM (${ordered}) o WHERE w.id = o.id`, [teamId]);
  await db.query(`UPDATE work_items w SET rank = o.n * ${GAP} FROM (${ordered}) o WHERE w.id = o.id`, [teamId]);
}

/** The rank that puts item `id` at `place` in its backlog. Call with the backlog locked. */
async function rankFor(db: Db, id: number, teamId: number | null, place: z.infer<typeof moveWorkItemSchema>): Promise<number> {
  const others = `${inBacklog} AND id <> $2`;
  if (place.position === 'top') {
    const { rows } = await db.query(`SELECT min(rank) AS rank FROM work_items WHERE ${others}`, [teamId, id]);
    return rows[0].rank === null ? GAP : rows[0].rank - GAP;
  }
  if (place.position === 'bottom') {
    const { rows } = await db.query(`SELECT max(rank) AS rank FROM work_items WHERE ${others}`, [teamId, id]);
    return rows[0].rank === null ? GAP : rows[0].rank + GAP;
  }
  const ref = (place.before ?? place.after)!.toUpperCase();
  const { rows: n } = await db.query('SELECT id, rank, team_id FROM work_items WHERE ref = $1', [ref]);
  if (!n[0]) throw badRequest(`Work item ${ref} not found`);
  if (n[0].id === id) throw badRequest('Move it next to another item');
  if ((n[0].team_id ?? 0) !== (teamId ?? 0)) throw badRequest(`${ref} is in another team's backlog`);
  const { rows } = place.before
    ? await db.query(`SELECT max(rank) AS other FROM work_items WHERE ${others} AND rank < $3`, [teamId, id, n[0].rank])
    : await db.query(`SELECT min(rank) AS other FROM work_items WHERE ${others} AND rank > $3`, [teamId, id, n[0].rank]);
  const other = rows[0].other as number | null;
  if (other === null) return place.before ? n[0].rank - GAP : n[0].rank + GAP;
  const rank = (n[0].rank + other) / 2;
  if (Math.abs(n[0].rank - other) > 1e-6 && rank !== n[0].rank && rank !== other) return rank;
  await renumber(db, teamId);
  return rankFor(db, id, teamId, place);
}

// ---- Sprints (#166) ---------------------------------------------------------------------------

/**
 * Ends an item's stay in a planned or active sprint: it goes back to the backlog, and the stay keeps the points it
 * had. A completed sprint keeps its items as they were. True when the item left a sprint.
 */
export async function leaveSprint(db: Db, workItemId: number, sprintId: number | null) {
  if (!sprintId) return false;
  const { rowCount } = await db.query(
    `UPDATE sprint_items si SET removed_at = now(), points = w.points FROM work_items w, sprints s
     WHERE w.id = si.work_item_id AND s.id = si.sprint_id AND s.status <> 'completed' AND si.work_item_id = $1 AND si.sprint_id = $2 AND si.removed_at IS NULL`,
    [workItemId, sprintId],
  );
  if (!rowCount) return false;
  await db.query('UPDATE work_items SET sprint_id = NULL WHERE id = $1', [workItemId]);
  return true;
}

// ---- Reading ---------------------------------------------------------------------------------

const SELECT = `
  SELECT w.*, t.name AS team, a.display_name AS assignee, c.display_name AS created_by_name,
         p.ref AS parent_ref, p.type AS parent_type, p.title AS parent_title, p.status AS parent_status,
         s.name AS sprint, s.status AS sprint_status
  FROM work_items w LEFT JOIN teams t ON t.id = w.team_id LEFT JOIN users a ON a.id = w.assignee_id
  LEFT JOIN users c ON c.id = w.created_by LEFT JOIN work_items p ON p.id = w.parent_id LEFT JOIN sprints s ON s.id = w.sprint_id`;

/** An epic's progress: done and total points, and items, of what is under it (not removed), as the viewer sees it. */
const PROGRESS = (w: string) => `
  (SELECT json_build_object('points_done', coalesce(sum(d.points) FILTER (WHERE d.status = 'done'), 0), 'points', coalesce(sum(d.points), 0),
                            'items_done', count(*) FILTER (WHERE d.status = 'done'), 'items', count(*))
   FROM work_items d WHERE d.status <> 'removed' AND (d.parent_id = ${w}.id OR d.parent_id IN (SELECT s.id FROM work_items s WHERE s.parent_id = ${w}.id)))`;

/** A team's WIP limits per board column. */
export async function wipLimitsOf(teamId: number): Promise<Partial<Record<Status, number>>> {
  const { rows } = await query('SELECT wip_limits FROM work_definitions WHERE team_id = $1', [teamId]);
  return rows[0]?.wip_limits ?? {};
}

async function definitionsOf(teamId: number | null) {
  if (!teamId) return { ready: [] as string[], done: [] as string[] };
  const { rows } = await query('SELECT ready, done FROM work_definitions WHERE team_id = $1', [teamId]);
  return { ready: (rows[0]?.ready ?? []) as string[], done: (rows[0]?.done ?? []) as string[] };
}

export async function getWorkItem(user: User, ref: string) {
  authorize(user, 'work.read');
  const { rows } = await query(`${SELECT} WHERE w.ref = $1`, [ref.toUpperCase()]);
  const w = rows[0];
  if (!w) throw notFound(`Work item ${ref.toUpperCase()} not found`);
  const [activity, links, children, progress, definitions] = await Promise.all([
    historyOf('work_item', w.id),
    linksOf(w.id),
    query('SELECT w.ref, w.type, w.title, w.status, w.points, u.display_name AS assignee FROM work_items w LEFT JOIN users u ON u.id = w.assignee_id WHERE w.parent_id = $1 ORDER BY w.rank', [w.id]),
    w.type === 'epic' ? query(`SELECT ${PROGRESS('w')} AS progress FROM work_items w WHERE w.id = $1`, [w.id]) : null,
    definitionsOf(w.team_id),
  ]);
  // `type` is the record kind everywhere (records.ts); the item's own type is item_type.
  const { search: _s, type: itemType, parent_id: _p, parent_ref, parent_type, parent_title, parent_status, sprint, sprint_status, ...rest } = w;
  const detail = {
    type: 'work_item',
    ...rest,
    item_type: itemType as Type,
    parent: parent_ref ? { ref: parent_ref, type: parent_type, title: parent_title, status: parent_status } : null,
    sprint: w.sprint_id ? { id: w.sprint_id, name: sprint, status: sprint_status } : null,
    children: children.rows,
    progress: progress?.rows[0].progress ?? null,
    definitions,
    links,
    activity,
    // A mirrored item (#168): where it lives, and what only the source changes.
    mirror: w.mirror_id
      ? { source: w.source, label: sourceLabel(w.source), url: w.external_url, iteration: w.external_iteration, read_only: [...SOURCE_OWNED, 'status', 'sprint'] }
      : null,
    transitions: w.mirror_id ? [] : WORK_ITEM_TRANSITIONS[w.status as Status],
    url: workItemUrl(w.ref),
  };
  return { ...detail, next_steps: workItemGuidance(detail) };
}

/** The links, with the title and status of each linked Kernel record as the caller sees it (one they cannot see is hidden). */
async function linksOf(workItemId: number) {
  const { rows } = await query(
    'SELECT l.id, l.kind, l.reference, l.system, l.url, l.note, l.created_at FROM work_item_links l WHERE l.work_item_id = $1 ORDER BY l.kind, l.created_at',
    [workItemId],
  );
  const kernel = (l: { kind: string; system: string }) => l.kind !== 'document' && (l.system === '' || l.system === 'Kernel');
  const linked = await recordSummaries(rows.filter(kernel).map((l) => l.reference), WORK_ITEM_LINK_KINDS);
  return rows.map((l) => {
    const o = kernel(l) ? linked.get(l.reference) : undefined;
    return { ...l, title: o?.title ?? null, status: o?.status ?? null, item_type: o?.item_type ?? null };
  });
}

/** Guided mode (#37): what the item still needs on its way through the backlog. */
function workItemGuidance(w: { item_type: Type; status: string; description: string; points: number | null; acceptance_criteria: { done: boolean }[]; children: unknown[]; steps_to_reproduce: string; team_id: number | null }) {
  if (w.status === 'removed') return { phase: 'Removed', purpose: 'Kept with its reason, so it can come back.', steps: [], next: 'Nothing pending.' };
  const steps = [
    { id: 'describe', label: w.item_type === 'bug' ? 'Describe how to reproduce it' : 'Describe the need and why it matters', hint: w.item_type === 'bug' ? 'Where it happens, the steps, and what you expected against what happened.' : 'Who needs it, what they need, and why.', done: w.item_type === 'bug' ? !!w.steps_to_reproduce.trim() : !!w.description.trim() },
    ...(w.item_type === 'epic'
      ? [{ id: 'split', label: 'Split it into stories', hint: 'Small enough to finish in a sprint each.', done: w.children.length > 0 }]
      : w.item_type === 'task' ? [] : [
        { id: 'criteria', label: 'Write the acceptance criteria', hint: 'How the team knows it is done.', done: w.acceptance_criteria.length > 0 },
        { id: 'estimate', label: 'Estimate it in story points', hint: 'Rough on purpose: 1, 2, 3, 5, 8 or 13.', done: w.points !== null },
      ]),
    { id: 'team', label: 'Put it in a team\'s backlog', hint: 'The team orders its backlog; the top is what comes next.', done: w.team_id !== null },
    { id: 'ready', label: 'Mark it ready', hint: 'The team\'s Definition of Ready is shown when you do.', done: w.status !== 'new' },
    { id: 'done', label: 'Finish it', hint: 'The team\'s Definition of Done is shown when you do.', done: w.status === 'done' },
  ];
  return {
    phase: { new: 'New', ready: 'Ready', in_progress: 'In progress', in_review: 'In review', done: 'Done' }[w.status] ?? w.status,
    purpose: 'Deliver value in small steps, in the order the team agreed.',
    steps,
    next: w.status === 'done' ? 'Nothing pending.' : (steps.find((s) => !s.done)?.label ?? 'Finish it'),
  };
}

export async function listWorkItems(user: User, f: z.infer<typeof listWorkItemsSchema>) {
  authorize(user, 'work.read');
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll('?', `$${params.length}`)); };
  if (f.status === 'open') where.push("w.status NOT IN ('done', 'removed')");
  else if (f.status !== 'all') add('w.status = ?', f.status);
  if (f.type) add('w.type = ?', f.type);
  if (f.team === 'none') where.push('w.team_id IS NULL');
  else if (f.team !== undefined) add('w.team_id = ?', f.team);
  if (f.assignee === 'none') where.push('w.assignee_id IS NULL');
  else if (f.assignee !== undefined) add('w.assignee_id = ?', f.assignee === 'me' ? user.id : f.assignee);
  if (f.label) add('? = ANY(w.labels)', f.label);
  if (f.epic) add('(p.ref = ? OR EXISTS (SELECT 1 FROM work_items g WHERE g.id = p.parent_id AND g.ref = ?))', f.epic.toUpperCase());
  if (f.sprint === 'none') where.push("(w.sprint_id IS NULL OR EXISTS (SELECT 1 FROM sprints s WHERE s.id = w.sprint_id AND s.status = 'completed'))");
  else if (f.sprint !== undefined) add('w.sprint_id = ?', f.sprint);
  if (f.bulk) add('w.ref IN (SELECT unnest(refs) FROM bulk_requests WHERE id = ?)', f.bulk);
  if (f.q) {
    const terms = f.q.split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}_.-]/gu, '')).filter(Boolean);
    if (terms.length) where.push(textFilterSql('w', 'work_item', terms.map((t) => `${t}:*`).join(' & '), params));
  }
  params.push(f.limit);
  const order = { rank: 'coalesce(w.team_id, 0), w.rank', updated: 'w.updated_at DESC', created: 'w.created_at DESC' }[f.sort];
  const { rows } = await query(
    `SELECT w.id, w.ref, w.type AS item_type, w.title, w.status, w.points, w.labels, w.rank, w.team_id, t.name AS team, w.assignee_id, a.display_name AS assignee, w.sprint_id,
            p.ref AS parent_ref, p.title AS parent_title, w.created_at, w.updated_at, w.done_at,
            CASE WHEN w.type = 'epic' THEN ${PROGRESS('w')} END AS progress
     FROM work_items w LEFT JOIN teams t ON t.id = w.team_id LEFT JOIN users a ON a.id = w.assignee_id LEFT JOIN work_items p ON p.id = w.parent_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}, w.id LIMIT $${params.length}`,
    params,
  );
  return rows.map(({ id: _, ...r }) => ({ type: 'work_item', ...r, url: workItemUrl(r.ref) }));
}

// ---- Changing --------------------------------------------------------------------------------

/**
 * A work item made from a service management record (#167): it starts as narrow as that record, links back to it, and
 * `log` notes it on the record's side in the same transaction.
 */
export interface WorkItemOrigin { kind: ItsmKind; narrow: StartNarrow & { from: string }; log: (db: Db, ref: string) => Promise<void> }

export async function createWorkItem(user: User, input: z.infer<typeof createWorkItemSchema>, origin?: WorkItemOrigin) {
  authorize(user, 'work.write');
  checkBugFields(input.type, input);
  if (origin && input.parent) throw badRequest('An item made from another record starts without a parent: put it under an epic afterwards');
  // A child starts as narrow as its parent, so nothing under a restricted epic reaches more people than the epic.
  let narrow: StartNarrow | undefined = origin?.narrow;
  if (input.parent) {
    await visibleId(input.parent);
    narrow = startNarrow(await audienceOf(null, input.parent));
  }
  const ref = await seeingAll(() => tx(async (db) => {
    await validTeam(db, input.team_id);
    await validateAssignee(db, input.assignee_id);
    await checkAssigneeInTeam(db, input.team_id, input.assignee_id);
    const parentId = await parentFor(db, input.type, input.parent);
    const teamId = input.team_id ?? null;
    await lockBacklog(db, teamId);
    const { rows } = await db.query(
      `INSERT INTO work_items (type, title, description, rank, points, team_id, assignee_id, parent_id, acceptance_criteria, labels,
                               found_in, steps_to_reproduce, expected_result, actual_result, restricted, restricted_teams, classification, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id, ref`,
      [
        input.type, input.title, input.description ?? '', await bottomRank(db, teamId), input.points ?? null, teamId, input.assignee_id ?? null, parentId,
        JSON.stringify(input.acceptance_criteria ?? []), input.labels ?? [], input.found_in ?? '', input.steps_to_reproduce ?? '', input.expected_result ?? '', input.actual_result ?? '',
        narrow?.restricted ?? false, narrow?.restricted_teams ?? [], narrow?.classification ?? 'normal', user.id,
      ],
    );
    const w = rows[0] as { id: number; ref: string };
    const how = origin ? `Created from ${origin.narrow.from}` : narrow?.from ? `Created under ${narrow.from}` : `Created ${input.type}`;
    await logWorkItem(db, w.id, user.id, 'created', how, { type: input.type, parent: input.parent?.toUpperCase() ?? null, from: origin?.narrow.from ?? null, restricted: narrow?.restricted ?? false });
    if (origin) {
      await db.query("INSERT INTO work_item_links (work_item_id, kind, reference, system, created_by) VALUES ($1, $2, $3, 'Kernel', $4)", [w.id, origin.kind, origin.narrow.from, user.id]);
      await origin.log(db, w.ref);
    }
    if (narrow?.classification === 'confidential') forgetExists();
    return w.ref;
  }));
  return getWorkItem(user, ref);
}

export async function updateWorkItemLean(user: User, ref: string, input: z.infer<typeof updateWorkItemSchema>): Promise<void> {
  authorize(user, 'work.write');
  // No blind overwrites of masked text (#61, #156); acceptance criteria are masked one by one.
  await assertMayWriteText(user, ref, { ...input, criterion: input.acceptance_criteria });
  await visibleId(ref);
  if (input.parent) await visibleId(input.parent);
  await seeingAll(() => tx(async (db) => {
    const w = await loadWorkItem(db, ref);
    if (w.mirror_id) {
      const parentRef = w.parent_id ? (await db.query('SELECT ref FROM work_items WHERE id = $1', [w.parent_id])).rows[0].ref : null;
      const now: Record<string, unknown> = { ...w, parent: parentRef };
      const given = (f: (typeof SOURCE_OWNED)[number]) => (f === 'parent' && input.parent ? input.parent.toUpperCase() : input[f]);
      refuseSourceOwned(w, SOURCE_OWNED.filter((f) => input[f] !== undefined && (given(f) ?? null) !== (now[f] ?? null)));
    }
    const { parent, ...rest } = input;
    const next: Record<string, unknown> = { ...rest };
    const type = (input.type ?? w.type) as Type;
    checkBugFields(type, input);
    if (input.type !== undefined && input.type !== w.type) await checkChildren(db, w.id, type);
    if (parent !== undefined || (input.type !== undefined && input.type !== w.type)) {
      const parentRef = parent !== undefined ? parent : (w.parent_id ? (await db.query('SELECT ref FROM work_items WHERE id = $1', [w.parent_id])).rows[0].ref : null);
      next.parent_id = await parentFor(db, type, parentRef, w.id);
    }
    if (input.team_id !== undefined) await validTeam(db, input.team_id);
    if (input.assignee_id !== undefined) await validateAssignee(db, input.assignee_id);
    if (input.team_id !== undefined || input.assignee_id !== undefined) await checkAssigneeInTeam(db, next.team_id !== undefined ? (next.team_id as number | null) : w.team_id, next.assignee_id !== undefined ? (next.assignee_id as number | null) : w.assignee_id);
    const json = new Set(['acceptance_criteria']);
    // jsonb keeps its own key order, so criteria compare by their values.
    const norm = (k: string, v: any) => (k === 'acceptance_criteria' ? JSON.stringify(v.map((c: any) => [c.criterion, c.done])) : k === 'labels' ? JSON.stringify(v) : v ?? null);
    const same = (k: string, v: unknown) => norm(k, w[k]) === norm(k, v);
    const changed = Object.entries(next).filter(([k, v]) => v !== undefined && !same(k, v));
    if (!changed.length) return;
    // Another team's backlog: the item goes to its bottom.
    const teamChange = changed.find(([k]) => k === 'team_id');
    if (teamChange) {
      // A sprint is one team's: the item leaves it for the other backlog.
      if (await leaveSprint(db, w.id, w.sprint_id)) await logWorkItem(db, w.id, user.id, 'sprint', 'Left its sprint for another team\'s backlog', { action: 'remove', sprint_id: w.sprint_id });
      await lockBacklog(db, teamChange[1] as number | null);
      changed.push(['rank', await bottomRank(db, teamChange[1] as number | null)]);
    }
    await db.query(`UPDATE work_items SET ${changed.map(([k], n) => `${k} = $${n + 2}`).join(', ')} WHERE id = $1`, [w.id, ...changed.map(([k, v]) => (json.has(k) ? JSON.stringify(v) : v))]);
    const data = Object.fromEntries(changed.filter(([k]) => k !== 'rank').map(([k, v]) => [k, { from: w[k] ?? null, to: v ?? null }]));
    await logWorkItem(db, w.id, user.id, 'update', `Updated ${Object.keys(data).map((k) => words(k.replace('_id', ''))).join(', ')}`, data);
  }));
}

export async function updateWorkItem(...args: Parameters<typeof updateWorkItemLean>) {
  await updateWorkItemLean(...args);
  return getWorkItem(args[0], args[1]);
}

export async function transitionWorkItemLean(user: User, ref: string, input: z.infer<typeof transitionWorkItemSchema>): Promise<void> {
  authorize(user, 'work.write');
  await assertMayWriteText(user, ref, { remove_reason: input.reason });
  await tx(async (db) => {
    const w = await loadWorkItem(db, ref);
    const from = w.status as Status;
    if (from === input.to) return;
    refuseSourceOwned(w, ['status']);
    if (!WORK_ITEM_TRANSITIONS[from].includes(input.to)) throw conflict(`A work item cannot go from ${words(from)} to ${words(input.to)}`);
    if (input.to === 'removed' && !input.reason) throw badRequest('Give a reason for removing it from the backlog, so it is not lost');
    // The team's definition for this step: guidance, so moving on without it is allowed and logged.
    const definition = input.to === 'ready' || input.to === 'done' ? (await definitionsOf(w.team_id))[input.to] : [];
    const skipped = definition.filter((d) => !(input.checked ?? []).includes(d));
    await db.query(
      `UPDATE work_items SET status = $2, remove_reason = CASE WHEN $2 = 'removed' THEN $3 ELSE remove_reason END,
         started_at = CASE WHEN $2 IN ('in_progress', 'in_review', 'done') THEN coalesce(started_at, now()) ELSE started_at END,
         done_at = CASE WHEN $2 = 'done' THEN now() ELSE NULL END
       WHERE id = $1`,
      [w.id, input.to, input.reason ?? ''],
    );
    if (input.to === 'removed' && (await leaveSprint(db, w.id, w.sprint_id))) await logWorkItem(db, w.id, user.id, 'sprint', 'Left its sprint when it was removed', { action: 'remove', sprint_id: w.sprint_id });
    const label = { new: 'Back to new', ready: 'Ready', in_progress: 'Started', in_review: 'In review', done: 'Done', removed: 'Removed' }[input.to];
    const name = input.to === 'ready' ? 'Definition of Ready' : 'Definition of Done';
    const body = input.to === 'removed' ? `${label}: ${input.reason}` : skipped.length ? `${label}, without the ${name}: ${skipped.join('; ')}` : label;
    await logWorkItem(db, w.id, user.id, 'status', body, {
      status: { from, to: input.to }, ...(input.reason ? { reason: input.reason } : {}), ...(definition.length ? { definition: name, skipped } : {}),
    });
  });
}

export async function transitionWorkItem(...args: Parameters<typeof transitionWorkItemLean>) {
  await transitionWorkItemLean(...args);
  return getWorkItem(args[0], args[1]);
}

/** Moves an item in its team's backlog: before or after another item, or to the top or the bottom. */
export async function moveWorkItem(user: User, ref: string, input: z.infer<typeof moveWorkItemSchema>) {
  authorize(user, 'work.write');
  await visibleId(ref);
  if (input.before ?? input.after) await visibleId((input.before ?? input.after)!);
  await seeingAll(() => tx(async (db) => {
    const { rows } = await db.query('SELECT id, team_id FROM work_items WHERE ref = $1', [ref.toUpperCase()]);
    await lockBacklog(db, rows[0].team_id);
    // Read again under the lock: a drag that waited sees the ranks the one before it left.
    const w = await loadWorkItem(db, ref);
    if ((w.team_id ?? 0) !== (rows[0].team_id ?? 0)) throw conflict(`${w.ref} moved to another backlog meanwhile; try again`);
    const rank = await rankFor(db, w.id, w.team_id, input);
    await db.query('UPDATE work_items SET rank = $2 WHERE id = $1', [w.id, rank]);
    const where = input.position ? `to the ${input.position}` : `${input.before ? 'before' : 'after'} ${(input.before ?? input.after)!.toUpperCase()}`;
    await logWorkItem(db, w.id, user.id, 'backlog', `Moved ${where} in the backlog`, { ...input });
  }));
  return getWorkItem(user, ref);
}

export async function addWorkItemComment(user: User, ref: string, body: string) {
  authorize(user, 'work.write');
  if (!body.trim()) throw badRequest('Comment cannot be empty');
  await tx(async (db) => {
    const w = await loadWorkItem(db, ref);
    await logWorkItem(db, w.id, user.id, 'comment', body.trim());
  });
  return getWorkItem(user, ref);
}

/** A link to a problem, incident, change, improvement or request is in that record's history too, whichever side made it. */
async function logOnOtherSide(db: Db, user: User, kind: string, reference: string, workItem: string, act: 'add' | 'remove') {
  if (!(ITSM_LINK_KINDS as readonly string[]).includes(kind)) return;
  const { rows } = await db.query(`SELECT id FROM ${recordType(kind).table} WHERE ref = $1`, [reference]);
  if (rows[0]) await logActivity(db, kind, rows[0].id, user.id, 'link', `${act === 'add' ? 'Linked' : 'Unlinked'} work item ${workItem}`, { kind: 'work_item', reference: workItem, action: act });
}

export async function addWorkItemLink(user: User, ref: string, input: z.infer<typeof workItemLinkSchema>) {
  authorize(user, 'work.write');
  const kernel = input.kind !== 'document' && (!input.system || input.system === 'Kernel');
  const reference = kernel ? input.reference.toUpperCase() : input.reference;
  if (kernel && input.kind === 'work_item') {
    if (!/^WI\d{6}$/.test(reference)) throw badRequest(`${reference} is not a work item`);
    if (reference === ref.toUpperCase()) throw badRequest('An item cannot be linked to itself');
    await visibleId(reference);
  } else if (kernel) {
    // A problem, incident, change, improvement or request in Kernel: of that kind, and one the caller can see.
    if (typeOfPrefix(reference) !== input.kind) throw badRequest(`${reference} is not ${input.kind === 'incident' || input.kind === 'improvement' ? 'an' : 'a'} ${input.kind}`);
    await assertVisibleRef(reference);
  }
  await tx(async (db) => {
    const w = await loadWorkItem(db, ref);
    const { rowCount } = await db.query(
      'INSERT INTO work_item_links (work_item_id, kind, reference, system, url, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING',
      [w.id, input.kind, reference, kernel ? 'Kernel' : input.system, input.url, input.note, user.id],
    );
    if (!rowCount) throw conflict(`${words(input.kind)} ${reference} is already linked`);
    await logWorkItem(db, w.id, user.id, 'link', `Linked ${words(input.kind)} ${reference}`, { kind: input.kind, reference, system: input.system, action: 'add' });
    if (kernel) await logOnOtherSide(db, user, input.kind, reference, w.ref, 'add');
    if (kernel && (ITSM_LINK_KINDS as readonly string[]).includes(input.kind)) await queueSourceComment(db, w, reference);
  });
  return getWorkItem(user, ref);
}

export async function removeWorkItemLink(user: User, ref: string, linkId: number) {
  authorize(user, 'work.write');
  await tx(async (db) => {
    const w = await loadWorkItem(db, ref);
    const { rows } = await db.query('DELETE FROM work_item_links WHERE id = $1 AND work_item_id = $2 RETURNING kind, reference, system', [linkId, w.id]);
    if (!rows[0]) throw notFound('Link not found');
    await logWorkItem(db, w.id, user.id, 'link', `Unlinked ${words(rows[0].kind)} ${rows[0].reference}`, { ...rows[0], action: 'remove' });
    if (['', 'Kernel'].includes(rows[0].system)) await logOnOtherSide(db, user, rows[0].kind, rows[0].reference, w.ref, 'remove');
  });
  return getWorkItem(user, ref);
}

// ---- A team's Definition of Ready and Definition of Done ---------------------------------------

export async function getWorkDefinitions(user: User, teamId: number) {
  authorize(user, 'work.read');
  const { rows } = await query('SELECT id, name FROM teams WHERE id = $1', [teamId]);
  if (!rows[0]) throw notFound('Team not found');
  return { team_id: teamId, team: rows[0].name, ...(await definitionsOf(teamId)), wip_limits: await wipLimitsOf(teamId), may_edit: can(user.role, 'work.manage') };
}

export async function saveWorkDefinitions(user: User, teamId: number, input: z.infer<typeof workDefinitionsSchema>) {
  authorize(user, 'work.manage');
  await tx(async (db) => {
    await validTeam(db, teamId);
    const before = await db.query('SELECT ready, done, wip_limits FROM work_definitions WHERE team_id = $1', [teamId]);
    const limits = input.wip_limits ?? before.rows[0]?.wip_limits ?? {};
    await db.query(
      `INSERT INTO work_definitions (team_id, ready, done, wip_limits, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (team_id) DO UPDATE SET ready = $2, done = $3, wip_limits = $4, updated_by = $5, updated_at = now()`,
      [teamId, input.ready, input.done, JSON.stringify(limits), user.id],
    );
    await audit(db, {
      entity_type: 'team', entity_ref: (await db.query('SELECT name FROM teams WHERE id = $1', [teamId])).rows[0].name, action: 'work_definitions',
      changes: { ready: { from: before.rows[0]?.ready ?? [], to: input.ready }, done: { from: before.rows[0]?.done ?? [], to: input.done }, wip_limits: { from: before.rows[0]?.wip_limits ?? {}, to: limits } }, reason: input.reason,
    });
  });
  return getWorkDefinitions(user, teamId);
}

// ---- Bulk, My work ---------------------------------------------------------------------------

export async function workItemRows(ids: string[]) {
  return (await query('SELECT ref AS id, title, status, assignee_id, team_id, labels AS tags FROM work_items WHERE ref = ANY($1)', [ids.map((i) => i.toUpperCase())])).rows;
}

export async function myWorkItems(userId: number) {
  const { rows } = await query(
    "SELECT ref, type AS item_type, title, status, points, updated_at FROM work_items WHERE assignee_id = $1 AND status IN ('ready', 'in_progress', 'in_review') ORDER BY status DESC, rank LIMIT 30",
    [userId],
  );
  return rows;
}

// ---- Registry (#35, #172) ---------------------------------------------------------------------

const WORK_ITEM_TYPE: RecordType = {
  type: 'work_item',
  prefix: 'WI',
  pattern: /^WI\d{6}$/,
  readAction: 'work.read',
  uiPath: (ref) => `/work/${ref}`,
  get: getWorkItem,
  search: async (user, q, limit) =>
    (await listWorkItems(user, listWorkItemsSchema.parse({ q, status: 'all', sort: 'updated', limit }))).map((w) => ({
      type: 'work_item', ref: w.ref, title: w.title, status: w.status, url: w.url, summary: [w.item_type, w.team, w.points ? `${w.points} points` : null].filter(Boolean).join(' · '),
    })),
  rest: {
    list: '/api/work-items',
    create: '/api/work-items',
    get: '/api/work-items/:ref',
    update: '/api/work-items/:ref',
    transition: '/api/work-items/:ref/transition',
    links: '/api/work-items/:ref/links',
    comments: '/api/work-items/:ref/comments',
  },
  mcp: { list: 'list_work_items', get: 'get_work_item', create: 'create_work_item', update: 'update_work_item', transition: 'transition_work_item' },
  table: 'work_items',
  subtype: 'type',
  module: 'development',
  activity: { table: 'work_item_activity', fk: 'work_item_id', after: async (db, e) => void (await touchAndAudit(db, 'work_item', e)) },
  people: { assignee: 'assignee_id', team: 'team_id' },
  textPlaces: [
    { table: 'work_items', key: 'id', columns: ['title', 'description', ...BUG_FIELDS, 'remove_reason'], json: ['acceptance_criteria'] },
    { table: 'work_item_activity', key: 'work_item_id', columns: ['body'], json: ['data'] },
    { table: 'work_item_links', key: 'work_item_id', columns: ['note', 'url'] },
  ],
  liveTopic: 'work_item',
  comment: addWorkItemComment,
};
registerRecordType(WORK_ITEM_TYPE);

export function workItemUrl(ref: string) {
  return recordUrl(WORK_ITEM_TYPE, ref);
}
