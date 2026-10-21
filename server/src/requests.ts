// Service request management (#44), an optional module: things people ask for ("new account", "access to a system",
// "a new VM") are not incidents and stay out of incident numbers. A catalogue of request items per service, each with
// a short form, an optional approval and an ordered list of fulfilment tasks for teams. A request (REQ000012) is made
// for a person by the user who logs it, may wait for its approver, and is fulfilled when its last task is done. The
// item's SLA runs from submission to fulfilment and pauses while the request waits for approval. Shared by REST, MCP
// and the web UI; agents may log and follow requests, but only a person approves.
import { z } from 'zod';
import type { User } from './auth.js';
import { audit } from './audit.js';
import { assertMayWriteText, textFilterSql } from './confidential.js';
import { currentContext } from './context.js';
import { pool, query, tx } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { notify } from './notifications.js';
import { authorize, can } from './policy.js';
import type { Db } from './problems.js';
import { recordUrl, registerRecordType, typeForRef, type RecordType } from './records.js';
import { recomputeSla, slaClock, slaOnTransition } from './sla.js';
import { checkAssigneeInTeam, teamMembers } from './teams.js';
import { assertVisibleRef } from './visibility.js';

export const REQUEST_STATUSES = ['submitted', 'awaiting_approval', 'in_fulfilment', 'fulfilled', 'rejected', 'cancelled'] as const;
type Status = (typeof REQUEST_STATUSES)[number];
const DONE: Status[] = ['fulfilled', 'rejected', 'cancelled'];
export const FIELD_TYPES = ['text', 'textarea', 'choice', 'person', 'ci', 'date'] as const;
export const REQUEST_LINK_KINDS = ['incident', 'change', 'problem', 'ci', 'document'] as const;
const FREE_TEXT = new Set(['text', 'textarea']);

// ---- The catalogue ---------------------------------------------------------------------------

export const formFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'A key is lower case letters, digits and _, starting with a letter'),
  label: z.string().trim().min(1).max(100),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().default(false),
  /** For a choice: the options to pick from. */
  choices: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
}).refine((f) => f.type !== 'choice' || f.choices.length > 0, { message: 'A choice field needs its choices', path: ['choices'] });
export type FormField = z.infer<typeof formFieldSchema>;

export const requestItemSchema = z.object({
  /** The service (a CI of class service) by ref. */
  service: z.string().trim().min(1).max(30),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(''),
  form: z.array(formFieldSchema).max(10, 'A form has at most 10 fields: keep it short').default([])
    .refine((f) => new Set(f.map((x) => x.key)).size === f.length, 'Each field needs its own key'),
  /** none, requester_manager, service_owner or team:<id>. */
  approval: z.string().regex(/^(none|requester_manager|service_owner|team:\d{1,9})$/, 'Approval is none, requester_manager, service_owner or team:<id>').default('none'),
  fulfilment_tasks: z.array(z.object({ title: z.string().trim().min(1).max(200), team_id: z.number().int().nullable().default(null) })).min(1, 'Add at least one fulfilment task').max(20),
  sla_id: z.number().int().nullable().default(null),
  /** Part 2 of #44: the standard change an approved request makes. */
  standard_change_template_id: z.number().int().nullable().default(null),
  active: z.boolean().default(true),
});
export const listItemsSchema = z.object({ service: z.string().trim().max(30).optional(), inactive: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false) });

const ITEM_SELECT = `
  SELECT i.id, i.name, i.description, i.form, i.approval, i.approval_team_id, i.fulfilment_tasks, i.sla_id, i.standard_change_template_id, i.active,
         i.created_at, i.updated_at, c.ref AS service_ref, c.name AS service_name, s.name AS sla, t.name AS approval_team
  FROM request_items i JOIN configuration_items c ON c.id = i.service_id LEFT JOIN slas s ON s.id = i.sla_id LEFT JOIN teams t ON t.id = i.approval_team_id`;

const itemOut = (i: any) => {
  const { approval, approval_team_id, service_ref, service_name, ...rest } = i;
  return {
    ...rest,
    approval: approval === 'team' ? `team:${approval_team_id}` : approval,
    approval_label: { none: 'No approval', requester_manager: "The requester's manager", service_owner: 'The service owner', team: `The ${i.approval_team ?? 'team'} team` }[approval as string],
    service: { ref: service_ref, name: service_name },
  };
};

export async function listRequestItems(user: User, f: z.infer<typeof listItemsSchema>) {
  authorize(user, 'request.read');
  const where = [f.inactive && can(user.role, 'request.manage') ? 'true' : 'i.active'];
  const params: unknown[] = [];
  if (f.service) { params.push(f.service.toUpperCase()); where.push(`c.ref = $${params.length}`); }
  const { rows } = await query(`${ITEM_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.name, i.name`, params);
  return rows.map(itemOut);
}

export async function getRequestItem(user: User, id: number) {
  authorize(user, 'request.read');
  const { rows } = await query(`${ITEM_SELECT} WHERE i.id = $1`, [id]);
  if (!rows[0] || (!rows[0].active && !can(user.role, 'request.manage'))) throw notFound('Request item not found');
  return itemOut(rows[0]);
}

export async function saveRequestItem(user: User, id: number | null, input: z.infer<typeof requestItemSchema>) {
  authorize(user, 'request.manage');
  const saved = await tx(async (db) => {
    const { rows: svc } = await db.query("SELECT id FROM configuration_items WHERE ref = $1 AND class = 'service'", [input.service.toUpperCase()]);
    if (!svc[0]) throw badRequest(`${input.service.toUpperCase()} is not a service`);
    const [approval, team] = input.approval.split(':');
    const teamIds = [...new Set([...(team ? [Number(team)] : []), ...input.fulfilment_tasks.map((t) => t.team_id).filter((t): t is number => t !== null)])];
    if (teamIds.length) {
      const { rows } = await db.query('SELECT count(*)::int AS n FROM teams WHERE id = ANY($1) AND active', [teamIds]);
      if (rows[0].n !== teamIds.length) throw badRequest('Unknown or inactive team');
    }
    if (input.sla_id !== null && !(await db.query('SELECT 1 FROM slas WHERE id = $1', [input.sla_id])).rows[0]) throw badRequest('Unknown SLA');
    if (input.standard_change_template_id !== null && !(await db.query('SELECT 1 FROM change_templates WHERE id = $1', [input.standard_change_template_id])).rows[0]) throw badRequest('Unknown standard change template');
    const values = [svc[0].id, input.name, input.description, JSON.stringify(input.form), approval, team ? Number(team) : null, JSON.stringify(input.fulfilment_tasks), input.sla_id, input.standard_change_template_id, input.active];
    const before = id ? (await db.query('SELECT * FROM request_items WHERE id = $1 FOR UPDATE', [id])).rows[0] : null;
    if (id && !before) throw notFound('Request item not found');
    try {
      const { rows } = id
        ? await db.query(
            `UPDATE request_items SET service_id = $2, name = $3, description = $4, form = $5, approval = $6, approval_team_id = $7, fulfilment_tasks = $8,
               sla_id = $9, standard_change_template_id = $10, active = $11, updated_at = now() WHERE id = $1 RETURNING id`,
            [id, ...values],
          )
        : await db.query(
            `INSERT INTO request_items (service_id, name, description, form, approval, approval_team_id, fulfilment_tasks, sla_id, standard_change_template_id, active, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
            [...values, user.id],
          );
      // The catalogue's history is the audit trail: what each version of the item asked and who changed it.
      await audit(db, { entity_type: 'request_item', entity_ref: `#${rows[0].id}`, action: id ? 'update' : 'create', changes: { ...input, ...(before ? { before: { name: before.name, form: before.form, approval: before.approval, fulfilment_tasks: before.fulfilment_tasks, active: before.active } } : {}) } });
      return rows[0].id as number;
    } catch (err: any) {
      if (err.code === '23505') throw conflict('The service already has a request item with that name');
      throw err;
    }
  });
  return getRequestItem(user, saved);
}

// ---- Answers ---------------------------------------------------------------------------------

/**
 * Checks answers against the item's form on the server: unknown fields are refused, required ones must be there, and
 * every value has the field's type; a person or CI must exist and be visible to the caller.
 */
export async function validateAnswers(db: Db, form: FormField[], answers: Record<string, unknown>) {
  const byKey = new Map(form.map((f) => [f.key, f]));
  const unknown = Object.keys(answers).filter((k) => !byKey.has(k));
  if (unknown.length) throw badRequest(`The form has no field ${unknown.map((k) => `"${k}"`).join(', ')}`);
  const out: Record<string, string | number> = {};
  for (const f of form) {
    const v = answers[f.key];
    if (v === undefined || v === null || v === '') {
      if (f.required) throw badRequest(`"${f.label}" is required`);
      continue;
    }
    const wrong = (what: string) => badRequest(`"${f.label}" must be ${what}`);
    switch (f.type) {
      case 'text':
      case 'textarea': {
        if (typeof v !== 'string') throw wrong('text');
        const max = f.type === 'text' ? 500 : 10000;
        if (v.length > max) throw wrong(`at most ${max} characters`);
        if (v.trim() || f.required) out[f.key] = v.trim();
        if (f.required && !v.trim()) throw badRequest(`"${f.label}" is required`);
        break;
      }
      case 'choice':
        if (typeof v !== 'string' || !f.choices.includes(v)) throw wrong(`one of ${f.choices.join(', ')}`);
        out[f.key] = v;
        break;
      case 'date':
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw wrong('a date (YYYY-MM-DD)');
        out[f.key] = v;
        break;
      case 'person': {
        const id = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
        if (!Number.isInteger(id)) throw wrong('a person (their id)');
        if (!(await db.query('SELECT 1 FROM people WHERE id = $1 AND erased_at IS NULL AND active', [id])).rows[0]) throw badRequest(`"${f.label}": no such person`);
        out[f.key] = id;
        break;
      }
      case 'ci': {
        if (typeof v !== 'string' || !/^[A-Za-z]{2,5}\d{1,9}$/.test(v.trim())) throw wrong('a CI (its ref)');
        // Row-level security: a CI the caller cannot see answers like one that does not exist.
        if (!(await db.query('SELECT 1 FROM configuration_items WHERE ref = $1', [v.trim().toUpperCase()])).rows[0]) throw badRequest(`"${f.label}": no such CI`);
        out[f.key] = v.trim().toUpperCase();
        break;
      }
    }
  }
  return out;
}

/** The answers as shown: each field with its label; free text under answer_text, so it is masked like other free text (#61). */
async function answersOut(form: FormField[], answers: Record<string, string | number>) {
  const personIds = form.filter((f) => f.type === 'person' && answers[f.key] !== undefined).map((f) => Number(answers[f.key]));
  const ciRefs = form.filter((f) => f.type === 'ci' && answers[f.key] !== undefined).map((f) => String(answers[f.key]));
  const [people, cis] = await Promise.all([
    personIds.length ? query('SELECT id, name FROM people WHERE id = ANY($1)', [personIds]) : { rows: [] as any[] },
    ciRefs.length ? query('SELECT ref, name FROM configuration_items WHERE ref = ANY($1)', [ciRefs]) : { rows: [] as any[] },
  ]);
  return form.map((f) => {
    const v = answers[f.key];
    const base = { key: f.key, label: f.label, type: f.type };
    if (v === undefined) return { ...base, value: null };
    if (FREE_TEXT.has(f.type)) return { ...base, answer_text: String(v) };
    if (f.type === 'person') return { ...base, value: v, display: people.rows.find((p) => p.id === Number(v))?.name ?? 'Removed person' };
    if (f.type === 'ci') return { ...base, value: v, display: cis.rows.find((c) => c.ref === v)?.name ?? null };
    return { ...base, value: v };
  });
}

// ---- Approval --------------------------------------------------------------------------------

/**
 * The approvers of a new request, resolved when it is submitted and stored with it: the requester's manager (their
 * Kernel account), the service owner, or the members of a team. The requester never approves their own request.
 */
async function resolveApprovers(db: Db, item: any, requester: { id: number; user_id: number | null; name: string }) {
  if (item.approval === 'none') return [];
  let ids: number[] = [];
  let who = '';
  if (item.approval === 'requester_manager') {
    const { rows } = await db.query(
      `SELECT m.name, u.id FROM people p JOIN people m ON m.id = p.manager_id AND m.erased_at IS NULL LEFT JOIN users u ON u.id = m.user_id AND u.active WHERE p.id = $1`,
      [requester.id],
    );
    if (!rows[0]) throw badRequest(`${requester.name} has no manager in Kernel, and this request needs their manager's approval. Add the manager to the contact first.`);
    ids = rows[0].id ? [rows[0].id] : [];
    who = `${rows[0].name}, ${requester.name}'s manager,`;
  } else if (item.approval === 'service_owner') {
    const { rows } = await db.query('SELECT u.id, c.name FROM configuration_items c LEFT JOIN users u ON u.id = c.owner_id AND u.active WHERE c.id = $1', [item.service_id]);
    ids = rows[0]?.id ? [rows[0].id] : [];
    who = `the owner of ${rows[0]?.name ?? 'the service'}`;
  } else {
    ids = await teamMembers(db, item.approval_team_id);
    who = 'no one in the approving team';
  }
  ids = ids.filter((id) => id !== requester.user_id);
  if (!ids.length) throw badRequest(`This request needs approval, but ${who} cannot approve it (no Kernel account, or it is the requester). Ask an administrator to fix the catalogue item.`);
  return ids;
}

// ---- Reading ---------------------------------------------------------------------------------

const SELECT = `
  SELECT r.*, i.name AS item_name, i.form, i.service_id, c.ref AS service_ref, c.name AS service_name,
         p.name AS requester_name, p.email AS requester_email, p.user_id AS requester_user_id, cb.display_name AS created_by_name, d.display_name AS decided_by_name
  FROM requests r JOIN request_items i ON i.id = r.item_id JOIN configuration_items c ON c.id = i.service_id JOIN people p ON p.id = r.requester_id
  LEFT JOIN users cb ON cb.id = r.created_by LEFT JOIN users d ON d.id = r.decided_by`;

/** People and agents never decide by API token or MCP: approving is a person's act in the web UI or by approval link. */
const byPerson = () => !['mcp', 'api_token', 'integration'].includes(currentContext().actorType) && currentContext().channel !== 'mcp';

const STATUS_LABEL: Record<Status, string> = {
  submitted: 'Submitted', awaiting_approval: 'Awaiting approval', in_fulfilment: 'In fulfilment', fulfilled: 'Fulfilled', rejected: 'Rejected', cancelled: 'Cancelled',
};

export async function getRequest(user: User, ref: string) {
  authorize(user, 'request.read');
  const { rows } = await query(`${SELECT} WHERE r.ref = $1`, [ref.toUpperCase()]);
  const r = rows[0];
  if (!r) throw notFound(`Request ${ref.toUpperCase()} not found`);
  const [activity, tasks, links, approvers, sla] = await Promise.all([
    query(
      `SELECT a.id, a.kind, a.body, a.data, a.channel, a.created_at, u.display_name AS user_name
       FROM request_activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.request_id = $1 ORDER BY a.created_at DESC, a.id DESC`,
      [r.id],
    ),
    query(
      `SELECT t.id, t.position, t.title, t.status, t.note, t.team_id, tm.name AS team, t.assignee_id, a.display_name AS assignee, t.opened_at, t.done_at, d.display_name AS done_by
       FROM request_tasks t LEFT JOIN teams tm ON tm.id = t.team_id LEFT JOIN users a ON a.id = t.assignee_id LEFT JOIN users d ON d.id = t.done_by
       WHERE t.request_id = $1 ORDER BY t.position`,
      [r.id],
    ),
    query('SELECT id, kind, reference, system, url, note, created_at FROM request_links WHERE request_id = $1 ORDER BY kind, created_at', [r.id]),
    r.approver_ids.length ? query('SELECT id, display_name FROM users WHERE id = ANY($1) ORDER BY display_name', [r.approver_ids]) : { rows: [] as any[] },
    slaClock(pool, r),
  ]);
  const myTeams = (await query('SELECT team_id FROM team_members WHERE user_id = $1', [user.id])).rows.map((t) => t.team_id as number);
  const mayWork = can(user.role, 'request.write');
  const mayDecide = r.status === 'awaiting_approval' && r.approver_ids.includes(user.id) && byPerson();
  const detail = {
    type: 'request',
    id: r.id,
    ref: r.ref,
    title: r.title,
    status: r.status,
    status_label: STATUS_LABEL[r.status as Status],
    priority: r.priority,
    item: { id: r.item_id, name: r.item_name },
    service: { ref: r.service_ref, name: r.service_name },
    requester: { id: r.requester_id, name: r.requester_name, ...(can(user.role, 'person.contact') ? { email: r.requester_email } : {}) },
    on_behalf_of: r.created_by_name,
    answers: await answersOut(r.form, r.answers),
    approval: {
      kind: r.approval,
      approvers: approvers.rows.map((a) => a.display_name),
      decided_by: r.decided_by_name,
      decided_at: r.decided_at,
      reject_reason: r.reject_reason || null,
      may_decide: mayDecide,
    },
    cancel_reason: r.cancel_reason || null,
    tasks: tasks.rows.map((t) => ({
      ...t,
      may_complete: t.status === 'open' && mayWork && (!t.team_id || t.assignee_id === user.id || myTeams.includes(t.team_id) || can(user.role, 'request.manage')),
    })),
    sla,
    links: links.rows,
    activity: activity.rows,
    restricted: r.restricted,
    restricted_teams: r.restricted_teams,
    classification: r.classification,
    contains_personal_data: r.contains_personal_data,
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    responded_at: r.responded_at,
    resolved_at: r.resolved_at,
    transitions: mayWork ? transitionsFor(r.status as Status, mayDecide) : [],
    url: requestUrl(r.ref),
  };
  return { ...detail, next_steps: requestGuidance(detail) };
}

function transitionsFor(status: Status, mayDecide: boolean) {
  const out: string[] = [];
  if (status === 'awaiting_approval' && mayDecide) out.push('approved', 'rejected');
  if (!DONE.includes(status)) out.push('cancelled');
  return out;
}

/** Guided mode (#37): where the request stands. */
function requestGuidance(r: { status: string; approval: { kind: string; approvers: string[] }; tasks: { status: string; title: string; team: string | null }[] }) {
  const open = r.tasks.find((t) => t.status === 'open');
  if (DONE.includes(r.status as Status)) return { phase: STATUS_LABEL[r.status as Status], purpose: 'Service request: done.', steps: [], next: 'Nothing pending.' };
  const steps = [
    ...(r.approval.kind === 'none' ? [] : [{ id: 'approve', label: `Approval by ${r.approval.approvers.join(', ')}`, hint: 'Only a person approves; the requester never approves their own request.', done: r.status !== 'awaiting_approval' }]),
    ...r.tasks.map((t) => ({ id: `task:${t.title}`, label: t.title, hint: t.team ? `In the ${t.team} queue` : 'Anyone can do it', done: t.status === 'done' })),
  ];
  return {
    phase: STATUS_LABEL[r.status as Status],
    purpose: 'Service request: fulfil what was asked for, in order, and keep the requester informed.',
    steps,
    next: r.status === 'awaiting_approval' ? `Waiting for ${r.approval.approvers.join(' or ')} to approve` : open ? `${open.title}${open.team ? ` (${open.team})` : ''}` : 'Nothing pending.',
  };
}

export const listRequestsSchema = z.object({
  status: z.enum([...REQUEST_STATUSES, 'open', 'all']).default('open'),
  /** Requests whose open task is mine, or in one of my teams. */
  task: z.enum(['mine', 'my_teams']).optional(),
  requester: z.coerce.number().int().optional(),
  item: z.coerce.number().int().optional(),
  service: z.string().trim().max(30).optional(),
  /** Requests waiting for my approval. */
  awaiting_me: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  /** Resolution target breached or due within two hours. */
  breaching: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(['updated', 'created', 'due']).default('updated'),
  bulk: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export async function listRequests(user: User, f: z.infer<typeof listRequestsSchema>) {
  authorize(user, 'request.read');
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll('?', `$${params.length}`)); };
  if (f.status === 'open') where.push("r.status NOT IN ('fulfilled', 'rejected', 'cancelled')");
  else if (f.status !== 'all') add('r.status = ?', f.status);
  if (f.task === 'mine') add("EXISTS (SELECT 1 FROM request_tasks t WHERE t.request_id = r.id AND t.status = 'open' AND t.assignee_id = ?)", user.id);
  if (f.task === 'my_teams') add("EXISTS (SELECT 1 FROM request_tasks t WHERE t.request_id = r.id AND t.status = 'open' AND t.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?))", user.id);
  if (f.requester) add('r.requester_id = ?', f.requester);
  if (f.item) add('r.item_id = ?', f.item);
  if (f.service) add('c.ref = ?', f.service.toUpperCase());
  if (f.awaiting_me) add("r.status = 'awaiting_approval' AND ? = ANY(r.approver_ids)", user.id);
  if (f.breaching) where.push("r.status NOT IN ('fulfilled', 'rejected', 'cancelled') AND (r.resolution_breached_at IS NOT NULL OR (r.sla_paused_since IS NULL AND r.resolution_due_at < now() + interval '2 hours'))");
  if (f.bulk) add('r.ref IN (SELECT unnest(refs) FROM bulk_requests WHERE id = ?)', f.bulk);
  if (f.q) {
    const terms = f.q.split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}_.-]/gu, '')).filter(Boolean);
    if (terms.length) where.push(textFilterSql('r', 'request', terms.map((t) => `${t}:*`).join(' & '), params));
  }
  params.push(f.limit);
  const order = { updated: 'r.updated_at DESC', created: 'r.created_at DESC', due: 'r.resolution_due_at NULLS LAST, r.created_at' }[f.sort];
  const { rows } = await query(
    `SELECT r.ref, r.title, r.status, r.priority, r.item_id, i.name AS item, c.ref AS service_ref, c.name AS service_name, p.name AS requester,
            r.created_at, r.updated_at, r.resolution_due_at, r.resolved_at,
            (r.resolution_breached_at IS NOT NULL OR (r.status NOT IN ('fulfilled', 'rejected', 'cancelled') AND r.sla_paused_since IS NULL AND r.resolution_due_at < now() + interval '2 hours')) AS at_risk,
            t.title AS open_task, t.team_id AS open_task_team_id, tm.name AS open_task_team, t.assignee_id AS open_task_assignee_id, ta.display_name AS open_task_assignee
     FROM requests r JOIN request_items i ON i.id = r.item_id JOIN configuration_items c ON c.id = i.service_id JOIN people p ON p.id = r.requester_id
     LEFT JOIN LATERAL (SELECT * FROM request_tasks x WHERE x.request_id = r.id AND x.status = 'open' ORDER BY x.position LIMIT 1) t ON true
     LEFT JOIN teams tm ON tm.id = t.team_id LEFT JOIN users ta ON ta.id = t.assignee_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({ type: 'request', ...r, status_label: STATUS_LABEL[r.status as Status], url: requestUrl(r.ref) }));
}

// ---- Changing --------------------------------------------------------------------------------

export async function logRequest(db: Db, id: number, userId: number | null, kind: string, body = '', data: object = {}) {
  await db.query('INSERT INTO request_activity (request_id, user_id, kind, body, data, channel) VALUES ($1, $2, $3, $4, $5, $6)', [
    id, userId, kind, body, JSON.stringify(data), currentContext().channel,
  ]);
  const { rows } = await db.query('UPDATE requests SET updated_at = now() WHERE id = $1 RETURNING ref', [id]);
  await audit(db, { entity_type: 'request', entity_ref: rows[0].ref, action: kind, changes: kind === 'comment' ? { body } : (data as Record<string, unknown>) });
}

async function loadRequest(db: Db, ref: string) {
  const { rows } = await db.query('SELECT * FROM requests WHERE ref = $1 FOR UPDATE', [ref.toUpperCase()]);
  if (!rows[0]) throw notFound(`Request ${ref.toUpperCase()} not found`);
  return rows[0];
}

const personRefSchema = z.object({ id: z.number().int().optional(), email: z.string().trim().email().max(200).optional() })
  .refine((p) => p.id !== undefined || p.email !== undefined, 'Give the person by id or email');

export const createRequestSchema = z.object({
  item_id: z.number().int(),
  /** The person it is for (a contact, #39); by default the person linked to the caller's account. */
  requester: personRefSchema.optional(),
  /** By default "<item> for <requester>". */
  title: z.string().trim().min(1).max(300).optional(),
  answers: z.record(z.string(), z.unknown()).default({}),
  priority: z.number().int().min(1).max(5).default(3),
});
export const updateRequestSchema = z.object({
  title: z.string().trim().min(1).max(300),
  priority: z.number().int().min(1).max(5),
  /** The whole form again; only before fulfilment starts. */
  answers: z.record(z.string(), z.unknown()),
}).partial();
export const transitionRequestSchema = z.object({
  /** approved and rejected are a person's decision (the approver, in the web UI); cancelled needs a reason. */
  to: z.enum(['approved', 'rejected', 'cancelled']),
  reason: z.string().trim().max(2000).optional(),
});
export const decisionSchema = z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().trim().max(2000).default('') });
export const completeTaskSchema = z.object({ note: z.string().trim().max(5000).default('') });
export const assignTaskSchema = z.object({ assignee_id: z.number().int().nullable() });

async function findRequester(db: Db, user: User, p: z.infer<typeof personRefSchema> | undefined) {
  const { rows } = p
    ? await db.query(`SELECT id, name, user_id FROM people WHERE ${p.id !== undefined ? 'id = $1' : 'lower(email) = lower($1)'} AND erased_at IS NULL AND active`, [p.id ?? p.email])
    : await db.query('SELECT id, name, user_id FROM people WHERE user_id = $1 AND erased_at IS NULL AND active', [user.id]);
  if (!rows[0]) throw badRequest(p ? 'No such person. Add them to People first.' : 'Say who the request is for: your account is not linked to a person in People.');
  return rows[0] as { id: number; name: string; user_id: number | null };
}

/** Creates the item's fulfilment tasks, in order, with the first one open, and tells its team. */
async function startFulfilment(db: Db, r: { id: number; ref: string; title: string; item_id: number }, actorId: number | null) {
  const { rows } = await db.query('SELECT fulfilment_tasks FROM request_items WHERE id = $1', [r.item_id]);
  const tasks = rows[0].fulfilment_tasks as { title: string; team_id: number | null }[];
  for (const [n, t] of tasks.entries()) {
    await db.query(
      'INSERT INTO request_tasks (request_id, position, title, team_id, status, opened_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [r.id, n + 1, t.title, t.team_id, n === 0 ? 'open' : 'pending', n === 0 ? new Date() : null],
    );
  }
  await db.query("UPDATE requests SET status = 'in_fulfilment' WHERE id = $1", [r.id]);
  await openedTask(db, r, actorId);
}

/** The open task lands in its team's queue: the members hear about it. */
async function openedTask(db: Db, r: { id: number; ref: string; title: string }, actorId: number | null) {
  const { rows } = await db.query("SELECT t.id, t.title, t.team_id, tm.name AS team FROM request_tasks t LEFT JOIN teams tm ON tm.id = t.team_id WHERE t.request_id = $1 AND t.status = 'open' ORDER BY t.position LIMIT 1", [r.id]);
  const t = rows[0];
  if (!t?.team_id) return;
  await notify(db, {
    users: await teamMembers(db, t.team_id), event: 'team_queue', ref: r.ref, title: r.title, summary: `${t.title}: new in the ${t.team} queue.`,
    path: `/requests/${r.ref}`, dedupe: `team_queue:${r.ref}:task:${t.id}`, actorId,
  });
}

export async function createRequest(user: User, input: z.infer<typeof createRequestSchema>) {
  authorize(user, 'request.write');
  const ref = await tx(async (db) => {
    const { rows: items } = await db.query('SELECT * FROM request_items WHERE id = $1 AND active', [input.item_id]);
    const item = items[0];
    if (!item) throw notFound('Request item not found');
    const requester = await findRequester(db, user, input.requester);
    const answers = await validateAnswers(db, item.form, input.answers);
    const approvers = await resolveApprovers(db, item, requester);
    const { rows } = await db.query(
      `INSERT INTO requests (item_id, title, requester_id, answers, priority, approval, approver_ids, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, ref, title, item_id`,
      [item.id, input.title ?? `${item.name} for ${requester.name}`, requester.id, JSON.stringify(answers), input.priority, item.approval, approvers, user.id],
    );
    const r = rows[0];
    await logRequest(db, r.id, user.id, 'created', requester.user_id === user.id ? 'Submitted' : `Submitted for ${requester.name}`, { item: item.name, requester: requester.id });
    await recomputeSla(db, r.id, { reselect: true }, 'request');
    if (approvers.length) {
      await db.query("UPDATE requests SET status = 'awaiting_approval' WHERE id = $1", [r.id]);
      await slaOnTransition(db, r.id, 'awaiting_approval', new Date(), 'request');
      await logRequest(db, r.id, null, 'status', 'Waiting for approval', { status: { from: 'submitted', to: 'awaiting_approval' } });
      await notify(db, {
        users: approvers, event: 'approval_needed', ref: r.ref, title: r.title, summary: `${requester.name} asks for ${item.name}. It waits for your approval.`,
        path: `/requests/${r.ref}`, dedupe: `request-approval:${r.ref}`, actorId: user.id,
      });
    } else {
      await startFulfilment(db, r, user.id);
      await logRequest(db, r.id, null, 'status', 'In fulfilment', { status: { from: 'submitted', to: 'in_fulfilment' } });
    }
    return r.ref as string;
  });
  return getRequest(user, ref);
}

export async function updateRequestLean(user: User, ref: string, input: z.infer<typeof updateRequestSchema>): Promise<void> {
  authorize(user, 'request.write');
  // No blind overwrites of masked text (#61, #156): the answers hold free text.
  await assertMayWriteText(user, ref, { answer_text: input.answers });
  await tx(async (db) => {
    const r = await loadRequest(db, ref);
    if (DONE.includes(r.status)) throw conflict(`${r.ref} is ${r.status}`);
    const changed: string[] = [];
    const data: Record<string, unknown> = {};
    if (input.title !== undefined && input.title !== r.title) {
      await db.query('UPDATE requests SET title = $2 WHERE id = $1', [r.id, input.title]);
      changed.push('title');
      data.title = { from: r.title, to: input.title };
    }
    if (input.priority !== undefined && input.priority !== r.priority) {
      await db.query('UPDATE requests SET priority = $2 WHERE id = $1', [r.id, input.priority]);
      changed.push('priority');
      data.priority = { from: r.priority, to: input.priority };
    }
    if (input.answers !== undefined) {
      if (r.status === 'in_fulfilment') throw conflict('Fulfilment has started: the answers can no longer change. Add a note instead.');
      const { rows } = await db.query('SELECT form FROM request_items WHERE id = $1', [r.item_id]);
      const answers = await validateAnswers(db, rows[0].form, input.answers);
      const keys = [...new Set([...Object.keys(answers), ...Object.keys(r.answers)])].filter((k) => answers[k] !== r.answers[k]);
      if (keys.length) {
        await db.query('UPDATE requests SET answers = $2 WHERE id = $1', [r.id, JSON.stringify(answers)]);
        changed.push('answers');
        // Which fields changed, never their values: the history must not copy answers out of their masking.
        data.answers = { changed: keys };
      }
    }
    if (!changed.length) return;
    await logRequest(db, r.id, user.id, 'update', `Updated ${changed.join(', ')}`, data);
    if (data.priority) await recomputeSla(db, r.id, { reason: 'Priority changed' }, 'request');
  });
}

export async function updateRequest(...args: Parameters<typeof updateRequestLean>) {
  await updateRequestLean(...args);
  return getRequest(args[0], args[1]);
}

/** The approver approves or rejects: only a person, never by token or MCP, and never the requester. */
export async function decideRequest(user: User, ref: string, input: z.infer<typeof decisionSchema>) {
  authorize(user, 'request.read');
  if (!byPerson()) throw forbidden('Approvals are decided by a person in the web UI or from their approval link');
  if (input.decision === 'reject' && !input.comment) throw badRequest('Give a reason for rejecting it, so the requester knows why');
  await tx(async (db) => {
    const r = await loadRequest(db, ref);
    if (r.status !== 'awaiting_approval') throw conflict(`${r.ref} is not waiting for approval`);
    if (!r.approver_ids.includes(user.id)) throw forbidden(`You are not an approver of ${r.ref}`);
    const { rows: me } = await db.query('SELECT 1 FROM people WHERE id = $1 AND user_id = $2', [r.requester_id, user.id]);
    if (me[0]) throw forbidden('You cannot approve your own request');
    const to: Status = input.decision === 'approve' ? 'in_fulfilment' : 'rejected';
    await db.query(
      `UPDATE requests SET decided_by = $2, decided_at = now(), responded_at = coalesce(responded_at, now()),
         reject_reason = CASE WHEN $3 THEN $4 ELSE reject_reason END, status = CASE WHEN $3 THEN 'rejected' ELSE status END,
         resolved_at = CASE WHEN $3 THEN now() ELSE resolved_at END WHERE id = $1`,
      [r.id, user.id, to === 'rejected', input.comment],
    );
    await logRequest(db, r.id, user.id, 'approval', to === 'rejected' ? `Rejected: ${input.comment}` : `Approved${input.comment ? `: ${input.comment}` : ''}`, {
      status: { from: r.status, to }, decision: input.decision, ...(input.comment ? { comment: input.comment } : {}),
    });
    // The other approvers' links stop working (approval-links.ts revokes per request on use; this covers the web UI).
    await db.query('UPDATE approval_links SET revoked_at = now() WHERE request_id = $1 AND used_at IS NULL AND revoked_at IS NULL', [r.id]);
    if (to === 'in_fulfilment') {
      await slaOnTransition(db, r.id, 'in_fulfilment', new Date(), 'request');
      await startFulfilment(db, r, user.id);
    } else {
      await slaOnTransition(db, r.id, 'rejected', new Date(), 'request');
    }
    await notify(db, {
      users: [r.created_by], event: 'decision', ref: r.ref, title: `${r.ref} ${to === 'rejected' ? 'rejected' : 'approved'}`, summary: r.title,
      path: `/requests/${r.ref}`, dedupe: `request-decision:${r.ref}`, actorId: user.id,
    });
  });
  return getRequest(user, ref);
}

export async function transitionRequestLean(user: User, ref: string, input: z.infer<typeof transitionRequestSchema>): Promise<void> {
  authorize(user, 'request.write');
  if (input.to !== 'cancelled') {
    await decideRequest(user, ref, { decision: input.to === 'approved' ? 'approve' : 'reject', comment: input.reason ?? '' });
    return;
  }
  // No blind overwrites of masked text (#61, #156).
  await assertMayWriteText(user, ref, { cancel_reason: input.reason });
  if (!input.reason) throw badRequest('Give a reason for cancelling it');
  await tx(async (db) => {
    const r = await loadRequest(db, ref);
    if (DONE.includes(r.status)) throw conflict(`${r.ref} is already ${r.status}`);
    await db.query("UPDATE requests SET status = 'cancelled', cancel_reason = $2, resolved_at = now() WHERE id = $1", [r.id, input.reason]);
    await db.query("UPDATE request_tasks SET status = 'cancelled' WHERE request_id = $1 AND status IN ('open', 'pending')", [r.id]);
    await db.query('UPDATE approval_links SET revoked_at = now() WHERE request_id = $1 AND used_at IS NULL AND revoked_at IS NULL', [r.id]);
    await slaOnTransition(db, r.id, 'cancelled', new Date(), 'request');
    await logRequest(db, r.id, user.id, 'status', `Cancelled: ${input.reason}`, { status: { from: r.status, to: 'cancelled' }, reason: input.reason });
  });
}

export async function transitionRequest(...args: Parameters<typeof transitionRequestLean>) {
  await transitionRequestLean(...args);
  return getRequest(args[0], args[1]);
}

async function loadTask(db: Db, requestId: number, taskId: number) {
  const { rows } = await db.query('SELECT * FROM request_tasks WHERE id = $1 AND request_id = $2 FOR UPDATE', [taskId, requestId]);
  if (!rows[0]) throw notFound('Task not found');
  return rows[0];
}

/** A task's team does it: its members, its assignee, or a manager. */
async function assertMayWorkTask(db: Db, user: User, t: { team_id: number | null; assignee_id: number | null }) {
  if (!t.team_id || t.assignee_id === user.id || can(user.role, 'request.manage')) return;
  const { rows } = await db.query('SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2', [t.team_id, user.id]);
  if (!rows[0]) throw forbidden('This task belongs to another team');
}

/** Marks the open task done; the next one opens, and after the last the request is fulfilled. */
export async function completeRequestTask(user: User, ref: string, taskId: number, input: z.infer<typeof completeTaskSchema>) {
  authorize(user, 'request.write');
  await tx(async (db) => {
    const r = await loadRequest(db, ref);
    const t = await loadTask(db, r.id, taskId);
    if (r.status !== 'in_fulfilment') throw conflict(`${r.ref} is ${r.status.replace('_', ' ')}`);
    if (t.status !== 'open') throw conflict(t.status === 'pending' ? 'Tasks are done in order: this one is not open yet' : `This task is already ${t.status}`);
    await assertMayWorkTask(db, user, t);
    await db.query("UPDATE request_tasks SET status = 'done', note = $2, done_by = $3, done_at = now() WHERE id = $1", [t.id, input.note, user.id]);
    await db.query('UPDATE requests SET responded_at = coalesce(responded_at, now()) WHERE id = $1', [r.id]);
    await logRequest(db, r.id, user.id, 'task', `Done: ${t.title}${input.note ? ` (${input.note})` : ''}`, { task: t.id, status: { from: 'open', to: 'done' }, ...(input.note ? { note: input.note } : {}) });
    const { rows: next } = await db.query("SELECT id FROM request_tasks WHERE request_id = $1 AND status = 'pending' ORDER BY position LIMIT 1", [r.id]);
    if (next[0]) {
      await db.query("UPDATE request_tasks SET status = 'open', opened_at = now() WHERE id = $1", [next[0].id]);
      await openedTask(db, r, user.id);
      return;
    }
    await db.query("UPDATE requests SET status = 'fulfilled', resolved_at = now() WHERE id = $1", [r.id]);
    await slaOnTransition(db, r.id, 'fulfilled', new Date(), 'request');
    await logRequest(db, r.id, null, 'status', 'Fulfilled', { status: { from: 'in_fulfilment', to: 'fulfilled' } });
    await notify(db, {
      users: [r.created_by], event: 'watched_update', ref: r.ref, title: `${r.ref} fulfilled`, summary: r.title, path: `/requests/${r.ref}`, dedupe: `request-fulfilled:${r.ref}`, actorId: user.id,
    });
  });
  return getRequest(user, ref);
}

/** Takes a task (or gives it to a member of its team). */
export async function assignRequestTask(user: User, ref: string, taskId: number, input: z.infer<typeof assignTaskSchema>) {
  authorize(user, 'request.write');
  await tx(async (db) => {
    const r = await loadRequest(db, ref);
    const t = await loadTask(db, r.id, taskId);
    if (t.status === 'done' || t.status === 'cancelled') throw conflict(`This task is ${t.status}`);
    await assertMayWorkTask(db, user, t);
    if (input.assignee_id !== null) {
      const { rows } = await db.query("SELECT display_name FROM users WHERE id = $1 AND active AND role NOT IN ('viewer', 'integration')", [input.assignee_id]);
      if (!rows[0]) throw badRequest('The assignee must be an active user who can work on requests');
      await checkAssigneeInTeam(db, t.team_id, input.assignee_id);
    }
    if (input.assignee_id === t.assignee_id) return;
    await db.query('UPDATE request_tasks SET assignee_id = $2 WHERE id = $1', [t.id, input.assignee_id]);
    if (input.assignee_id !== null) await db.query('UPDATE requests SET responded_at = coalesce(responded_at, now()) WHERE id = $1', [r.id]);
    await logRequest(db, r.id, user.id, 'task', input.assignee_id === null ? `Unassigned: ${t.title}` : `Assigned: ${t.title}`, { task: t.id, assignee_id: { from: t.assignee_id, to: input.assignee_id } });
    if (input.assignee_id && input.assignee_id !== user.id) {
      await notify(db, { users: [input.assignee_id], event: 'assigned', ref: r.ref, title: r.title, summary: t.title, path: `/requests/${r.ref}`, dedupe: `request-task:${t.id}:${input.assignee_id}`, actorId: user.id });
    }
  });
  return getRequest(user, ref);
}

export async function addRequestComment(user: User, ref: string, body: string) {
  authorize(user, 'request.write');
  if (!body.trim()) throw badRequest('Comment cannot be empty');
  await tx(async (db) => {
    const r = await loadRequest(db, ref);
    await logRequest(db, r.id, user.id, 'comment', body.trim());
  });
  return getRequest(user, ref);
}

export const requestLinkSchema = z.object({
  kind: z.enum(REQUEST_LINK_KINDS),
  reference: z.string().trim().min(1).max(200),
  system: z.string().trim().max(100).default(''),
  url: z.string().trim().max(2000).refine((v) => v === '' || /^https?:\/\//i.test(v), 'URL must start with http:// or https://').default(''),
  note: z.string().trim().max(2000).default(''),
});

const KIND_OF_PREFIX: Record<string, string> = { PRB: 'problem', CHG: 'change', INC: 'incident' };

export async function addRequestLink(user: User, ref: string, input: z.infer<typeof requestLinkSchema>) {
  authorize(user, 'request.write');
  const kernel = (!input.system || input.system === 'Kernel') && input.kind !== 'document';
  let reference = input.reference;
  if (kernel) {
    reference = reference.toUpperCase();
    await assertVisibleRef(reference);
    if (input.kind === 'ci') {
      if (!(await query('SELECT 1 FROM configuration_items WHERE ref = $1', [reference])).rows[0]) throw notFound(`${reference} not found`);
    } else {
      if (KIND_OF_PREFIX[reference.slice(0, 3)] !== input.kind) throw badRequest(`${reference} is not a ${input.kind}`);
      typeForRef(reference);
    }
  }
  await tx(async (db) => {
    const r = await loadRequest(db, ref);
    const { rowCount } = await db.query(
      'INSERT INTO request_links (request_id, kind, reference, system, url, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING',
      [r.id, input.kind, reference, kernel ? 'Kernel' : input.system, input.url, input.note, user.id],
    );
    if (!rowCount) throw conflict(`${input.kind} ${reference} is already linked`);
    await logRequest(db, r.id, user.id, 'link', `Linked ${input.kind} ${reference}`, { kind: input.kind, reference, system: input.system, action: 'add' });
  });
  return getRequest(user, ref);
}

export async function removeRequestLink(user: User, ref: string, linkId: number) {
  authorize(user, 'request.write');
  await tx(async (db) => {
    const r = await loadRequest(db, ref);
    const { rows } = await db.query('DELETE FROM request_links WHERE id = $1 AND request_id = $2 RETURNING kind, reference', [linkId, r.id]);
    if (!rows[0]) throw notFound('Link not found');
    await logRequest(db, r.id, user.id, 'link', `Unlinked ${rows[0].kind} ${rows[0].reference}`, { ...rows[0], action: 'remove' });
  });
  return getRequest(user, ref);
}

// ---- Approval by link (#48) ------------------------------------------------------------------

/** What an approver is asked to decide, for an approval link: null when there is nothing for them to decide. */
export async function requestForApprover(user: User, requestId: number) {
  const { rows } = await query(`${SELECT} WHERE r.id = $1`, [requestId]);
  const r = rows[0];
  if (!r) return null;
  return {
    ref: r.ref as string,
    title: r.title as string,
    open: r.status === 'awaiting_approval' && r.approver_ids.includes(user.id) && r.requester_user_id !== user.id && can(user.role, 'request.read'),
    // What was asked for: a change to the answers means the approver should look again.
    version: JSON.stringify([r.item_id, r.answers, r.requester_id]),
    facts: [['Item', `${r.item_name} (${r.service_name})`], ['For', r.requester_name], ['Logged by', r.created_by_name ?? '']] as [string, string][],
  };
}

// ---- Bulk, My work, queues -------------------------------------------------------------------

export async function requestRows(ids: string[]) {
  return (await query('SELECT ref AS id, title, status FROM requests WHERE ref = ANY($1)', [ids.map((i) => i.toUpperCase())])).rows;
}

/** My work: open tasks assigned to me, and requests waiting for my approval. */
export async function myRequestWork(userId: number) {
  const [tasks, approvals] = await Promise.all([
    query(
      `SELECT r.ref, r.title, t.id AS task_id, t.title AS task, r.resolution_due_at, r.priority FROM request_tasks t JOIN requests r ON r.id = t.request_id
       WHERE t.status = 'open' AND t.assignee_id = $1 ORDER BY r.resolution_due_at NULLS LAST, r.created_at LIMIT 30`,
      [userId],
    ),
    query("SELECT ref, title, created_at FROM requests WHERE status = 'awaiting_approval' AND $1 = ANY(approver_ids) ORDER BY created_at LIMIT 30", [userId]),
  ]);
  return { tasks: tasks.rows, approvals: approvals.rows };
}

/** A team's queue: the open request tasks of the team, unassigned first. */
export async function teamRequestTasks(teamIds: number[]) {
  if (!teamIds.length) return [];
  const { rows } = await query(
    `SELECT r.ref, r.title, r.priority, t.id AS task_id, t.title AS task, t.team_id, tm.name AS team, t.assignee_id, u.display_name AS assignee, r.resolution_due_at, t.opened_at,
            (r.resolution_breached_at IS NOT NULL OR (r.sla_paused_since IS NULL AND r.resolution_due_at < now() + interval '2 hours')) AS at_risk
     FROM request_tasks t JOIN requests r ON r.id = t.request_id JOIN teams tm ON tm.id = t.team_id LEFT JOIN users u ON u.id = t.assignee_id
     WHERE t.status = 'open' AND t.team_id = ANY($1) ORDER BY t.assignee_id NULLS FIRST, r.priority, t.opened_at LIMIT 100`,
    [teamIds],
  );
  return rows;
}

/** For the dashboard (#54): requests fulfilled in a period, and how many met their SLA. */
export async function requestsFulfilled(from: Date, to: Date) {
  const { rows } = await query(
    `SELECT count(*)::int AS fulfilled,
            count(*) FILTER (WHERE resolution_due_at IS NOT NULL AND resolution_breached_at IS NULL AND resolved_at <= resolution_due_at)::int AS met,
            count(*) FILTER (WHERE resolution_due_at IS NOT NULL)::int AS with_target
     FROM requests WHERE status = 'fulfilled' AND resolved_at >= $1 AND resolved_at < $2`,
    [from, to],
  );
  return rows[0] as { fulfilled: number; met: number; with_target: number };
}

// ---- Registry (#35) ----------------------------------------------------------------------------

const REQUEST_TYPE: RecordType = {
  type: 'request',
  prefix: 'REQ',
  pattern: /^REQ\d{6}$/,
  readAction: 'request.read',
  uiPath: (ref) => `/requests/${ref}`,
  get: getRequest,
  search: async (user, q, limit) =>
    (await listRequests(user, listRequestsSchema.parse({ q, status: 'all', limit }))).map((r) => ({
      type: 'request', ref: r.ref, title: r.title, status: r.status, url: r.url, summary: [r.item, r.requester].filter(Boolean).join(' · '),
    })),
  rest: {
    list: '/api/requests',
    create: '/api/requests',
    get: '/api/requests/:ref',
    update: '/api/requests/:ref',
    transition: '/api/requests/:ref/transition',
    links: '/api/requests/:ref/links',
    comments: '/api/requests/:ref/comments',
  },
  mcp: { list: 'list_requests', get: 'get_request', create: 'create_request', update: 'update_request', transition: 'transition_request' },
};
registerRecordType(REQUEST_TYPE);

function requestUrl(ref: string) {
  return recordUrl(REQUEST_TYPE, ref);
}
