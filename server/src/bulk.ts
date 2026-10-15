// Bulk actions on a practice list (#110): one operation on many records, by ids or by the list's filter. Every record
// goes through the same service function as a single edit, so permissions, visibility, audit entries, live updates,
// notifications and SLA effects are exactly the same; nothing here writes to a record table itself. The answer has an
// outcome per record (changed, unchanged, skipped or failed, and why), and for operations that can be reversed, the
// request that undoes them.
import { z } from 'zod';
import type { User } from './auth.js';
import { audit } from './audit.js';
import { query, tx } from './db.js';
import { badRequest, HttpError } from './errors.js';
import * as actions from './actions.js';
import * as changes from './changes.js';
import * as cmdb from './cmdb.js';
import * as events from './events.js';
import * as incidents from './incidents.js';
import * as knowledge from './knowledge.js';
import { logger } from './log.js';
import * as major from './major-incidents.js';
import * as oncall from './oncall.js';
import { authorize, can, type Action } from './policy.js';
import * as problems from './problems.js';

export const BULK_LIMIT = 500;
export const PRACTICES = ['incidents', 'problems', 'changes', 'alerts', 'actions', 'articles', 'cis'] as const;
export type Practice = (typeof PRACTICES)[number];

const ref = z.string().trim().min(1).max(30);
export const operationSchema = z.discriminatedUnion('op', [
  /** Assign to a person and/or a team (actions and articles: the owner). null clears it. */
  z.object({ op: z.literal('assign'), assignee_id: z.number().int().nullable().optional(), team_id: z.number().int().nullable().optional() }),
  /** Move to a status; details are what that practice's transition asks for (resolution, closure code, comment…). */
  z.object({ op: z.literal('status'), to: z.string().min(1).max(30), details: z.record(z.string(), z.unknown()).default({}) }),
  z.object({ op: z.literal('priority'), impact: z.number().int().min(1).max(3).optional(), urgency: z.number().int().min(1).max(3).optional() }),
  z.object({ op: z.literal('tags'), add: z.array(z.string().trim().min(1).max(50)).max(30).default([]), remove: z.array(z.string().trim().min(1).max(50)).max(30).default([]) }),
  /** Link incidents to a problem (null unlinks). */
  z.object({ op: z.literal('link_problem'), problem: ref.nullable() }),
  /** Relate incidents to a parent (a major) incident. */
  z.object({ op: z.literal('set_parent'), parent: ref, resolve_with_parent: z.boolean().default(true) }),
  z.object({ op: z.literal('acknowledge') }),
  z.object({ op: z.literal('close') }),
]);
export type Operation = z.infer<typeof operationSchema>;
type OpName = Operation['op'];

export const bulkSchema = z
  .object({
    /** Record refs (incidents, problems, changes, articles, CIs) or ids (alerts, actions). */
    ids: z.array(z.union([z.string().trim().min(1).max(30), z.number().int()])).min(1).max(BULK_LIMIT).optional(),
    /** Or the list's query string, as in a saved view: every record the filter matches, up to the limit. */
    filter: z.string().max(500).optional(),
    operation: operationSchema.optional(),
    /** Per-record operations, as returned in `undo`. */
    items: z.array(z.object({ id: z.union([z.string(), z.number().int()]), operation: operationSchema })).min(1).max(BULK_LIMIT).optional(),
    /** Report what would happen without changing anything. */
    dry_run: z.boolean().default(false),
    /** Needed when the change would page a team more than once (#110): a mistake here wakes up the whole on-call rota. */
    confirm_paging: z.boolean().default(false),
  })
  .refine((b) => (b.items ? !b.ids && b.filter === undefined && !b.operation : !!b.operation && (b.ids ? b.filter === undefined : b.filter !== undefined)), {
    message: 'Give ids or filter together with an operation, or items',
  });

type Row = Record<string, any> & { id: string; title: string };

interface OpDef {
  action: Action;
  /** Nothing to do for this record. */
  noop: (row: Row, op: any) => boolean;
  apply: (user: User, row: Row, op: any) => Promise<unknown>;
  /** The operation that puts the record back, if it can be reversed. */
  undo?: (row: Row, op: any) => Operation;
}

interface PracticeDef {
  /** The teams the changes would page, and how often (incidents). */
  pages?: (changes: { row: Row; op: Operation }[]) => Promise<Map<string, number>>;
  read: Action;
  /** The rows the user may see, keyed by id, with the fields the operations compare. */
  rows: (ids: string[]) => Promise<Row[]>;
  /** The ids a list filter matches (at most limit). */
  select: (user: User, filter: Record<string, string>, limit: number) => Promise<string[]>;
  /** The most the list returns in one go, when lower than the bulk limit. */
  listMax?: number;
  ops: Partial<Record<OpName, OpDef>>;
}

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
const assignNoop = (owner: string) => (row: Row, op: any) =>
  (op.assignee_id === undefined || same(row[owner], op.assignee_id)) && (op.team_id === undefined || !('team_id' in row) || same(row.team_id, op.team_id));
const assignUndo = (owner: string) => (row: Row, op: any): Operation => ({
  op: 'assign',
  ...(op.assignee_id !== undefined ? { assignee_id: row[owner] ?? null } : {}),
  ...(op.team_id !== undefined && 'team_id' in row ? { team_id: row.team_id ?? null } : {}),
});
const assignInput = (op: any) => ({ ...(op.assignee_id !== undefined ? { assignee_id: op.assignee_id } : {}), ...(op.team_id !== undefined ? { team_id: op.team_id } : {}) });
const priority: Pick<OpDef, 'noop' | 'undo'> = {
  noop: (row, op) => (op.impact === undefined || row.impact === op.impact) && (op.urgency === undefined || row.urgency === op.urgency),
  undo: (row, op) => ({ op: 'priority', ...(op.impact !== undefined ? { impact: row.impact } : {}), ...(op.urgency !== undefined ? { urgency: row.urgency } : {}) }),
};
const statusNoop = (row: Row, op: any) => row.status === op.to;
const params = (filter: Record<string, string>, limit: number) => ({ ...filter, limit: String(limit) });

const DEFS: Record<Practice, PracticeDef> = {
  incidents: {
    read: 'incident.read',
    rows: async (ids) =>
      (await query(
        `SELECT i.ref AS id, i.id AS incident_id, i.title, i.status, i.is_major, i.assignee_id, i.team_id, i.impact, i.urgency, p.ref AS problem, pa.ref AS parent
         FROM incidents i LEFT JOIN problems p ON p.id = i.problem_id LEFT JOIN incidents pa ON pa.id = i.parent_id WHERE i.ref = ANY($1)`,
        [ids.map((i) => i.toUpperCase())],
      )).rows,
    pages: (changes) => tx(async (db) => {
      const count = new Map<string, number>();
      for (const { row, op } of changes) {
        // The incident as it would be after the change; only what paging looks at.
        const after = { id: row.incident_id, is_major: row.is_major, status: row.status, team_id: row.team_id, impact: row.impact, urgency: row.urgency };
        if (op.op === 'assign' && op.team_id !== undefined) after.team_id = op.team_id;
        else if (op.op === 'priority') Object.assign(after, { impact: op.impact ?? row.impact, urgency: op.urgency ?? row.urgency });
        else if (op.op === 'status') after.status = op.to;
        else continue;
        const hit = await oncall.wouldPage(db, { ...after, priority: after.impact + after.urgency - 1 });
        if (hit) count.set(hit.team, (count.get(hit.team) ?? 0) + 1);
      }
      return count;
    }),
    select: async (user, f, limit) => (await incidents.listIncidents(user, incidents.listIncidentsSchema.parse(params(f, limit)))).map((r: any) => r.ref),
    ops: {
      assign: { action: 'incident.update', noop: assignNoop('assignee_id'), undo: assignUndo('assignee_id'), apply: (u, r, op) => incidents.updateIncident(u, r.id, assignInput(op)) },
      priority: { action: 'incident.update', ...priority, apply: (u, r, op) => incidents.updateIncident(u, r.id, { impact: op.impact, urgency: op.urgency }) },
      status: { action: 'incident.update', noop: statusNoop, apply: (u, r, op) => incidents.transitionIncident(u, r.id, incidents.transitionIncidentSchema.parse({ ...op.details, to: op.to })) },
      // Linking copies the incident's title into the problem's history: incidents.ts does that through audience.ts (#117).
      link_problem: {
        action: 'incident.update',
        noop: (row, op) => same(row.problem, op.problem?.toUpperCase()),
        undo: (row) => ({ op: 'link_problem', problem: row.problem ?? null }),
        apply: (u, r, op) => incidents.linkIncidentToProblem(u, r.id, op.problem),
      },
      set_parent: {
        action: 'incident.update',
        noop: (row, op) => same(row.parent, op.parent.toUpperCase()),
        apply: (u, r, op) => major.linkChild(u, op.parent, { child: r.id, resolve_with_parent: op.resolve_with_parent }),
      },
    },
  },
  problems: {
    read: 'problem.read',
    rows: async (ids) => (await query('SELECT ref AS id, title, status, assignee_id, team_id, impact, urgency FROM problems WHERE ref = ANY($1)', [ids.map((i) => i.toUpperCase())])).rows,
    select: async (_user, f, limit) => (await problems.listProblems(problems.listSchema.parse(params(f, limit)))).map((r: any) => r.ref),
    ops: {
      assign: { action: 'problem.update', noop: assignNoop('assignee_id'), undo: assignUndo('assignee_id'), apply: (u, r, op) => problems.updateProblem(u, r.id, assignInput(op)) },
      priority: { action: 'problem.update', ...priority, apply: (u, r, op) => problems.updateProblem(u, r.id, { impact: op.impact, urgency: op.urgency }) },
      status: { action: 'problem.transition', noop: statusNoop, apply: (u, r, op) => problems.transitionProblem(u, r.id, problems.transitionSchema.parse({ ...op.details, to: op.to })) },
    },
  },
  changes: {
    read: 'change.read',
    rows: async (ids) => (await query('SELECT ref AS id, title, status, assignee_id, team_id FROM changes WHERE ref = ANY($1)', [ids.map((i) => i.toUpperCase())])).rows,
    select: async (user, f, limit) => (await changes.listChanges(user, changes.listChangesSchema.parse(params(f, limit)))).map((r: any) => r.ref),
    ops: {
      assign: { action: 'change.update', noop: assignNoop('assignee_id'), undo: assignUndo('assignee_id'), apply: (u, r, op) => changes.updateChange(u, r.id, assignInput(op)) },
      status: { action: 'change.update', noop: statusNoop, apply: (u, r, op) => changes.transitionChange(u, r.id, changes.transitionChangeSchema.parse({ ...op.details, to: op.to })) },
    },
  },
  alerts: {
    read: 'event.read',
    rows: async (ids) =>
      (await query("SELECT id::text AS id, coalesce(nullif(message, ''), check_key) AS title, status, acknowledged_at FROM alerts WHERE id = ANY($1::int[])", [ids.filter((i) => /^\d+$/.test(i)).map(Number)])).rows,
    select: async (user, f, limit) => (await events.listAlerts(user, events.listAlertsSchema.parse(params(f, limit)))).map((r: any) => String(r.id)),
    ops: {
      acknowledge: { action: 'event.ack', noop: (row) => !!row.acknowledged_at, apply: (u, r) => events.acknowledgeAlert(u, Number(r.id)) },
      close: { action: 'event.ack', noop: (row) => row.status === 'closed', apply: (u, r) => events.closeAlert(u, Number(r.id)) },
    },
  },
  actions: {
    read: 'problem.read',
    rows: async (ids) =>
      (await query('SELECT a.id::text AS id, a.title, a.status, a.owner_id, p.ref AS problem FROM problem_actions a JOIN problems p ON p.id = a.problem_id WHERE a.id = ANY($1::int[])', [
        ids.filter((i) => /^\d+$/.test(i)).map(Number),
      ])).rows,
    select: async (_user, f, limit) => (await actions.listActions(actions.listActionsSchema.parse(params(f, limit)))).map((r: any) => String(r.id)),
    ops: {
      assign: { action: 'action.write', noop: assignNoop('owner_id'), undo: assignUndo('owner_id'), apply: (u, r, op) => actions.updateAction(u, r.problem, Number(r.id), op.assignee_id !== undefined ? { owner_id: op.assignee_id } : {}) },
      status: { action: 'action.write', noop: statusNoop, undo: (row) => ({ op: 'status', to: row.status, details: {} }), apply: (u, r, op) => actions.updateAction(u, r.problem, Number(r.id), { status: z.enum(actions.ACTION_STATUSES).parse(op.to) }) },
    },
  },
  articles: {
    read: 'article.read',
    rows: async (ids) => (await query('SELECT ref AS id, title, status, owner_id FROM articles WHERE ref = ANY($1)', [ids.map((i) => i.toUpperCase())])).rows,
    listMax: 200,
    select: async (user, f, limit) => (await knowledge.listArticles(user, knowledge.listArticlesSchema.parse(params(f, limit)))).map((r: any) => r.ref),
    ops: {
      assign: { action: 'article.write', noop: assignNoop('owner_id'), undo: assignUndo('owner_id'), apply: (u, r, op) => knowledge.updateArticle(u, r.id, op.assignee_id !== undefined ? { owner_id: op.assignee_id } : {}) },
      status: { action: 'article.write', noop: statusNoop, apply: (u, r, op) => knowledge.transitionArticle(u, r.id, knowledge.transitionArticleSchema.parse({ ...op.details, to: op.to })) },
    },
  },
  cis: {
    read: 'ci.read',
    rows: async (ids) => (await query('SELECT ref AS id, name AS title, status, tags FROM configuration_items WHERE ref = ANY($1)', [ids.map((i) => i.toUpperCase())])).rows,
    select: async (user, f, limit) => (await cmdb.listCis(user, cmdb.listCisSchema.parse(params(f, limit)))).map((r: any) => r.ref),
    ops: {
      tags: {
        action: 'ci.manage',
        noop: (row, op) => op.add.every((t: string) => row.tags.includes(t)) && !op.remove.some((t: string) => row.tags.includes(t)),
        undo: (row, op) => ({ op: 'tags', add: op.remove.filter((t: string) => row.tags.includes(t)), remove: op.add.filter((t: string) => !row.tags.includes(t)) }),
        apply: (u, r, op) => cmdb.updateCi(u, r.id, { tags: [...new Set([...r.tags.filter((t: string) => !op.remove.includes(t)), ...op.add])] }),
      },
      status: { action: 'ci.manage', noop: statusNoop, apply: (u, r, op) => cmdb.transitionCi(u, r.id, cmdb.transitionCiSchema.parse({ ...op.details, to: op.to })) },
    },
  },
};

/** The operations each practice offers, for the UI and the MCP tool description. */
export const operationsFor = (practice: Practice) => Object.keys(DEFS[practice].ops) as OpName[];

export type Outcome = 'changed' | 'would_change' | 'unchanged' | 'skipped' | 'failed';
export interface ItemResult {
  id: string;
  title?: string;
  outcome: Outcome;
  reason?: string;
}

export async function bulk(user: User, practice: Practice, input: z.infer<typeof bulkSchema>) {
  const def = DEFS[practice];
  authorize(user, def.read);
  // One operation for all, or one per record (an undo).
  let work: { id: string; operation: Operation }[];
  if (input.items) {
    work = input.items.map((i) => ({ id: String(i.id), operation: i.operation }));
  } else {
    let ids = input.ids?.map(String);
    if (!ids) {
      const filter = Object.fromEntries(new URLSearchParams(input.filter));
      delete filter.limit;
      // Lists return at most their limit, so a full page means there may be more than a bulk request may take.
      const max = def.listMax ?? BULK_LIMIT;
      ids = await def.select(user, filter, max);
      if (ids.length >= max) throw badRequest(`The filter matches ${max} records or more; narrow it down first`);
    }
    work = [...new Set(ids)].map((id) => ({ id, operation: input.operation! }));
  }
  if (work.length > BULK_LIMIT) throw badRequest(`At most ${BULK_LIMIT} records at a time`);
  // The role must allow every operation asked for; the whole request is refused otherwise.
  for (const name of new Set(work.map((w) => w.operation.op))) {
    const op = def.ops[name];
    if (!op) throw badRequest(`${practice} offer these bulk operations: ${operationsFor(practice).join(', ')}`);
    authorize(user, op.action);
  }

  // Records the user cannot see are not there (#53).
  const rows = new Map((await def.rows(work.map((w) => w.id))).map((r) => [r.id.toUpperCase(), r]));

  // On-call: count the pages this would send, and ask for confirmation before paging a team more than once.
  const changing = work.flatMap((w) => {
    const row = rows.get(w.id.toUpperCase());
    return row && !def.ops[w.operation.op]!.noop(row, w.operation) ? [{ row, op: w.operation }] : [];
  });
  const pageCount = def.pages ? await def.pages(changing) : new Map<string, number>();
  const pages = [...pageCount].map(([team, count]) => ({ team, count }));
  const storm = pages.filter((p) => p.count > 1);
  if (storm.length && !input.dry_run && !input.confirm_paging) {
    throw new HttpError(409, `This would page ${storm.map((p) => `${p.team} ${p.count} times`).join(' and ')}; confirm with confirm_paging`, { pages, confirm_paging_required: true });
  }
  const results: ItemResult[] = [];
  const undo: { id: string; operation: Operation }[] = [];
  let undoable = true;
  for (const w of work) {
    const row = rows.get(w.id.toUpperCase());
    if (!row) {
      results.push({ id: w.id, outcome: 'skipped', reason: 'Not found, or not visible to you' });
      continue;
    }
    const op = def.ops[w.operation.op]!;
    if (op.noop(row, w.operation)) {
      results.push({ id: row.id, title: row.title, outcome: 'unchanged', reason: 'Already so' });
      continue;
    }
    if (input.dry_run) {
      results.push({ id: row.id, title: row.title, outcome: 'would_change' });
      continue;
    }
    try {
      await op.apply(user, row, w.operation);
      results.push({ id: row.id, title: row.title, outcome: 'changed' });
      if (op.undo) undo.push({ id: row.id, operation: op.undo(row, w.operation) });
      else undoable = false;
    } catch (err) {
      if (err instanceof z.ZodError) results.push({ id: row.id, title: row.title, outcome: 'failed', reason: err.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ') });
      else if (err instanceof HttpError) results.push({ id: row.id, title: row.title, outcome: err.statusCode === 404 ? 'skipped' : 'failed', reason: err.message });
      else {
        logger.error({ err, practice, id: row.id }, 'bulk operation failed');
        results.push({ id: row.id, title: row.title, outcome: 'failed', reason: 'Could not be changed; try this one on its own' });
      }
    }
  }
  const count = (o: Outcome) => results.filter((r) => r.outcome === o).length;
  const summary = { changed: count('changed'), would_change: count('would_change'), unchanged: count('unchanged'), skipped: count('skipped'), failed: count('failed') };
  // Each record's own audit entry comes from its service function; this one ties them together as one request.
  if (!input.dry_run && summary.changed) {
    const ops = [...new Set(work.map((w) => w.operation.op))];
    await audit(null, { entity_type: 'bulk', entity_ref: practice, action: ops.join(','), changes: { ...summary, ids: results.filter((r) => r.outcome === 'changed').map((r) => r.id) } });
  }
  return {
    practice,
    dry_run: input.dry_run,
    total: work.length,
    summary,
    /** Pages the change sends (dry run: would send), per team. */
    pages,
    results,
    // Send this back as the request body to reverse what was changed.
    undo: !input.dry_run && undoable && undo.length ? { items: undo } : null,
  };
}

/** Who may use bulk at all: anyone who can do one of the operations on some practice. */
export const canBulk = (user: User) => PRACTICES.some((p) => Object.values(DEFS[p].ops).some((o) => can(user.role, o!.action)));

/** Reading the practice's list is the least a bulk request needs (each operation checks its own permission). */
export const readActionOf = (practice: Practice) => DEFS[practice].read;
