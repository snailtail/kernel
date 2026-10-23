// Saved list views (#110): a named filter, sort and set of columns for a practice list. A view is personal, shared
// with a team (owned by the team; its leads and administrators edit it) or shared with everyone (managers).
// Every list also has a few built-in views, and each user may pin one view as the list's default.
import { z } from 'zod';
import type { User } from './auth.js';
import { audit } from './audit.js';
import { type Db, query, tx } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { authorize, can, type Action } from './policy.js';

export const LISTS = ['problems', 'actions', 'incidents', 'changes', 'alerts', 'known_errors', 'knowledge', 'cis', 'candidates', 'improvements', 'requests'] as const;
export type ListName = (typeof LISTS)[number];

/** Reading a list's views needs the same permission as reading the list. */
const READ: Record<ListName, Action> = {
  problems: 'problem.read', actions: 'action.read', incidents: 'incident.read', changes: 'change.read', alerts: 'event.read',
  known_errors: 'kedb.read', knowledge: 'article.read', cis: 'ci.read', candidates: 'candidate.read', improvements: 'improvement.read', requests: 'request.read',
};

interface BuiltIn {
  key: string;
  name: string;
  query: string;
}

/** Built-in views: the queues most people start from. Queries use the list page's own URL parameters. */
const BUILT_IN: Record<ListName, BuiltIn[]> = {
  problems: [
    { key: 'needs-decision', name: 'Needs a decision', query: 'needs_decision=true' },
    { key: 'major', name: 'Major problems', query: 'is_major=true' },
    { key: 'recently-updated', name: 'Recently updated', query: 'sort=updated' },
  ],
  actions: [
    { key: 'overdue', name: 'My overdue actions', query: 'overdue=true' },
    { key: 'everyone', name: "Everyone's open actions", query: 'everyone=1' },
  ],
  incidents: [
    { key: 'my-team-queue', name: "My team's queue", query: 'team=mine' },
    { key: 'unassigned-p1-p2', name: 'Unassigned P1–P2', query: 'assignee=none&max_priority=2' },
    { key: 'breaching-sla', name: 'Breaching SLA', query: 'breaching_within=60' },
  ],
  changes: [
    { key: 'awaiting-my-approval', name: 'Awaiting my approval', query: 'awaiting_my_vote=true' },
    { key: 'emergency', name: 'Emergency changes', query: 'type=emergency' },
  ],
  alerts: [
    { key: 'critical', name: 'Critical and major', query: 'min_severity=major' },
    { key: 'suppressed', name: 'Suppressed', query: 'suppressed=true' },
  ],
  known_errors: [
    { key: 'open', name: 'Open known errors', query: '' },
    { key: 'with-resolved', name: 'Including resolved', query: 'include_resolved=true' },
  ],
  knowledge: [
    { key: 'due-for-review', name: 'Due for review', query: 'due_for_review=true' },
    { key: 'drafts', name: 'Drafts', query: 'status=draft' },
  ],
  cis: [
    { key: 'services', name: 'Services', query: 'class=service' },
    { key: 'production', name: 'Production', query: 'environment=prod' },
  ],
  candidates: [{ key: 'all', name: 'All candidates', query: '' }],
  improvements: [
    { key: 'quick-wins', name: 'Quick wins', query: 'quick_wins=true' },
    { key: 'ideas', name: 'Ideas to decide on', query: 'status=idea' },
    { key: 'mine', name: 'Mine', query: 'owner=me' },
    { key: 'done', name: 'Done', query: 'status=done' },
  ],
  requests: [
    { key: 'my-tasks', name: 'My tasks', query: 'task=mine' },
    { key: 'my-teams', name: "My teams' tasks", query: 'task=my_teams' },
    { key: 'awaiting-approval', name: 'Awaiting approval', query: 'status=awaiting_approval' },
    { key: 'breaching-sla', name: 'Breaching SLA', query: 'breaching=true' },
  ],
};

export const listSchema = z.object({ list: z.enum(LISTS) });
const viewFields = {
  name: z.string().trim().min(1).max(60),
  query: z.string().max(500).refine((q) => !q.startsWith('?'), 'Give the query string without the leading "?"'),
  columns: z.array(z.string().regex(/^[a-z_]{1,40}$/)).max(30),
  scope: z.enum(['personal', 'team', 'everyone']),
  team_id: z.number().int().nullable(),
};
export const viewSchema = z.object({
  list: z.enum(LISTS),
  name: viewFields.name,
  query: viewFields.query.default(''),
  columns: viewFields.columns.default([]),
  scope: viewFields.scope.default('personal'),
  team_id: viewFields.team_id.optional(),
});
/** Only the fields given change. */
export const updateViewSchema = z.object(viewFields).partial();
export const defaultSchema = z.object({
  list: z.enum(LISTS),
  /** A view id, "builtin:<key>", or null for the list's normal default. */
  view: z.union([z.number().int(), z.string().regex(/^builtin:[a-z0-9-]{1,40}$/), z.null()]),
});

const SELECT = `
  SELECT v.id, v.list, v.name, v.scope, v.owner_id, v.team_id, t.name AS team, v.query, v.columns, v.updated_at,
         (v.scope = 'team' AND EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = v.team_id AND m.user_id = $1 AND m.role = 'lead')) AS lead
  FROM list_views v LEFT JOIN teams t ON t.id = v.team_id`;

/** Who sees a view: its owner, the team's members, or everyone. Administrators see every team's views. */
function visibleSql(user: User) {
  return `(v.owner_id = $1 OR v.scope = 'everyone' OR (v.scope = 'team' AND (EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = v.team_id AND m.user_id = $1)${can(user.role, 'team.manage') ? ' OR true' : ''})))`;
}

/** Personal views are the owner's; team views their leads' (and administrators'); shared views managers'. */
function canEditView(user: User, v: { scope: string; owner_id: number | null; lead: boolean }) {
  if (v.scope === 'personal') return v.owner_id === user.id;
  if (v.scope === 'team') return v.lead || can(user.role, 'team.manage');
  return can(user.role, 'view.share');
}

async function checkScope(db: Db, user: User, scope: string, teamId: number | null | undefined) {
  if (scope === 'personal') return;
  if (scope === 'everyone') {
    authorize(user, 'view.share');
    return;
  }
  if (!teamId) throw badRequest('Choose the team to share the view with');
  const { rows } = await db.query("SELECT t.active, EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.user_id = $2 AND m.role = 'lead') AS lead FROM teams t WHERE t.id = $1", [teamId, user.id]);
  if (!rows[0]?.active) throw badRequest('Choose an active team');
  if (!rows[0].lead && !can(user.role, 'team.manage')) throw forbidden("Only the team's leads can share views with the team");
}

const shape = (user: User, v: any, defaultKey: string | null) => ({
  key: String(v.id),
  id: v.id,
  list: v.list,
  name: v.name,
  scope: v.scope,
  team_id: v.team_id,
  team: v.team,
  query: v.query,
  columns: v.columns,
  can_edit: canEditView(user, v),
  is_default: defaultKey === String(v.id),
});

/**
 * The user's default for a list, if they can still use it: a team view stops being one when they leave the team or
 * it changes scope, and a built-in view that no longer exists is dropped. The list then opens as usual.
 */
async function defaultFor(user: User, list: ListName) {
  const { rows } = await query(
    `SELECT d.view_id, d.builtin FROM list_view_defaults d LEFT JOIN list_views v ON v.id = d.view_id
     WHERE d.user_id = $1 AND d.list = $2 AND (d.builtin IS NOT NULL OR ${visibleSql(user)})`,
    [user.id, list],
  );
  if (!rows[0]) return null;
  if (rows[0].builtin) return BUILT_IN[list].some((b) => b.key === rows[0].builtin) ? `builtin:${rows[0].builtin}` : null;
  return String(rows[0].view_id);
}

/** A list's views: built-in first, then the user's own, the team's and everyone's; and the user's default. */
export async function listViews(user: User, list: ListName) {
  authorize(user, READ[list]);
  const defaultKey = await defaultFor(user, list);
  const { rows } = await query(
    `${SELECT} WHERE v.list = $2 AND ${visibleSql(user)}
     ORDER BY CASE v.scope WHEN 'personal' THEN 0 WHEN 'team' THEN 1 ELSE 2 END, t.name, lower(v.name)`,
    [user.id, list],
  );
  const builtIn = BUILT_IN[list].map((b) => ({
    key: `builtin:${b.key}`, id: null, list, name: b.name, scope: 'builtin' as const, team_id: null, team: null,
    query: b.query, columns: [] as string[], can_edit: false, is_default: defaultKey === `builtin:${b.key}`,
  }));
  return { views: [...builtIn, ...rows.map((v) => shape(user, v, defaultKey))], default: defaultKey };
}

async function load(db: Db, user: User, id: number, lock = false) {
  const { rows } = await db.query(`${SELECT} WHERE v.id = $2 AND ${visibleSql(user)}${lock ? ' FOR UPDATE OF v' : ''}`, [user.id, id]);
  if (!rows[0]) throw notFound('View not found');
  authorize(user, READ[rows[0].list as ListName]);
  return rows[0];
}

const isShared = (scope: string) => scope !== 'personal';

function uniqueName<T>(run: () => Promise<T>) {
  return run().catch((err) => {
    if (err.code === '23505') throw conflict('A view with that name already exists for this list');
    throw err;
  });
}

export async function createView(user: User, input: z.infer<typeof viewSchema>) {
  authorize(user, READ[input.list]);
  return uniqueName(() =>
    tx(async (db) => {
      await checkScope(db, user, input.scope, input.team_id);
      const { rows } = await db.query(
        `INSERT INTO list_views (list, name, scope, owner_id, team_id, query, columns, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [input.list, input.name, input.scope, input.scope === 'personal' ? user.id : null, input.scope === 'team' ? input.team_id : null, input.query, input.columns, user.id],
      );
      const v = await load(db, user, rows[0].id);
      if (isShared(v.scope)) await audit(db, { entity_type: 'list_view', entity_ref: String(v.id), action: 'create', changes: { list: v.list, name: v.name, scope: v.scope, team_id: v.team_id, query: v.query } });
      return shape(user, v, null);
    }),
  );
}

export async function updateView(user: User, id: number, input: z.infer<typeof updateViewSchema>) {
  return uniqueName(() =>
    tx(async (db) => {
      const before = await load(db, user, id, true);
      if (!canEditView(user, before)) throw forbidden(before.scope === 'team' ? "Only the team's leads can change a team view" : 'You cannot change this view');
      const scope = input.scope ?? before.scope;
      const teamId = scope === 'team' ? (input.team_id ?? before.team_id) : null;
      if (scope !== before.scope || teamId !== before.team_id) await checkScope(db, user, scope, teamId);
      await db.query(
        `UPDATE list_views SET name = $2, query = $3, columns = $4, scope = $5, owner_id = $6, team_id = $7, updated_at = now() WHERE id = $1`,
        [id, input.name ?? before.name, input.query ?? before.query, input.columns ?? before.columns, scope, scope === 'personal' ? (before.scope === 'personal' ? before.owner_id : user.id) : null, teamId],
      );
      const after = await load(db, user, id);
      if (isShared(before.scope) || isShared(after.scope)) {
        const changes: Record<string, unknown> = {};
        for (const k of ['name', 'query', 'columns', 'scope', 'team_id']) {
          if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changes[k] = { from: before[k], to: after[k] };
        }
        await audit(db, { entity_type: 'list_view', entity_ref: String(id), action: 'update', changes });
      }
      return shape(user, after, await defaultFor(user, after.list));
    }),
  );
}

export async function deleteView(user: User, id: number) {
  return tx(async (db) => {
    const v = await load(db, user, id, true);
    if (!canEditView(user, v)) throw forbidden(v.scope === 'team' ? "Only the team's leads can remove a team view" : 'You cannot remove this view');
    await db.query('DELETE FROM list_views WHERE id = $1', [id]);
    if (isShared(v.scope)) await audit(db, { entity_type: 'list_view', entity_ref: String(id), action: 'delete', changes: { list: v.list, name: v.name, scope: v.scope, team_id: v.team_id } });
    return { ok: true };
  });
}

/** Pins a view (or a built-in one) as the user's default for the list; null goes back to the list's normal default. */
export async function setDefault(user: User, input: z.infer<typeof defaultSchema>) {
  authorize(user, READ[input.list]);
  return tx(async (db) => {
    await db.query('DELETE FROM list_view_defaults WHERE user_id = $1 AND list = $2', [user.id, input.list]);
    if (typeof input.view === 'number') {
      const v = await load(db, user, input.view);
      if (v.list !== input.list) throw badRequest(`That view belongs to the ${v.list} list`);
      await db.query('INSERT INTO list_view_defaults (user_id, list, view_id) VALUES ($1, $2, $3)', [user.id, input.list, input.view]);
    } else if (typeof input.view === 'string') {
      const key = input.view.slice('builtin:'.length);
      if (!BUILT_IN[input.list].some((b) => b.key === key)) throw badRequest('No such built-in view for this list');
      await db.query('INSERT INTO list_view_defaults (user_id, list, builtin) VALUES ($1, $2, $3)', [user.id, input.list, key]);
    }
    return { list: input.list, default: input.view === null ? null : String(input.view) };
  });
}
