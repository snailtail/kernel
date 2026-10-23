// Service request management (#44), an optional module: things people ask for ("new account", "access to a system",
// "a new VM") are not incidents and stay out of incident numbers. A catalogue of request items per service, each with
// a short form, an optional approval and an ordered list of fulfilment tasks for teams. A request (REQ000012) is made
// for a person by the user who logs it, may wait for its approver, and is fulfilled when its last task is done. The
// item's SLA runs from submission to fulfilment and pauses while the request waits for approval. Shared by REST, MCP
// and the web UI; agents may log and follow requests, but only a person approves.
import { historyOf, logActivity, touchAndAudit } from './activity.js';
import { randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audienceOf, forRequester, startNarrow } from './audience.js';
import type { User } from './auth.js';
import { audit } from './audit.js';
import { changeConcluded, createChange, createChangeSchema } from './changes.js';
import { assertMayWriteText, textFilterSql } from './confidential.js';
import { asSystem, contextStore, currentContext } from './context.js';
import { type Db, pool, query, tx, USER_COLUMNS } from './db.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from './errors.js';
import { moduleEnabled } from './modules.js';
import { notify, sendOutsideMail } from './notifications.js';
import { rateLimit } from './ratelimit.js';
import { securityEvent } from './security-events.js';
import { unsubscribeUrl } from './status-subscriptions.js';
import { queueReply } from './portal.js';
import { authorize, can } from './policy.js';
import { recordUrl, registerRecordType, typeForRef, typeOfPrefix, type RecordType } from './records.js';
import { recomputeSla, slaClock, slaOnTransition } from './sla.js';
import { checkAssigneeInTeam, requestTasksOf, teamMembers } from './teams.js';
import { assertVisibleRef } from './visibility.js';
import { absoluteUrl } from './core/url.js';
import { tokenHashBytes } from './core/hash.js';
import { processOutbox } from './core/outbox.js';
import { requestTaskPayload } from './webhooks.js';

export const REQUEST_STATUSES = ['submitted', 'awaiting_approval', 'in_fulfilment', 'fulfilled', 'rejected', 'cancelled'] as const;
type Status = (typeof REQUEST_STATUSES)[number];
const DONE: Status[] = ['fulfilled', 'rejected', 'cancelled'];
export const FIELD_TYPES = ['text', 'textarea', 'choice', 'person', 'ci', 'date'] as const;
export const TASK_KINDS = ['manual', 'change', 'webhook'] as const;
/** How long a webhook task's callback token works. */
export const CALLBACK_DAYS = 7;
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
  fulfilment_tasks: z.array(z.object({
    title: z.string().trim().min(1).max(200),
    team_id: z.number().int().nullable().default(null),
    /** manual: a person does it; change: the standard change from the template, its outcome completes it; webhook: an outgoing webhook does it and calls back. */
    kind: z.enum(TASK_KINDS).default('manual'),
    webhook_id: z.number().int().nullable().default(null),
  })).min(1, 'Add at least one fulfilment task').max(20),
  sla_id: z.number().int().nullable().default(null),
  /** The standard change template a "change" task is carried out with. */
  standard_change_template_id: z.number().int().nullable().default(null),
  /** May the user who logs a request also approve it? Off by default (separation of duties). */
  logger_may_approve: z.boolean().default(false),
  active: z.boolean().default(true),
}).superRefine((i, ctx) => {
  const changes = i.fulfilment_tasks.filter((t) => t.kind === 'change').length;
  if (changes > 1) ctx.addIssue({ code: 'custom', path: ['fulfilment_tasks'], message: 'At most one task is the standard change' });
  if (changes && i.standard_change_template_id === null) ctx.addIssue({ code: 'custom', path: ['standard_change_template_id'], message: 'A standard change task needs the template to use' });
  if (!changes && i.standard_change_template_id !== null) ctx.addIssue({ code: 'custom', path: ['fulfilment_tasks'], message: 'Add the task the standard change carries out (kind change), or remove the template' });
  if (i.fulfilment_tasks.some((t) => t.kind === 'webhook' && t.webhook_id === null)) ctx.addIssue({ code: 'custom', path: ['fulfilment_tasks'], message: 'A webhook task needs the webhook to call' });
});
export const listItemsSchema = z.object({ service: z.string().trim().max(30).optional(), inactive: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false) });

const ITEM_SELECT = `
  SELECT i.id, i.name, i.description, i.form, i.approval, i.approval_team_id, i.fulfilment_tasks, i.sla_id, i.standard_change_template_id, i.logger_may_approve, i.active,
         i.created_at, i.updated_at, c.ref AS service_ref, c.name AS service_name, s.name AS sla, t.name AS approval_team, ct.name AS standard_change_template
  FROM request_items i JOIN configuration_items c ON c.id = i.service_id LEFT JOIN slas s ON s.id = i.sla_id LEFT JOIN teams t ON t.id = i.approval_team_id
  LEFT JOIN change_templates ct ON ct.id = i.standard_change_template_id`;

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

/** What the catalogue editor offers for automated tasks: standard change templates and JSON webhooks (names only). */
export async function itemOptions(user: User) {
  authorize(user, 'request.manage');
  const [templates, webhooks] = await Promise.all([
    query('SELECT id, name, max_risk FROM change_templates WHERE active ORDER BY name'),
    query("SELECT id, name FROM webhooks WHERE active AND format = 'json' ORDER BY name"),
  ]);
  return { templates: moduleEnabled('change') ? templates.rows : [], webhooks: webhooks.rows };
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
    if (input.standard_change_template_id !== null && !(await db.query('SELECT 1 FROM change_templates WHERE id = $1 AND active', [input.standard_change_template_id])).rows[0]) throw badRequest('Unknown or inactive standard change template');
    const hooks = [...new Set(input.fulfilment_tasks.map((t) => t.webhook_id).filter((w): w is number => w !== null))];
    // A task's webhook gets JSON with a callback: chat formats (Slack, Teams) cannot answer.
    if (hooks.length && (await db.query("SELECT count(*)::int AS n FROM webhooks WHERE id = ANY($1) AND active AND format = 'json'", [hooks])).rows[0].n !== hooks.length) throw badRequest('Unknown or inactive webhook, or not a JSON webhook');
    // Only what the kind uses is kept: a manual task has no webhook.
    const tasks = input.fulfilment_tasks.map((t) => ({ title: t.title, team_id: t.team_id, kind: t.kind, webhook_id: t.kind === 'webhook' ? t.webhook_id : null }));
    const values = [svc[0].id, input.name, input.description, JSON.stringify(input.form), approval, team ? Number(team) : null, JSON.stringify(tasks), input.sla_id, input.standard_change_template_id, input.active, input.logger_may_approve];
    const before = id ? (await db.query('SELECT * FROM request_items WHERE id = $1 FOR UPDATE', [id])).rows[0] : null;
    if (id && !before) throw notFound('Request item not found');
    try {
      const { rows } = id
        ? await db.query(
            `UPDATE request_items SET service_id = $2, name = $3, description = $4, form = $5, approval = $6, approval_team_id = $7, fulfilment_tasks = $8,
               sla_id = $9, standard_change_template_id = $10, active = $11, logger_may_approve = $12, updated_at = now() WHERE id = $1 RETURNING id`,
            [id, ...values],
          )
        : await db.query(
            `INSERT INTO request_items (service_id, name, description, form, approval, approval_team_id, fulfilment_tasks, sla_id, standard_change_template_id, active, logger_may_approve, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
            [...values, user.id],
          );
      // The catalogue's history is the audit trail: what each version of the item asked and who changed it.
      await audit(db, { entity_type: 'request_item', entity_ref: `#${rows[0].id}`, action: id ? 'update' : 'create', changes: { ...input, ...(before ? { before: { name: before.name, form: before.form, approval: before.approval, fulfilment_tasks: before.fulfilment_tasks, logger_may_approve: before.logger_may_approve, active: before.active } } : {}) } });
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

/** Who may approve requests for this item right now: the requester's manager, the service owner, or the team's members. */
async function currentApprovers(db: Db, item: { approval: string; service_id: number; approval_team_id: number | null }, requester: { id: number; name: string }) {
  if (item.approval === 'requester_manager') {
    const { rows } = await db.query(
      `SELECT m.name, u.id FROM people p JOIN people m ON m.id = p.manager_id AND m.erased_at IS NULL LEFT JOIN users u ON u.id = m.user_id AND u.active WHERE p.id = $1`,
      [requester.id],
    );
    if (!rows[0]) return { ids: [] as number[], who: '', noManager: true };
    return { ids: rows[0].id ? [rows[0].id as number] : [], who: `${rows[0].name}, ${requester.name}'s manager,`, noManager: false };
  }
  if (item.approval === 'service_owner') {
    const { rows } = await db.query('SELECT u.id, c.name FROM configuration_items c LEFT JOIN users u ON u.id = c.owner_id AND u.active WHERE c.id = $1', [item.service_id]);
    return { ids: rows[0]?.id ? [rows[0].id as number] : [], who: `the owner of ${rows[0]?.name ?? 'the service'}`, noManager: false };
  }
  if (item.approval === 'team' && item.approval_team_id) return { ids: await teamMembers(db, item.approval_team_id), who: 'no one in the approving team', noManager: false };
  return { ids: [] as number[], who: '', noManager: false };
}

/**
 * The approvers of a new request, resolved when it is submitted and stored with it. The requester never approves
 * their own request, and unless the item allows it, neither does the user who logged it (separation of duties).
 */
async function resolveApprovers(db: Db, item: any, requester: { id: number; user_id: number | null; name: string }, loggerId: number) {
  if (item.approval === 'none') return [];
  const found = await currentApprovers(db, item, requester);
  if (found.noManager) throw badRequest(`${requester.name} has no manager in Kernel, and this request needs their manager's approval. Add the manager to the contact first.`);
  const ids = found.ids.filter((id) => id !== requester.user_id && (item.logger_may_approve || id !== loggerId));
  if (!ids.length) {
    const logger = found.ids.includes(loggerId) && loggerId !== requester.user_id && !item.logger_may_approve;
    throw badRequest(logger
      ? `This request needs approval, and you are its only approver: someone else must log it, or a manager allows "the person who logs it may approve" on the catalogue item.`
      : `This request needs approval, but ${found.who} cannot approve it (no Kernel account, or it is the requester). Ask an administrator to fix the catalogue item.`);
  }
  return ids;
}

/** At the decision, the approver must still be one (review of #44): still the manager, the service owner, in the team. */
async function stillApprover(db: Db, r: { item_id: number; requester_id: number; approver_ids: number[] }, userId: number) {
  if (!r.approver_ids.includes(userId)) return false;
  const { rows } = await db.query('SELECT i.approval, i.service_id, i.approval_team_id, p.name FROM request_items i, people p WHERE i.id = $1 AND p.id = $2', [r.item_id, r.requester_id]);
  if (!rows[0]) return false;
  return (await currentApprovers(db, rows[0], { id: r.requester_id, name: rows[0].name })).ids.includes(userId);
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
    historyOf('request', r.id),
    query(
      `SELECT t.id, t.position, t.title, t.status, t.note, t.team_id, tm.name AS team, t.assignee_id, a.display_name AS assignee, t.opened_at, t.done_at, d.display_name AS done_by,
              t.kind, ch.ref AS change_ref, ch.status AS change_status, ch.outcome AS change_outcome, w.name AS webhook, t.callback_used_at IS NOT NULL AS called_back
       FROM request_tasks t LEFT JOIN teams tm ON tm.id = t.team_id LEFT JOIN users a ON a.id = t.assignee_id LEFT JOIN users d ON d.id = t.done_by
       LEFT JOIN changes ch ON ch.id = t.change_id LEFT JOIN webhooks w ON w.id = t.webhook_id
       WHERE t.request_id = $1 ORDER BY t.position`,
      [r.id],
    ),
    query('SELECT id, kind, reference, system, url, note, created_at FROM request_links WHERE request_id = $1 ORDER BY kind, created_at', [r.id]),
    r.approver_ids.length ? query('SELECT id, display_name FROM users WHERE id = ANY($1) ORDER BY display_name', [r.approver_ids]) : { rows: [] as any[] },
    slaClock(pool, r),
  ]);
  const myTeams = (await query('SELECT team_id FROM team_members WHERE user_id = $1', [user.id])).rows.map((t) => t.team_id as number);
  const mayWork = can(user.role, 'request.write');
  const mayDecide = r.status === 'awaiting_approval' && r.approver_ids.includes(user.id) && byPerson() && (await stillApprover(pool, r, user.id));
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
    tasks: tasks.rows.map(({ change_status, change_outcome, ...t }) => ({
      ...t,
      // A standard change completes its task; by hand only when it was cancelled or did not work.
      by_change: t.kind === 'change' && !!t.change_ref && change_status !== 'cancelled' && !['failed', 'rolled_back'].includes(change_outcome),
      may_complete: t.status === 'open' && mayWork && !(t.kind === 'change' && t.change_ref && change_status !== 'cancelled' && !['failed', 'rolled_back'].includes(change_outcome)) && (!t.team_id || t.assignee_id === user.id || myTeams.includes(t.team_id) || can(user.role, 'request.manage')),
    })),
    sla,
    links: links.rows,
    activity,
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

export const logRequest = (db: Db, id: number, userId: number | null, kind: string, body = '', data: object = {}) => logActivity(db, 'request', id, userId, kind, body, data);

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
export const requestCommentSchema = z.object({ body: z.string().max(20000), to_requester: z.boolean().default(false) });
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
  const tasks = rows[0].fulfilment_tasks as { title: string; team_id: number | null; kind?: string; webhook_id?: number | null }[];
  for (const [n, t] of tasks.entries()) {
    await db.query(
      'INSERT INTO request_tasks (request_id, position, title, team_id, status, opened_at, kind, webhook_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [r.id, n + 1, t.title, t.team_id, n === 0 ? 'open' : 'pending', n === 0 ? new Date() : null, t.kind ?? 'manual', t.webhook_id ?? null],
    );
  }
  await db.query("UPDATE requests SET status = 'in_fulfilment' WHERE id = $1", [r.id]);
  await openedTask(db, r, actorId);
}

/**
 * The open task lands in its team's queue: the members hear about it. A webhook task is sent to its webhook (the
 * callback token is minted when the delivery is sent); a standard change task is carried out after the commit
 * (runAutomation).
 */
async function openedTask(db: Db, r: { id: number; ref: string; title: string }, actorId: number | null) {
  const { rows } = await db.query("SELECT t.id, t.title, t.team_id, t.kind, t.webhook_id, tm.name AS team FROM request_tasks t LEFT JOIN teams tm ON tm.id = t.team_id WHERE t.request_id = $1 AND t.status = 'open' ORDER BY t.position LIMIT 1", [r.id]);
  const t = rows[0];
  if (t?.kind === 'webhook' && t.webhook_id) await queueTaskWebhook(db, r.id, t);
  if (!t?.team_id) return;
  await notify(db, {
    users: await teamMembers(db, t.team_id), event: 'team_queue', ref: r.ref, title: r.title, summary: `${t.title}: new in the ${t.team} queue.`,
    path: `/requests/${r.ref}`, dedupe: `team_queue:${r.ref}:task:${t.id}`, actorId,
  });
}

export async function createRequest(user: User, input: z.infer<typeof createRequestSchema>) {
  authorize(user, 'request.write');
  const ref = await tx(async (db) => {
    const requester = await findRequester(db, user, input.requester);
    return submitRequest(db, input.item_id, requester, input.answers, { title: input.title, priority: input.priority, loggerId: user.id });
  });
  await runAutomation(ref, user);
  return getRequest(user, ref);
}

/**
 * A request submitted: the item's form checked by validateAnswers, approvers resolved, then approval or fulfilment.
 * Kernel's own form logs it as a user (loggerId); the portal (#45) as the requester themselves (loggerId null).
 */
export async function submitRequest(
  db: Db,
  itemId: number,
  requester: { id: number; name: string; user_id: number | null },
  rawAnswers: Record<string, unknown>,
  opts: { title?: string; priority?: number; loggerId: number | null },
) {
  const { rows: items } = await db.query('SELECT * FROM request_items WHERE id = $1 AND active', [itemId]);
  const item = items[0];
  if (!item) throw notFound('Request item not found');
  const answers = await validateAnswers(db, item.form, rawAnswers);
  // No user id is 0: from the portal nobody is a logger who could also approve.
  const approvers = await resolveApprovers(db, item, requester, opts.loggerId ?? 0);
  const { rows } = await db.query(
    `INSERT INTO requests (item_id, title, requester_id, answers, priority, approval, approver_ids, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, ref, title, item_id`,
    [item.id, opts.title ?? `${item.name} for ${requester.name}`, requester.id, JSON.stringify(answers), opts.priority ?? 3, item.approval, approvers, opts.loggerId],
  );
  const r = rows[0];
  const how = opts.loggerId === null ? 'Submitted in the portal' : requester.user_id === opts.loggerId ? 'Submitted' : `Submitted for ${requester.name}`;
  await logRequest(db, r.id, opts.loggerId, 'created', how, { item: item.name, requester: requester.id, ...(opts.loggerId === null ? { via: 'portal' } : {}) });
  await recomputeSla(db, r.id, { reselect: true }, 'request');
  if (approvers.length) {
    await db.query("UPDATE requests SET status = 'awaiting_approval' WHERE id = $1", [r.id]);
    await slaOnTransition(db, r.id, 'awaiting_approval', new Date(), 'request');
    await logRequest(db, r.id, null, 'status', 'Waiting for approval', { status: { from: 'submitted', to: 'awaiting_approval' } });
    await notify(db, {
      users: approvers, event: 'approval_needed', ref: r.ref, title: r.title, summary: `${requester.name} asks for ${item.name}. It waits for your approval.`,
      path: `/requests/${r.ref}`, dedupe: `request-approval:${r.ref}`, actorId: opts.loggerId,
    });
  } else {
    await startFulfilment(db, r, opts.loggerId);
    await logRequest(db, r.id, null, 'status', 'In fulfilment', { status: { from: 'submitted', to: 'in_fulfilment' } });
  }
  await tellRequester(db, r.id, 'received', opts.loggerId);
  return r.ref as string;
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
    // The approvers were resolved at submission: someone who has since left the team, or is no longer the manager or
    // the service owner, no longer decides.
    if (!(await stillApprover(db, r, user.id))) throw forbidden(`You are no longer an approver of ${r.ref}: the approving manager, owner or team has changed`);
    const to: Status = input.decision === 'approve' ? 'in_fulfilment' : 'rejected';
    // Allowed by the item, but shown: the history and the audit say when one person logged and approved it.
    const samePerson = r.created_by === user.id;
    await db.query(
      `UPDATE requests SET decided_by = $2, decided_at = now(), responded_at = coalesce(responded_at, now()),
         reject_reason = CASE WHEN $3 THEN $4 ELSE reject_reason END, status = CASE WHEN $3 THEN 'rejected' ELSE status END,
         resolved_at = CASE WHEN $3 THEN now() ELSE resolved_at END WHERE id = $1`,
      [r.id, user.id, to === 'rejected', input.comment],
    );
    await logRequest(db, r.id, user.id, 'approval', `${to === 'rejected' ? `Rejected: ${input.comment}` : `Approved${input.comment ? `: ${input.comment}` : ''}`}${samePerson ? ' (logged and decided by the same person)' : ''}`, {
      status: { from: r.status, to }, decision: input.decision, ...(input.comment ? { comment: input.comment } : {}), ...(samePerson ? { same_person: true } : {}),
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
    await tellRequester(db, r.id, to === 'rejected' ? 'rejected' : 'approved', user.id);
  });
  await runAutomation(ref, user);
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
    await tellRequester(db, r.id, 'cancelled', user.id);
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
    // The change's outcome completes its task; by hand only when no change could be made.
    if (t.kind === 'change' && t.change_id) {
      // Unless the change was cancelled or did not work: then the team decides how to finish.
      const { rows: c } = await db.query('SELECT ref, status, outcome FROM changes WHERE id = $1', [t.change_id]);
      if (c[0] && c[0].status !== 'cancelled' && !['failed', 'rolled_back'].includes(c[0].outcome)) throw conflict(`Record the outcome on ${c[0].ref}: it completes this task`);
    }
    await finishTask(db, r, t, user.id, input.note);
  });
  await runAutomation(ref, user);
  return getRequest(user, ref);
}

/** The open task is done (by a person, its change or its webhook): the next opens, or the request is fulfilled. */
async function finishTask(db: Db, r: any, t: { id: number; title: string }, doneBy: number | null, note: string) {
  await db.query("UPDATE request_tasks SET status = 'done', note = $2, done_by = $3, done_at = now() WHERE id = $1", [t.id, note, doneBy]);
  await db.query('UPDATE requests SET responded_at = coalesce(responded_at, now()) WHERE id = $1', [r.id]);
  await logRequest(db, r.id, doneBy, 'task', `Done: ${t.title}${note ? ` (${note})` : ''}`, { task: t.id, status: { from: 'open', to: 'done' }, ...(note ? { note } : {}) });
  const { rows: next } = await db.query("SELECT id FROM request_tasks WHERE request_id = $1 AND status = 'pending' ORDER BY position LIMIT 1", [r.id]);
  if (next[0]) {
    await db.query("UPDATE request_tasks SET status = 'open', opened_at = now() WHERE id = $1", [next[0].id]);
    await openedTask(db, r, doneBy);
    return;
  }
  await db.query("UPDATE requests SET status = 'fulfilled', resolved_at = now() WHERE id = $1", [r.id]);
  await slaOnTransition(db, r.id, 'fulfilled', new Date(), 'request');
  await logRequest(db, r.id, null, 'status', 'Fulfilled', { status: { from: 'in_fulfilment', to: 'fulfilled' } });
  await notify(db, {
    users: [r.created_by], event: 'watched_update', ref: r.ref, title: `${r.ref} fulfilled`, summary: r.title, path: `/requests/${r.ref}`, dedupe: `request-fulfilled:${r.ref}`, actorId: doneBy,
  });
  await tellRequester(db, r.id, 'fulfilled', doneBy);
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

/** A work note, or with toRequester a reply to the requester (#45): shown in the portal and mailed to them. */
export async function addRequestComment(user: User, ref: string, body: string, toRequester = false) {
  authorize(user, 'request.write');
  if (!body.trim()) throw badRequest('Comment cannot be empty');
  await tx(async (db) => {
    const r = await loadRequest(db, ref);
    await logRequest(db, r.id, user.id, 'comment', body.trim(), toRequester ? { for_requester: true } : {});
    if (toRequester) await queueReply(db, 'request', r.id);
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
      if (typeOfPrefix(reference) !== input.kind) throw badRequest(`${reference} is not a ${input.kind}`);
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

// ---- Automation (part 2 of #44): the standard change and webhook tasks ---------------------------

/**
 * After a commit that may have opened a task: a standard change task makes its change from the item's template, as
 * narrow as the request (#117), on the CIs the form names (else the service). Done as the acting person when they may
 * create changes, else as the user who logged the request. If the change cannot be made (the module is off, the
 * template's scope refuses it, a change freeze), the history says why and the team does the task by hand.
 */
export async function runAutomation(ref: string, actor?: User) {
  const { rows } = await query(
    `SELECT t.id, t.title, t.team_id, r.id AS request_id, r.ref, r.created_by, r.answers, i.form, i.name AS item, i.standard_change_template_id, c.ref AS service_ref
     FROM request_tasks t JOIN requests r ON r.id = t.request_id JOIN request_items i ON i.id = r.item_id JOIN configuration_items c ON c.id = i.service_id
     WHERE r.ref = $1 AND t.status = 'open' AND t.kind = 'change' AND t.change_id IS NULL AND r.status = 'in_fulfilment'`,
    [ref.toUpperCase()],
  );
  const t = rows[0];
  if (!t) return;
  const log = (body: string, data: object) => tx((db) => logRequest(db, t.request_id, null, 'task', body, data));
  try {
    if (!moduleEnabled('change')) throw badRequest('Changes are turned off');
    if (!t.standard_change_template_id) throw badRequest('The catalogue item no longer names a standard change template');
    const { rows: u } = await query(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1 AND u.active`, [t.created_by]);
    const by: User | undefined = actor && can(actor.role, 'change.create') ? actor : u[0];
    if (!by) throw badRequest('Nobody can make the change: the user who logged the request is gone');
    const cis = (t.form as FormField[]).filter((f) => f.type === 'ci' && t.answers[f.key]).map((f) => String(t.answers[f.key]));
    const change = await createChange(by, createChangeSchema.parse({
      title: `${t.item}: ${t.title} (${t.ref})`, description: `Carries out service request ${t.ref}.`, template_id: t.standard_change_template_id,
      cis: cis.length ? cis : [t.service_ref], ...(t.team_id ? { team_id: t.team_id } : {}),
    }), undefined, startNarrow(await audienceOf(null, t.ref)));
    await tx(async (db) => {
      const { rowCount } = await db.query('UPDATE request_tasks SET change_id = $2 WHERE id = $1 AND change_id IS NULL', [t.id, change.id]);
      if (!rowCount) return;
      await db.query("INSERT INTO request_links (request_id, kind, reference, system, created_by) VALUES ($1, 'change', $2, 'Kernel', $3) ON CONFLICT DO NOTHING", [t.request_id, change.ref, by.id]);
      await logRequest(db, t.request_id, null, 'task', `Standard change ${change.ref} made for: ${t.title}. Its outcome completes the task.`, { task: t.id, change: change.ref });
    });
  } catch (err) {
    if (!(err instanceof HttpError) || err.statusCode >= 500) throw err;
    await log(`The standard change could not be made (${err.message}). Do this task by hand.`, { task: t.id, change_error: err.message });
  }
}

/** A change's outcome completes the request task it carries out; a failed or rolled back change leaves it open. */
changeConcluded.on(changeOutcome);
export async function changeOutcome(changeRef: string) {
  const refs = await asSystem(() => tx(async (db) => {
    const { rows } = await db.query(
      `SELECT t.id AS task_id, t.title AS task_title, t.team_id AS task_team_id, c.ref AS change_ref, c.status AS change_status, c.outcome, r.*
       FROM request_tasks t JOIN changes c ON c.id = t.change_id JOIN requests r ON r.id = t.request_id
       WHERE c.ref = $1 AND t.status = 'open' AND t.kind = 'change' FOR UPDATE OF t, r`,
      [changeRef.toUpperCase()],
    );
    for (const r of rows) {
      const t = { id: r.task_id as number, title: r.task_title as string };
      if (r.outcome === 'successful') await finishTask(db, r, t, null, `${r.change_ref} successful`);
      else {
        const what = r.change_status === 'cancelled' ? 'was cancelled' : `was ${String(r.outcome ?? r.change_status).replace('_', ' ')}`;
        await logRequest(db, r.id, null, 'task', `${r.change_ref} ${what}: "${t.title}" stays open. Raise a new change, or do it by hand.`, { task: t.id, change: r.change_ref, outcome: r.outcome });
        if (r.task_team_id) await notify(db, { users: await teamMembers(db, r.task_team_id), event: 'team_queue', ref: r.ref, title: r.title, summary: `${r.change_ref} ${what}: ${t.title} needs you.`, path: `/requests/${r.ref}`, dedupe: `request-change:${t.id}:${r.change_ref}:${r.outcome ?? r.change_status}` });
      }
    }
    return rows.map((x) => x.ref as string);
  }));
  for (const ref of new Set(refs)) await asSystem(() => runAutomation(ref));
}

/**
 * A webhook task is queued for its webhook with the request's ref, item and answers: never comments or task notes,
 * no free-text answers from a confidential request, and only the ref of a restricted one. The callback token is added
 * when the delivery is sent (withCallback), so the queue never holds it.
 */
async function queueTaskWebhook(db: Db, requestId: number, t: { id: number; title: string; webhook_id: number }) {
  const { rows } = await db.query(
    `SELECT r.ref, r.title, r.status, r.answers, r.restricted, r.classification, i.name AS item, i.form, c.ref AS service_ref, c.name AS service_name, t.position
     FROM requests r JOIN request_items i ON i.id = r.item_id JOIN configuration_items c ON c.id = i.service_id JOIN request_tasks t ON t.id = $2 WHERE r.id = $1`,
    [requestId, t.id],
  );
  const r = rows[0];
  const answers = r.restricted ? {} : Object.fromEntries((r.form as FormField[]).filter((f) => r.answers[f.key] !== undefined && !(FREE_TEXT.has(f.type) && r.classification === 'confidential')).map((f) => [f.key, r.answers[f.key]]));
  const payload = {
    event: 'request.task', occurred_at: new Date().toISOString(),
    request: r.restricted ? { ref: r.ref, restricted: true, url: requestUrl(r.ref) } : { ref: r.ref, title: r.title, item: r.item, service: { ref: r.service_ref, name: r.service_name }, url: requestUrl(r.ref) },
    task: { id: t.id, title: t.title, position: r.position },
    answers,
    problem: null, actor: null, summary: `Task: ${t.title}`, data: { request_task_id: t.id },
  };
  await db.query("INSERT INTO webhook_deliveries (webhook_id, event, payload) VALUES ($1, 'request.task', $2)", [t.webhook_id, JSON.stringify(payload)]);
  await logRequest(db, requestId, null, 'task', `Sent to its webhook: ${t.title}`, { task: t.id, webhook: t.webhook_id });
}


/**
 * Called by the webhook worker as it sends a request.task delivery: mints the task's callback token (256 random bits,
 * only the SHA-256 kept, single use, expires) and adds where to call back. A retry mints a new one, so the token in a
 * failed attempt stops working. Null when the task is no longer open: nothing is sent.
 */
requestTaskPayload.provide(withCallback);
export async function withCallback(payload: any) {
  const token = randomBytes(32).toString('base64url');
  const { rows } = await query(
    `UPDATE request_tasks SET callback_hash = $2, callback_expires_at = now() + $3 * interval '1 day', callback_used_at = NULL
     WHERE id = $1 AND status = 'open' AND kind = 'webhook' RETURNING callback_expires_at`,
    [payload?.task?.id, tokenHashBytes(token), CALLBACK_DAYS],
  );
  if (!rows[0]) return null;
  return {
    ...payload,
    callback: {
      url: absoluteUrl(`/api/requests/${payload.request.ref}/tasks/${payload.task.id}/complete`), method: 'POST', header: 'X-Kernel-Task-Token', token,
      expires_at: new Date(rows[0].callback_expires_at).toISOString(), body: '{ "status": "done" | "failed", "note": "…" }',
    },
  };
}

export const callbackSchema = z.object({ status: z.enum(['done', 'failed']).default('done'), note: z.string().trim().max(2000).default('') });

/** The webhook's receiver reports back with the task's token: done completes the task, failed hands it to the team. */
export async function completeTaskByToken(req: FastifyRequest, ref: string, taskId: number, token: string, input: z.infer<typeof callbackSchema>) {
  rateLimit(`task-callback:ip:${req.ip}`, 60, 60_000);
  const refuse = (reason: string) => {
    securityEvent({ action: 'request_task.callback_refused', category: 'authentication', outcome: 'denied', message: `Task callback refused: ${reason}`, detail: { reason, task_id: taskId } }, req);
    return new HttpError(403, 'This callback token is not valid for that task, or it was used or has expired');
  };
  if (!token || token.length > 100) throw refuse('missing');
  const ctx = { userId: null, userName: 'webhook', actorType: 'system' as const, channel: 'webhook', tokenPrefix: '', ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300), requestId: String(req.id), viewer: 'system' };
  await contextStore.run(ctx, () => tx(async (db) => {
    const { rows } = await db.query(
      `SELECT t.*, t.callback_expires_at < now() AS expired, r.ref AS request_ref FROM request_tasks t JOIN requests r ON r.id = t.request_id
       WHERE t.id = $1 AND r.ref = $2 AND t.callback_hash = $3 FOR UPDATE OF t`,
      [taskId, ref.toUpperCase(), tokenHashBytes(token)],
    );
    const t = rows[0];
    if (!t) throw refuse('invalid');
    if (t.callback_used_at) throw refuse('used');
    if (t.expired) throw refuse('expired');
    if (t.status !== 'open') throw refuse('not_open');
    await db.query('UPDATE request_tasks SET callback_used_at = now() WHERE id = $1', [t.id]);
    const r = await loadRequest(db, ref);
    if (input.status === 'done') await finishTask(db, r, t, null, input.note);
    else {
      await logRequest(db, r.id, null, 'task', `The webhook reports it could not do "${t.title}"${input.note ? `: ${input.note}` : ''}. The task stays open for a person.`, { task: t.id, webhook: 'failed', ...(input.note ? { note: input.note } : {}) });
      if (t.team_id) await notify(db, { users: await teamMembers(db, t.team_id), event: 'team_queue', ref: r.ref, title: r.title, summary: `Automation failed: ${t.title} needs a person.`, path: `/requests/${r.ref}`, dedupe: `request-webhook-failed:${t.id}` });
    }
  }));
  await asSystem(() => runAutomation(ref));
  return { ok: true, status: input.status };
}

// ---- The requester hears about it (part 2 of #44) ----------------------------------------------

type Notice = 'received' | 'approved' | 'rejected' | 'fulfilled' | 'cancelled';

/**
 * The requester hears about their request: a person with an account through their notifications (unless they logged
 * it and hear about it already), everyone else by mail through the outbox, unless they unsubscribed.
 */
async function tellRequester(db: Db, requestId: number, kind: Notice, actorId: number | null) {
  const { rows } = await db.query(
    'SELECT r.ref, r.title, r.created_by, p.id AS person_id, p.user_id, p.email, p.request_mail, p.active, p.erased_at FROM requests r JOIN people p ON p.id = r.requester_id WHERE r.id = $1',
    [requestId],
  );
  const p = rows[0];
  if (!p) return;
  if (p.user_id) {
    if (p.user_id === p.created_by || kind === 'received') return;
    await notify(db, {
      users: [p.user_id], event: kind === 'approved' || kind === 'rejected' ? 'decision' : 'watched_update', ref: p.ref, title: `${p.ref} ${kind}`, summary: p.title,
      path: `/requests/${p.ref}`, dedupe: `request-requester:${p.ref}:${kind}`, actorId,
    });
    return;
  }
  if (!p.email || !p.request_mail || !p.active || p.erased_at) return;
  await db.query('INSERT INTO request_mail (request_id, person_id, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [requestId, p.person_id, kind]);
}

/** What the mail says, in plain words: only the request's own title (not for a restricted one) and where it stands. */
function requesterLines(kind: Notice, r: { ref: string; title: string | null; approval: boolean }) {
  const what = r.title ? `"${r.title}" (${r.ref})` : r.ref;
  const lines: Record<Notice, [string, string[]]> = {
    received: ['we have received it', [`We have received your request ${what}.`, r.approval ? 'It needs an approval first. We will tell you when it is approved and when it is done.' : 'We will tell you when it is done.']],
    approved: ['approved', [`Your request ${what} has been approved. We are working on it now.`]],
    rejected: ['not approved', [`Your request ${what} was not approved.`, 'If you have questions, contact your service desk.']],
    fulfilled: ['done', [`Your request ${what} is done.`]],
    cancelled: ['cancelled', [`Your request ${what} has been cancelled.`, 'If you still need it, contact your service desk.']],
  };
  const [subject, body] = lines[kind];
  return { subject: `Your request ${r.ref}: ${subject}`, lines: body };
}

/** Sends due requester mail; claimed with a lease so replicas never send the same one twice. */
export async function processRequestMail(limit = 20) {
  const { sent } = await processOutbox({
    table: 'request_mail', leaseSeconds: 120, limit, permanent: /not configured/,
    retryIn: (attempts) => (attempts >= 5 ? null : 2 ** attempts * 60),
    send: async (m: any) => {
      const { rows: p } = await query("SELECT email FROM people WHERE id = $1 AND request_mail AND active AND erased_at IS NULL AND coalesce(email, '') <> ''", [m.person_id]);
      const r = await forRequester(null, m.request_id);
      if (!p[0] || !r) return 'skipped';
      const { subject, lines } = requesterLines(m.kind, r);
      await sendOutsideMail(p[0].email, subject, lines, unsubscribeUrl('r', m.person_id));
    },
  });
  return sent;
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
    open: r.status === 'awaiting_approval' && r.requester_user_id !== user.id && can(user.role, 'request.read') && (await stillApprover(pool, r, user.id)),
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
requestTasksOf.provide(teamRequestTasks);
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
  table: 'requests',
  activity: { table: 'request_activity', fk: 'request_id', after: async (db, e) => void (await touchAndAudit(db, 'request', e, { rules: true })) },
  module: 'request',
  // A request is worked through its tasks, so their assignees and teams read it.
  people: {
    assignee: null, team: null,
    extra: (a, u) => `EXISTS (SELECT 1 FROM request_tasks t WHERE t.request_id = ${a}.id AND (t.assignee_id = ${u}::int OR EXISTS (SELECT 1 FROM team_members m WHERE m.user_id = ${u}::int AND m.team_id = t.team_id)))`,
  },
  // The portal's replies are request_activity comments (from_requester), so they are cleaned with the rest of it.
  textPlaces: [
    { table: 'requests', key: 'id', columns: ['title', 'reject_reason', 'cancel_reason'], json: ['answers'] },
    { table: 'request_activity', key: 'request_id', columns: ['body'], json: ['data'] },
    { table: 'request_tasks', key: 'request_id', columns: ['title', 'note'] },
    { table: 'request_links', key: 'request_id', columns: ['note', 'url'] },
    { table: 'portal_feedback', key: 'request_id', columns: ['comment'] },
  ],
  liveTopic: 'request',
  comment: addRequestComment,
  update: (user, ref, input) => updateRequestLean(user, ref, input),
};
registerRecordType(REQUEST_TYPE);

function requestUrl(ref: string) {
  return recordUrl(REQUEST_TYPE, ref);
}
