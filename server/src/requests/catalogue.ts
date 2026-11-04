// The service request catalogue (#44): request items per service, their forms and approval rules, how answers are checked and who approves.
import { z } from 'zod';
import type { User } from '../security/auth.js';
import { audit } from '../security/audit.js';
import { type Db, query, tx } from '../core/db.js';
import { badRequest, conflict, notFound } from '../core/errors.js';
import { moduleEnabled } from '../core/modules.js';
import { authorize, can } from '../security/policy.js';
import { teamMembers } from '../people/teams.js';
import { PUBLIC_SERVICE_NAME } from '../status/status.js';

const FIELD_TYPES = ['text', 'textarea', 'choice', 'person', 'ci', 'date'] as const;
const TASK_KINDS = ['manual', 'change', 'webhook'] as const;
export const FREE_TEXT = new Set(['text', 'textarea']);

// ---- The catalogue ---------------------------------------------------------------------------

const formFieldSchema = z.object({
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
export async function answersOut(form: FormField[], answers: Record<string, string | number>) {
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
export async function resolveApprovers(db: Db, item: any, requester: { id: number; user_id: number | null; name: string }, loggerId: number) {
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
export async function stillApprover(db: Db, r: { item_id: number; requester_id: number; approver_ids: number[] }, userId: number) {
  if (!r.approver_ids.includes(userId)) return false;
  const { rows } = await db.query('SELECT i.approval, i.service_id, i.approval_team_id, p.name FROM request_items i, people p WHERE i.id = $1 AND p.id = $2', [r.item_id, r.requester_id]);
  if (!rows[0]) return false;
  return (await currentApprovers(db, rows[0], { id: r.requester_id, name: rows[0].name })).ids.includes(userId);
}

/** Active catalogue items whose form uses only these field types, named by their service's name for outsiders (the portal). */
export async function catalogueItems(itemId: number | null, fieldTypes: string[]) {
  const { rows } = await query(
    `SELECT i.id, i.name, i.description, i.form, i.approval <> 'none' AS needs_approval, ${PUBLIC_SERVICE_NAME} AS service
     FROM request_items i JOIN configuration_items c ON c.id = i.service_id LEFT JOIN service_status st ON st.ci_id = c.id AND st.public
     WHERE i.active AND ($1::int IS NULL OR i.id = $1)
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(i.form) f WHERE NOT (f->>'type' = ANY($2)))
     ORDER BY 6 NULLS LAST, i.name LIMIT 300`,
    [itemId, fieldTypes],
  );
  return rows;
}
