// Incident management (#28): restore service as quickly as possible, record what is affected, and hand recurring or
// major incidents to problem management. Shared by REST, MCP and the web UI like every other practice.
import { z } from 'zod';
import type { User } from './auth.js';
import { loadCi, logCi, registerCiExtra } from './cmdb.js';
import { currentContext } from './context.js';
import { query, tx } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { authorize, can } from './policy.js';
import { affectedFrom } from './problem-cis.js';
import { possibleCausesForIncident } from './changes.js';
import { createProblem, createProblemSchema, getProblem, loadForUpdate, logActivity, registerProblemExtra, type Db } from './problems.js';
import { recordUrl, registerRecordType, type RecordType } from './records.js';
import { logIncident } from './incident-log.js';
import { recomputeSla, slaClock, slaOnTransition } from './sla.js';
import { incidentPeople, namePeople, personRefSchema, resolvePerson } from './people.js';
import { managers, notify } from './notifications.js';
import { pool } from './db.js';

export { logIncident };

export const INCIDENT_STATUSES = ['new', 'in_progress', 'on_hold', 'resolved', 'closed'] as const;
export const RESOLUTION_CODES = ['fixed', 'workaround', 'problem_fixed', 'no_fault_found', 'duplicate', 'cancelled'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

const TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  new: ['in_progress', 'on_hold', 'resolved'],
  in_progress: ['on_hold', 'resolved'],
  on_hold: ['in_progress', 'resolved'],
  resolved: ['closed', 'in_progress'],
  closed: [],
};

const level = z.number().int().min(1).max(3);
export const incidentFields = {
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20000),
  impact: level,
  urgency: level,
  category_id: z.number().int().nullable(),
  assignment_group: z.string().trim().max(100),
  assignee_id: z.number().int().nullable(),
  reporter: z.string().trim().max(200),
  is_major: z.boolean(),
};
export const createIncidentSchema = z
  .object({ ...incidentFields, cis: z.array(z.string().trim().min(1).max(30)).max(50).optional(), caller: personRefSchema.optional() })
  .partial()
  .required({ title: true });
export const updateIncidentSchema = z.object(incidentFields).partial().extend({ base: z.object(incidentFields).partial().optional(), caller: personRefSchema.nullable().optional() });
export const transitionIncidentSchema = z.object({
  to: z.enum(INCIDENT_STATUSES),
  resolution_code: z.enum(RESOLUTION_CODES).optional(),
  resolution: z.string().max(20000).optional(),
  hold_reason: z.string().trim().max(1000).optional(),
  comment: z.string().max(20000).optional(),
});
export const listIncidentsSchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.union([z.enum(INCIDENT_STATUSES), z.literal('open'), z.literal('all')]).default('open'),
  priority: z.coerce.number().int().min(1).max(5).optional(),
  assignee: z.union([z.literal('me'), z.literal('none'), z.coerce.number().int()]).optional(),
  major: z.coerce.boolean().optional(),
  ci: z.string().max(30).optional(),
  /** Open incidents whose resolution target falls within this many minutes (or is already breached). */
  breaching_within: z.coerce.number().int().min(0).max(100_000).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export const incidentCommentSchema = z.object({ body: z.string().max(20000), kind: z.enum(['comment', 'communication']).default('comment') });
export const incidentLinkSchema = z.object({
  kind: z.enum(['incident', 'event', 'change', 'document']),
  reference: z.string().trim().min(1).max(200),
  system: z.string().trim().max(100).default(''),
  url: z
    .string()
    .trim()
    .max(2000)
    .refine((v) => v === '' || /^https?:\/\//i.test(v), 'URL must start with http:// or https://')
    .default(''),
  note: z.string().trim().max(2000).default(''),
});

const SELECT_INCIDENT = `
  SELECT i.*, c.name AS category, a.display_name AS assignee, p.ref AS problem_ref, p.title AS problem_title, p.status AS problem_status
  FROM incidents i LEFT JOIN categories c ON c.id = i.category_id LEFT JOIN users a ON a.id = i.assignee_id LEFT JOIN problems p ON p.id = i.problem_id`;

const sourceOf = (): 'mcp' | 'api' | 'user' => ({ mcp: 'mcp' as const, api: 'api' as const })[currentContext().channel as 'mcp' | 'api'] ?? 'user';


async function loadIncident(db: Db, ref: string) {
  const { rows } = await db.query('SELECT * FROM incidents WHERE ref = $1 FOR UPDATE', [ref.toUpperCase()]);
  if (!rows[0]) throw notFound(`Incident ${ref} not found`);
  return rows[0];
}

async function validateRefs(db: Db, input: { category_id?: number | null; assignee_id?: number | null }) {
  if (input.category_id) {
    const { rows } = await db.query('SELECT 1 FROM categories WHERE id = $1 AND active', [input.category_id]);
    if (!rows[0]) throw badRequest('Unknown category');
  }
  if (input.assignee_id) {
    const { rows } = await db.query("SELECT 1 FROM users WHERE id = $1 AND active AND role NOT IN ('viewer', 'integration')", [input.assignee_id]);
    if (!rows[0]) throw badRequest('Assignee must be an active user who can work on incidents');
  }
}

// ---- Reading -----------------------------------------------------------------------------------

export async function listIncidents(user: User, f: z.infer<typeof listIncidentsSchema>) {
  authorize(user, 'incident.read');
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (f.status === 'open') where.push("i.status NOT IN ('resolved', 'closed')");
  else if (f.status !== 'all') add('i.status = ?', f.status);
  if (f.priority) add('i.priority = ?', f.priority);
  if (f.assignee === 'me') add('i.assignee_id = ?', user.id);
  else if (f.assignee === 'none') where.push('i.assignee_id IS NULL');
  else if (typeof f.assignee === 'number') add('i.assignee_id = ?', f.assignee);
  if (f.major) where.push('i.is_major');
  if (f.breaching_within !== undefined) {
    where.push("i.status NOT IN ('resolved', 'closed') AND i.sla_paused_since IS NULL");
    add("(i.resolution_breached_at IS NOT NULL OR i.resolution_due_at < now() + ? * interval '1 minute')", f.breaching_within);
  }
  if (f.ci) add('EXISTS (SELECT 1 FROM incident_cis x JOIN configuration_items c ON c.id = x.ci_id WHERE x.incident_id = i.id AND c.ref = ?)', f.ci.toUpperCase());
  if (f.q) {
    const terms = f.q.split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}_.-]/gu, '')).filter(Boolean);
    if (terms.length) add("i.search @@ to_tsquery('simple', ?)", terms.map((t) => `${t}:*`).join(' & '));
  }
  params.push(f.limit);
  const { rows } = await query(
    `SELECT i.id, i.ref, i.title, i.status, i.priority, i.impact, i.urgency, i.is_major, i.assignment_group, a.display_name AS assignee,
            i.source, i.created_at, i.updated_at, i.resolved_at, p.ref AS problem_ref, i.resolution_due_at,
            CASE WHEN i.sla_id IS NULL OR i.resolution_due_at IS NULL THEN NULL
                 WHEN i.resolution_breached_at IS NOT NULL THEN 'breached'
                 WHEN i.status IN ('resolved', 'closed') THEN 'met'
                 WHEN i.sla_paused_since IS NOT NULL THEN 'paused'
                 WHEN now() > i.resolution_due_at THEN 'breached'
                 WHEN now() >= i.created_at + (i.resolution_due_at - i.created_at) * 0.75 THEN 'at_risk'
                 ELSE 'on_track' END AS sla_state,
            (SELECT array_agg(c.name ORDER BY c.criticality) FROM incident_cis x JOIN configuration_items c ON c.id = x.ci_id WHERE x.incident_id = i.id) AS cis
     FROM incidents i LEFT JOIN users a ON a.id = i.assignee_id LEFT JOIN problems p ON p.id = i.problem_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY i.status IN ('resolved', 'closed'), i.priority, i.created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({ ...r, url: incidentUrl(r.ref) }));
}

export async function getIncident(user: User, ref: string) {
  authorize(user, 'incident.read');
  const { rows } = await query(`${SELECT_INCIDENT} WHERE i.ref = $1`, [ref.toUpperCase()]);
  const i = rows[0];
  if (!i) throw notFound(`Incident ${ref} not found`);
  const [cis, activity, links, knownErrors, alerts] = await Promise.all([
    query(
      `SELECT c.id, c.ref, c.name, c.class, c.ci_type, t.label AS type_label, c.status, c.environment, c.criticality
       FROM incident_cis x JOIN configuration_items c ON c.id = x.ci_id JOIN ci_types t ON t.name = c.ci_type
       WHERE x.incident_id = $1 ORDER BY c.class DESC, c.criticality, c.name`,
      [i.id],
    ),
    query(
      `SELECT a.id, a.kind, a.body, a.data, a.channel, a.created_at, u.display_name AS user_name
       FROM incident_activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.incident_id = $1 ORDER BY a.created_at DESC, a.id DESC`,
      [i.id],
    ),
    query('SELECT id, kind, reference, system, url, note, created_at FROM incident_links WHERE incident_id = $1 ORDER BY kind, created_at', [i.id]),
    // Known errors on the affected CIs: the workaround may restore service right away.
    query(
      `SELECT DISTINCT ON (p.id) p.ref, p.title, p.workaround, p.workaround_effectiveness, c.ref AS ci_ref, c.name AS ci_name
       FROM incident_cis x JOIN problem_cis pc ON pc.ci_id = x.ci_id JOIN problems p ON p.id = pc.problem_id
       JOIN configuration_items c ON c.id = x.ci_id
       WHERE x.incident_id = $1 AND p.status = 'known_error' ORDER BY p.id LIMIT 10`,
      [i.id],
    ),
    // Monitoring alerts grouped into this incident (#30).
    query(
      `SELECT a.id, a.source, a.check_key, a.severity, a.status, a.count, a.flap_count, a.first_seen, a.last_seen, a.cleared_at, a.ci_hint,
              a.message, a.source_url, c.ref AS ci_ref, c.name AS ci_name
       FROM alerts a LEFT JOIN configuration_items c ON c.id = a.ci_id WHERE a.incident_id = $1 ORDER BY a.status, a.last_seen DESC LIMIT 200`,
      [i.id],
    ),
  ]);
  const affected = await affectedFrom(cis.rows, i.impact);
  const possibleChanges = await possibleCausesForIncident({ created_at: i.created_at, affected_cis: cis.rows });
  const sla = await slaClock(pool, i);
  const people = await incidentPeople(i, user);
  // Affected users are only asked for when a service involved has end users (#39: keep it optional).
  const refs = [...cis.rows.map((c) => c.ref), ...affected.affected_services.map((s) => s.ref)];
  const { rows: endUsers } = await query('SELECT 1 FROM configuration_items WHERE ref = ANY($1) AND has_end_users LIMIT 1', [refs]);
  const detail = { ...i, ...affected, activity: await namePeople(activity.rows), links: links.rows, known_errors: knownErrors.rows, alerts: alerts.rows, possible_change_causes: possibleChanges, sla, ...people, asks_affected_users: !!endUsers[0] || people.affected_people.length > 0 };
  return { type: 'incident', ...detail, url: incidentUrl(i.ref), next_steps: incidentGuidance(detail) };
}

function incidentGuidance(i: any) {
  const open = !['resolved', 'closed'].includes(i.status);
  const atRisk = ['at_risk', 'breached'].includes(i.sla?.resolution?.state) ? i.sla.resolution : null;
  const steps = [
    ...(atRisk && open ? [{ id: 'sla', label: atRisk.state === 'breached' ? 'The resolution target is breached' : 'The resolution target is at risk', hint: `${i.sla.name}: ${atRisk.remaining_minutes > 0 ? `${atRisk.remaining_minutes} business minutes left` : 'past due'}. Escalate or reassign if needed.`, done: null as unknown as boolean }] : []),
    { id: 'prioritise', label: 'Check impact and urgency', hint: 'Priority follows from them; affected services suggest the impact.', done: !i.impact_hint },
    { id: 'cis', label: 'Record the affected CIs or services', hint: 'Shows what else is affected and any known errors with workarounds.', done: i.affected_cis.length > 0 },
    { id: 'assign', label: 'Assign it', hint: 'An assignee or assignment group responds and owns restoring service.', done: !!i.assignee_id || !!i.assignment_group },
    ...(i.possible_change_causes.length ? [{ id: 'change', label: 'Check the recent change', hint: `${i.possible_change_causes[0].ref} on ${i.possible_change_causes[0].ci_name} started shortly before: a backout may restore service.`, done: null as unknown as boolean }] : []),
    ...(i.known_errors.length ? [{ id: 'known_error', label: 'Try the known error workaround', hint: `${i.known_errors[0].ref}: ${String(i.known_errors[0].title)}`, done: !!i.problem_id }] : []),
    ...(i.is_major ? [{ id: 'communicate', label: 'Keep stakeholders informed', hint: 'Post communication updates while the major incident is open.', done: i.activity.some((a: any) => a.kind === 'communication') }] : []),
    { id: 'resolve', label: 'Restore service and resolve', hint: 'Record how service was restored and a resolution code.', done: !open },
    ...(i.is_major || i.reopen_count > 0 ? [{ id: 'problem', label: 'Hand over to problem management', hint: i.is_major ? 'A major incident needs a problem record to find the root cause.' : 'It came back: a problem record finds out why.', done: !!i.problem_id }] : []),
  ];
  const knownError = i.known_errors[0];
  const handover =
    !i.problem_id && knownError ? { label: `A known error matches: link it to ${knownError.ref}`, hint: 'Its workaround may restore service, and the problem then counts this incident.', action: 'link_problem' as const, target: knownError.ref }
    : !i.problem_id && (i.is_major || i.reopen_count > 0) ? { label: i.is_major ? 'Major incident: create a problem' : 'Recurring? Create a problem', hint: 'Problem management finds the root cause so it does not happen again.', action: 'create_problem' as const }
    : null;
  return {
    handover,
    phase: open ? 'Restore service' : i.status === 'resolved' ? 'Confirm and close' : 'Closed',
    purpose: 'Restore normal service as quickly as possible and minimise the impact on the business.',
    steps,
    next: steps.find((s) => !s.done)?.label ?? 'Nothing pending.',
  };
}

// ---- Changing ----------------------------------------------------------------------------------

export async function createIncident(user: User, input: z.infer<typeof createIncidentSchema>, source?: 'event') {
  authorize(user, 'incident.create');
  if (input.is_major) authorize(user, 'incident.flag_major');
  const { cis, caller, ...fields } = input;
  const ref = await tx(async (db) => {
    await validateRefs(db, fields);
    const ciIds: number[] = [];
    for (const ciRef of cis ?? []) ciIds.push((await loadCi(db, ciRef)).id);
    const created = await insertIncident(db, user.id, fields, ciIds, source ?? sourceOf());
    if (caller) {
      const callerId = await resolvePerson(db, user, caller);
      await db.query('UPDATE incidents SET caller_id = $2 WHERE id = $1', [created.id, callerId]);
      await logIncident(db, created.id, user.id, 'update', `Caller: person #${callerId}`, { caller: { to: callerId } });
    }
    return created.ref;
  });
  return getIncident(user, ref);
}

/**
 * The insert itself, in the caller's transaction. Event rules (#30) call it as the system (actorId null) after
 * their own checks; everyone else goes through createIncident, which authorises.
 */
export async function insertIncident(
  db: Db,
  actorId: number | null,
  fields: Omit<z.infer<typeof createIncidentSchema>, 'cis'>,
  ciIds: number[],
  source: 'user' | 'api' | 'mcp' | 'event',
  extra: { event_rule_id?: number; event_group_key?: string } = {},
) {
  const values: Record<string, unknown> = { ...fields, ...extra, source, created_by: actorId };
  const cols = Object.keys(values).filter((k) => values[k] !== undefined);
  const { rows } = await db.query(
    `INSERT INTO incidents (${cols.join(', ')}) VALUES (${cols.map((_, n) => `$${n + 1}`).join(', ')}) RETURNING id, ref`,
    cols.map((k) => values[k]),
  );
  for (const id of ciIds) {
    await db.query('INSERT INTO incident_cis (incident_id, ci_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [rows[0].id, id, actorId]);
  }
  await logIncident(db, rows[0].id, actorId, 'created', `Incident ${rows[0].ref} logged${source === 'event' ? ' from monitoring' : ''}`, { title: fields.title, ci_ids: ciIds, source });
  await recomputeSla(db, rows[0].id, { reselect: true });
  const path = `/incidents/${rows[0].ref}`;
  if (fields.assignee_id) {
    await notify(db, { users: [fields.assignee_id], event: 'assigned', ref: rows[0].ref, title: fields.title, summary: 'An incident was assigned to you.', path, dedupe: `assigned:${rows[0].ref}:${Date.now()}`, actorId });
  }
  if (fields.is_major) {
    await notify(db, { users: await managers(db), event: 'major_incident', ref: rows[0].ref, title: fields.title, summary: 'A major incident was declared.', path, dedupe: `major:${rows[0].ref}`, actorId });
  }
  return rows[0] as { id: number; ref: string };
}

export async function updateIncident(user: User, ref: string, { base, caller, ...input }: z.infer<typeof updateIncidentSchema>) {
  authorize(user, 'incident.update');
  await tx(async (db) => {
    const current = await loadIncident(db, ref);
    if (caller !== undefined) {
      const callerId = caller ? await resolvePerson(db, user, caller) : null;
      if (callerId !== current.caller_id) {
        await db.query('UPDATE incidents SET caller_id = $2 WHERE id = $1', [current.id, callerId]);
        // People are referred to by id in histories, so erasing a person never rewrites them.
        await logIncident(db, current.id, user.id, 'update', callerId ? `Caller: person #${callerId}` : 'Caller removed', { caller: { from: current.caller_id, to: callerId } });
      }
    }
    if (base) {
      const stale = Object.keys(base).filter((k) => k in input && (current[k] ?? null) !== ((base as any)[k] ?? null));
      if (stale.length) throw conflict(`${stale.join(', ')} changed while you were editing`, { conflicts: stale.map((f) => ({ field: f, current: current[f] ?? null })) });
    }
    if (current.status === 'closed') throw conflict('A closed incident cannot be edited');
    if (input.is_major !== undefined && input.is_major !== current.is_major) authorize(user, 'incident.flag_major');
    await validateRefs(db, input);
    const changed = Object.entries(input).filter(([k, v]) => v !== undefined && current[k] !== v);
    if (!changed.length) return;
    await db.query(`UPDATE incidents SET ${changed.map(([k], n) => `${k} = $${n + 2}`).join(', ')} WHERE id = $1`, [current.id, ...changed.map(([, v]) => v)]);
    if (input.assignee_id && !current.responded_at) await db.query('UPDATE incidents SET responded_at = now() WHERE id = $1', [current.id]);
    const path = `/incidents/${current.ref}`;
    if (input.assignee_id && input.assignee_id !== current.assignee_id) {
      await notify(db, { users: [input.assignee_id], event: 'assigned', ref: current.ref, title: input.title ?? current.title, summary: `${user.display_name} assigned an incident to you.`, path, dedupe: `assigned:${current.ref}:${Date.now()}`, actorId: user.id });
    }
    if (input.is_major === true && !current.is_major) {
      await notify(db, { users: await managers(db), event: 'major_incident', ref: current.ref, title: input.title ?? current.title, summary: `${user.display_name} declared a major incident.`, path, dedupe: `major:${current.ref}`, actorId: user.id });
    }
    if ((input.impact !== undefined && input.impact !== current.impact) || (input.urgency !== undefined && input.urgency !== current.urgency)) {
      await recomputeSla(db, current.id, { reason: 'Priority changed' });
    }
    await logIncident(db, current.id, user.id, 'update', `Updated ${changed.map(([k]) => k).join(', ')}`, Object.fromEntries(changed.map(([k, v]) => [k, { from: current[k] ?? null, to: v }])));
  });
  return getIncident(user, ref);
}

export async function transitionIncident(user: User, ref: string, input: z.infer<typeof transitionIncidentSchema>) {
  authorize(user, 'incident.update');
  await tx(async (db) => {
    const current = await loadIncident(db, ref);
    const from = current.status as IncidentStatus;
    if (from === input.to) return;
    if (!TRANSITIONS[from].includes(input.to)) throw conflict(`An incident cannot move from ${from.replace('_', ' ')} to ${input.to.replace('_', ' ')}`);
    const code = input.resolution_code ?? current.resolution_code;
    const resolution = input.resolution ?? current.resolution;
    if (input.to === 'resolved') {
      if (!code) throw conflict('Give a resolution code when resolving');
      if (!resolution.trim() && code !== 'duplicate' && code !== 'cancelled') throw conflict('Describe how service was restored (resolution)');
    }
    if (input.to === 'on_hold' && !(input.hold_reason ?? '').trim()) throw conflict('Give a reason for putting the incident on hold');
    if (input.to === 'closed' && current.is_major && !current.problem_id) {
      throw conflict('A major incident needs a problem record before it is closed: create one from the incident or link an existing one');
    }
    const reopening = from === 'resolved' && input.to === 'in_progress';
    await db.query(
      `UPDATE incidents SET status = $2,
         resolution_code = CASE WHEN $2 IN ('resolved', 'closed') THEN $3 ELSE resolution_code END,
         resolution = CASE WHEN $2 IN ('resolved', 'closed') THEN $4 ELSE resolution END,
         hold_reason = CASE WHEN $2 = 'on_hold' THEN $5 ELSE '' END,
         responded_at = CASE WHEN $2 <> 'new' THEN coalesce(responded_at, now()) ELSE responded_at END,
         resolved_at = CASE WHEN $2 = 'resolved' THEN now() WHEN $6 THEN NULL ELSE resolved_at END,
         closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE NULL END,
         reopen_count = reopen_count + CASE WHEN $6 THEN 1 ELSE 0 END
       WHERE id = $1`,
      [current.id, input.to, code, resolution, input.hold_reason ?? '', reopening],
    );
    await slaOnTransition(db, current.id, input.to);
    await logIncident(db, current.id, user.id, 'status', input.comment ?? '', {
      from, to: input.to, ...(input.to === 'resolved' ? { resolution_code: code, resolution } : {}), ...(input.to === 'on_hold' ? { hold_reason: input.hold_reason } : {}),
    });
  });
  return getIncident(user, ref);
}

export async function addIncidentComment(user: User, ref: string, input: z.infer<typeof incidentCommentSchema>) {
  authorize(user, 'incident.update');
  if (!input.body.trim()) throw badRequest('Comment cannot be empty');
  await tx(async (db) => {
    const current = await loadIncident(db, ref);
    if (input.kind === 'communication' && !current.is_major) throw badRequest('Communication updates are for major incidents; add a note instead');
    await logIncident(db, current.id, user.id, input.kind, input.body.trim());
  });
  return getIncident(user, ref);
}

export async function addIncidentLink(user: User, ref: string, input: z.infer<typeof incidentLinkSchema>) {
  authorize(user, 'incident.update');
  await tx(async (db) => {
    const current = await loadIncident(db, ref);
    const { rowCount } = await db.query(
      'INSERT INTO incident_links (incident_id, kind, reference, system, url, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING',
      [current.id, input.kind, input.reference, input.system, input.url, input.note, user.id],
    );
    if (!rowCount) throw conflict(`${input.kind} ${input.reference} is already linked`);
    await logIncident(db, current.id, user.id, 'link', `Linked ${input.kind} ${input.reference}`, { ...input, action: 'add' });
  });
  return getIncident(user, ref);
}

export async function removeIncidentLink(user: User, ref: string, linkId: number) {
  authorize(user, 'incident.update');
  await tx(async (db) => {
    const current = await loadIncident(db, ref);
    const { rows } = await db.query('DELETE FROM incident_links WHERE id = $1 AND incident_id = $2 RETURNING kind, reference', [linkId, current.id]);
    if (!rows[0]) throw notFound('Link not found');
    await logIncident(db, current.id, user.id, 'link', `Unlinked ${rows[0].kind} ${rows[0].reference}`, { ...rows[0], action: 'remove' });
  });
  return getIncident(user, ref);
}

export async function setIncidentCi(user: User, ref: string, ciRef: string, linked: boolean) {
  authorize(user, 'incident.update');
  await tx(async (db) => {
    const current = await loadIncident(db, ref);
    const ci = await loadCi(db, ciRef);
    const { rowCount } = linked
      ? await db.query('INSERT INTO incident_cis (incident_id, ci_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [current.id, ci.id, user.id])
      : await db.query('DELETE FROM incident_cis WHERE incident_id = $1 AND ci_id = $2', [current.id, ci.id]);
    if (!rowCount) throw linked ? conflict(`${ci.ref} is already linked`) : notFound(`${ci.ref} is not linked`);
    await logIncident(db, current.id, user.id, 'link', `${linked ? 'Affects' : 'No longer affects'} ${ci.ref} ${ci.name}`, { kind: ci.class, reference: ci.ref, action: linked ? 'add' : 'remove' });
    await logCi(db, ci.id, user.id, 'link', `${linked ? 'Affected by' : 'Unlinked from'} incident ${current.ref}`, { kind: 'incident', reference: current.ref, action: linked ? 'add' : 'remove' });
    await recomputeSla(db, current.id, { reselect: true, reason: 'Affected CIs changed' });
  });
  return getIncident(user, ref);
}

// ---- Problem management ------------------------------------------------------------------------

/** Links the incident to a problem; the problem lists it like any linked incident (kind incident, system Kernel). */
export async function linkIncidentToProblem(user: User, ref: string, problemRef: string | null) {
  authorize(user, 'incident.update');
  if (problemRef) authorize(user, 'problem.link');
  await tx(async (db) => {
    const inc = await loadIncident(db, ref);
    if (inc.problem_id) {
      const { rows: old } = await db.query('SELECT id, ref FROM problems WHERE id = $1', [inc.problem_id]);
      await db.query("DELETE FROM problem_links WHERE problem_id = $1 AND kind = 'incident' AND reference = $2 AND system = 'Kernel'", [inc.problem_id, inc.ref]);
      if (old[0]) await logActivity(db, old[0].id, user.id, 'link', `Unlinked incident ${inc.ref}`, { kind: 'incident', reference: inc.ref, system: 'Kernel', action: 'remove' });
    }
    let problem: { id: number; ref: string } | null = null;
    if (problemRef) {
      const target: { id: number; ref: string } = await loadForUpdate(db, problemRef);
      problem = target;
      await db.query(
        `INSERT INTO problem_links (problem_id, kind, reference, system, note, created_by) VALUES ($1, 'incident', $2, 'Kernel', $3, $4) ON CONFLICT DO NOTHING`,
        [target.id, inc.ref, inc.title.slice(0, 2000), user.id],
      );
      await logActivity(db, target.id, user.id, 'link', `Linked incident ${inc.ref}`, { kind: 'incident', reference: inc.ref, system: 'Kernel', action: 'add' });
      // The incident's CIs are affected by the problem too.
      await db.query('INSERT INTO problem_cis (problem_id, ci_id, added_by) SELECT $1, ci_id, $2 FROM incident_cis WHERE incident_id = $3 ON CONFLICT DO NOTHING', [target.id, user.id, inc.id]);
      await db.query('UPDATE problems SET updated_at = now() WHERE id = $1', [target.id]);
    }
    await db.query('UPDATE incidents SET problem_id = $2 WHERE id = $1', [inc.id, problem?.id ?? null]);
    await logIncident(db, inc.id, user.id, 'link', problem ? `Linked to problem ${problem.ref}` : 'Unlinked from its problem', { kind: 'problem', reference: problem?.ref ?? null, action: problem ? 'add' : 'remove' });
  });
  return getIncident(user, ref);
}

export const problemFromIncidentSchema = createProblemSchema.partial();

/** Logs a problem prefilled from the incident (and links it); the usual route for major or recurring incidents. */
export async function createProblemFromIncident(user: User, ref: string, overrides: z.infer<typeof problemFromIncidentSchema>) {
  const inc = await getIncident(user, ref);
  const prefill = {
    title: inc.title,
    description: `${inc.description}\n\nRaised from incident ${inc.ref}.`.trim(),
    impact: inc.impact,
    urgency: inc.urgency,
    category_id: inc.category_id,
    detection: 'reactive',
    // A major problem only when the person may flag one; otherwise a problem manager decides later.
    is_major: (inc.is_major && can(user.role, 'problem.flag_major')) || undefined,
    ...overrides,
  };
  // Leave out unset fields so the database defaults apply.
  const created = await createProblem(user, createProblemSchema.parse(Object.fromEntries(Object.entries(prefill).filter(([, v]) => v !== undefined))));
  await linkIncidentToProblem(user, ref, created.ref);
  return getProblem(created.ref);
}

export const resolveLinkedSchema = z.object({ incidents: z.array(z.string()).min(1).max(200), resolution: z.string().trim().min(1).max(20000) });

/** When a problem is resolved, its open incidents can be resolved in one go with resolution code problem_fixed. */
export async function resolveLinkedIncidents(user: User, problemRef: string, input: z.infer<typeof resolveLinkedSchema>) {
  authorize(user, 'incident.update');
  const p = await getProblem(problemRef);
  const { rows } = await query("SELECT ref FROM incidents WHERE problem_id = $1 AND ref = ANY($2) AND status NOT IN ('resolved', 'closed')", [p.id, input.incidents.map((r) => r.toUpperCase())]);
  // Each incident in its own transaction: one that cannot be resolved does not undo or hide the others.
  const resolved: string[] = [];
  const failed: { ref: string; error: string }[] = [];
  for (const r of rows) {
    try {
      await transitionIncident(user, r.ref, { to: 'resolved', resolution_code: 'problem_fixed', resolution: input.resolution, comment: `Resolved with problem ${p.ref}` });
      resolved.push(r.ref);
    } catch (err) {
      failed.push({ ref: r.ref, error: (err as Error).message });
    }
  }
  return { ...(await getProblem(problemRef)), resolve_result: { resolved, failed } };
}

registerProblemExtra(async (p) => {
  const { rows } = await query(
    `SELECT ref, title, status, priority, created_at FROM incidents WHERE problem_id = $1 ORDER BY status IN ('resolved', 'closed'), created_at DESC LIMIT 200`,
    [p.id],
  );
  return { incidents: rows };
});

registerCiExtra(async (ciId) => {
  const { rows } = await query(
    `SELECT i.ref, i.title, i.status, i.priority, i.created_at FROM incident_cis x JOIN incidents i ON i.id = x.incident_id
     WHERE x.ci_id = $1 ORDER BY i.status IN ('resolved', 'closed'), i.created_at DESC LIMIT 25`,
    [ciId],
  );
  return { incidents: rows };
});

// ---- Registry ----------------------------------------------------------------------------------

const INCIDENT_TYPE: RecordType = {
  type: 'incident',
  prefix: 'INC',
  // Exactly six digits, so references to other tools (ServiceNow INC0009001…) are not mistaken for Kernel incidents.
  pattern: /^INC\d{6}$/,
  readAction: 'incident.read',
  uiPath: (ref) => `/incidents/${ref}`,
  get: getIncident,
  search: async (user, q, limit) =>
    (await listIncidents(user, listIncidentsSchema.parse({ q, status: 'all', limit }))).map((i) => ({
      type: 'incident', ref: i.ref, title: i.title, status: i.status, url: i.url, summary: [`P${i.priority}`, i.assignee, (i.cis ?? []).join(', ')].filter(Boolean).join(' · '),
    })),
  rest: {
    list: '/api/incidents',
    create: '/api/incidents',
    get: '/api/incidents/:ref',
    update: '/api/incidents/:ref',
    transition: '/api/incidents/:ref/transition',
    links: '/api/incidents/:ref/links',
    comments: '/api/incidents/:ref/comments',
  },
  mcp: { list: 'list_incidents', get: 'get_incident', create: 'create_incident', update: 'update_incident', transition: 'transition_incident' },
};
registerRecordType(INCIDENT_TYPE);

function incidentUrl(ref: string) {
  return recordUrl(INCIDENT_TYPE, ref);
}
