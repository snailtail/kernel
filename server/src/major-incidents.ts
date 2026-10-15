// Major incidents (#108): the response, not just the flag. Who leads and who communicates, where people talk (the
// bridge), when the next stakeholder update is due, a timeline of key moments for the post-incident review (#109),
// and related incidents (the same outage reported again) that are resolved together with the major one.
// Shared by REST, MCP and the web UI like every other practice.
import { z } from 'zod';
import { audit } from './audit.js';
import { maskedRefs } from './confidential.js';
import { currentContext } from './context.js';
import type { User } from './auth.js';
import { query, tx } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { logIncident } from './incident-log.js';
import { attachToProblem, getIncident } from './incidents.js';
import { managers, notify } from './notifications.js';
import { authorize, can } from './policy.js';
import type { Db } from './problems.js';
import { affectedFrom } from './problem-cis.js';
import { slaOnTransition } from './sla.js';

/** Minutes between stakeholder updates by priority, until the lead changes it (settings `major_incident`). */
const DEFAULT_CADENCE: Record<number, number> = { 1: 30, 2: 60, 3: 120, 4: 240, 5: 240 };

export async function cadenceFor(db: Db, priority: number) {
  const { rows } = await db.query("SELECT value FROM settings WHERE key = 'major_incident'");
  const configured = rows[0]?.value?.update_minutes?.[priority];
  return Number.isInteger(configured) && configured >= 5 && configured <= 1440 ? configured : DEFAULT_CADENCE[priority] ?? 60;
}

const minutes = z.number().int().min(5).max(1440);
const bridge = z
  .string()
  .trim()
  .max(500)
  // A meeting link or a phone number: never a javascript: URL in the header.
  .refine((v) => v === '' || /^https?:\/\//i.test(v) || /^[+\d][\d\s()./-]{3,}([,;#*\w\s]*)$/.test(v), 'A meeting link (https://…) or a phone number');

export const declareMajorSchema = z.object({
  /** The incident lead; the person declaring by default. */
  lead_id: z.number().int().optional(),
  comms_id: z.number().int().nullable().optional(),
  bridge: bridge.optional(),
  /** Minutes between updates; the priority's default if left out. */
  update_minutes: minutes.optional(),
});
export const majorRolesSchema = z.object({
  lead_id: z.number().int().optional(),
  comms_id: z.number().int().nullable().optional(),
  bridge: bridge.optional(),
  update_minutes: minutes.optional(),
});
export const communicationSchema = z.object({ body: z.string().trim().min(1).max(20000) });
export const childSchema = z.object({ child: z.string().trim().min(1).max(20), resolve_with_parent: z.boolean().default(true) });
export const keyMomentSchema = z.object({ key_moment: z.boolean() });

async function lockIncident(db: Db, ref: string) {
  const { rows } = await db.query('SELECT * FROM incidents WHERE ref = $1 FOR UPDATE', [ref.toUpperCase()]);
  if (!rows[0]) throw notFound(`Incident ${ref} not found`);
  return rows[0];
}

/** Leads and comms leads are people who work on incidents. */
async function checkPerson(db: Db, id: number | null | undefined, role: string) {
  if (id === undefined || id === null) return;
  const { rows } = await db.query("SELECT 1 FROM users WHERE id = $1 AND active AND role NOT IN ('viewer', 'integration')", [id]);
  if (!rows[0]) throw badRequest(`The ${role} must be an active user who can work on incidents`);
}

const isOpen = (i: { status: string }) => !['resolved', 'closed'].includes(i.status);

/**
 * Declares a major incident in the caller's transaction: roles, bridge, cadence, the first update due, one timeline
 * entry and the notices. createIncident and updateIncident (is_major) go through here too.
 */
export async function declareInTx(db: Db, actor: { id: number | null; name: string }, current: any, input: z.infer<typeof declareMajorSchema>) {
  if (!isOpen(current)) throw conflict('Only an open incident can become a major incident');
  const lead = input.lead_id ?? actor.id;
  await checkPerson(db, lead, 'incident lead');
  await checkPerson(db, input.comms_id, 'communications lead');
  const every = input.update_minutes ?? (await cadenceFor(db, current.priority));
  await db.query(
    `UPDATE incidents SET is_major = true, major_declared_at = now(), major_lead_id = $2, major_comms_id = $3, major_bridge = $4,
       major_update_minutes = $5::int, major_next_update_at = now() + $5::int * interval '1 minute', major_overdue_notified_for = NULL WHERE id = $1`,
    [current.id, lead, input.comms_id ?? null, input.bridge ?? '', every],
  );
  await logIncident(db, current.id, actor.id, 'major', 'Declared a major incident', { action: 'declare', lead_id: lead, comms_id: input.comms_id ?? null, bridge: input.bridge ?? '', update_minutes: every });
  const path = `/incidents/${current.ref}`;
  await notify(db, { users: await managers(db), event: 'major_incident', ref: current.ref, title: current.title, summary: `${actor.name} declared a major incident.`, path, dedupe: `major:${current.ref}`, actorId: actor.id });
  const roles = [lead, input.comms_id].filter((u): u is number => !!u && u !== actor.id);
  if (roles.length) {
    await notify(db, { users: roles, event: 'major_incident', ref: current.ref, title: current.title, summary: `${actor.name} named you in the major incident team.`, path, dedupe: `major-role:${current.ref}:${Date.now()}`, actorId: actor.id });
  }
}

/** Standing down without resolving (it was not a major incident after all): the cadence stops. */
export async function undeclareInTx(db: Db, actorId: number, current: any) {
  await db.query('UPDATE incidents SET is_major = false, major_next_update_at = NULL WHERE id = $1', [current.id]);
  await logIncident(db, current.id, actorId, 'major', 'No longer a major incident', { action: 'undeclare' });
}

export async function declareMajor(user: User, ref: string, input: z.infer<typeof declareMajorSchema>) {
  authorize(user, 'incident.flag_major');
  await tx(async (db) => {
    const current = await lockIncident(db, ref);
    if (current.is_major) throw conflict(`${current.ref} is already a major incident: change its roles instead`);
    if (current.parent_id) throw conflict('This incident is related to another major incident: unlink it first');
    await declareInTx(db, { id: user.id, name: user.display_name }, current, input);
  });
  return getIncident(user, ref);
}

/** Lead, comms lead, bridge and cadence: the incident lead or a manager. */
export async function setMajorRoles(user: User, ref: string, input: z.infer<typeof majorRolesSchema>) {
  authorize(user, 'incident.update');
  await tx(async (db) => {
    const current = await lockIncident(db, ref);
    if (!current.is_major) throw conflict(`${current.ref} is not a major incident`);
    if (current.major_lead_id !== user.id && !can(user.role, 'incident.flag_major')) throw forbidden('Only the incident lead or a problem manager can change the major incident team');
    if (input.lead_id === undefined && input.comms_id === undefined && input.bridge === undefined && input.update_minutes === undefined) return;
    await checkPerson(db, input.lead_id, 'incident lead');
    await checkPerson(db, input.comms_id, 'communications lead');
    const fields: Record<string, unknown> = { major_lead_id: input.lead_id, major_comms_id: input.comms_id, major_bridge: input.bridge, major_update_minutes: input.update_minutes };
    const changed = Object.entries(fields).filter(([k, v]) => v !== undefined && current[k] !== v);
    if (!changed.length) return;
    await db.query(`UPDATE incidents SET ${changed.map(([k], n) => `${k} = $${n + 2}`).join(', ')} WHERE id = $1`, [current.id, ...changed.map(([, v]) => v)]);
    // A new cadence counts from the last update (or the declaration), so shortening it can make an update due now.
    if (input.update_minutes !== undefined && isOpen(current)) {
      await db.query(
        `UPDATE incidents SET major_next_update_at = coalesce((SELECT max(created_at) FROM incident_activity WHERE incident_id = $1 AND kind = 'communication'), major_declared_at, now())
           + major_update_minutes * interval '1 minute', major_overdue_notified_for = NULL WHERE id = $1`,
        [current.id],
      );
    }
    const data = Object.fromEntries(changed.map(([k, v]) => [k.replace('major_', ''), { from: current[k] ?? null, to: v }]));
    await logIncident(db, current.id, user.id, 'major', `Changed ${changed.map(([k]) => ({ major_lead_id: 'the lead', major_comms_id: 'the communications lead', major_bridge: 'the bridge', major_update_minutes: 'the update cadence' })[k]).join(', ')}`, { action: 'roles', ...data });
    const newcomers = [input.lead_id, input.comms_id].filter((u): u is number => !!u && u !== user.id && u !== current.major_lead_id && u !== current.major_comms_id);
    if (newcomers.length) {
      await notify(db, { users: newcomers, event: 'major_incident', ref: current.ref, title: current.title, summary: `${user.display_name} named you in the major incident team.`, path: `/incidents/${current.ref}`, dedupe: `major-role:${current.ref}:${Date.now()}`, actorId: user.id });
    }
  });
  return getIncident(user, ref);
}

/** A stakeholder update. Posting one (here, as a communication note, or from the status board) restarts the countdown. */
export async function postCommunication(user: User, ref: string, input: z.infer<typeof communicationSchema>) {
  authorize(user, 'incident.update');
  await tx(async (db) => {
    const current = await lockIncident(db, ref);
    if (!current.is_major) throw badRequest('Communication updates are for major incidents; add a note instead');
    await logIncident(db, current.id, user.id, 'communication', input.body);
  });
  return getIncident(user, ref);
}

// ---- Related incidents -------------------------------------------------------------------------

/** Links an incident under a major (or any open) incident; one level only. */
export async function linkChild(user: User, parentRef: string, input: z.infer<typeof childSchema>) {
  authorize(user, 'incident.update');
  await tx(async (db) => {
    // Lock both in id order, so two people linking the other way round cannot deadlock.
    const { rows } = await db.query('SELECT * FROM incidents WHERE ref = ANY($1) ORDER BY id FOR UPDATE', [[parentRef.toUpperCase(), input.child.toUpperCase()]]);
    const parent = rows.find((r) => r.ref === parentRef.toUpperCase());
    const child = rows.find((r) => r.ref === input.child.toUpperCase());
    if (!parent) throw notFound(`Incident ${parentRef} not found`);
    if (!child) throw notFound(`Incident ${input.child} not found`);
    if (parent.id === child.id) throw badRequest('An incident cannot be related to itself');
    if (!isOpen(parent)) throw conflict(`${parent.ref} is ${parent.status}: relate incidents to an open one`);
    if (child.status === 'closed') throw conflict(`${child.ref} is closed`);
    if (parent.parent_id) throw conflict(`${parent.ref} is itself related to another incident: link to that one`);
    if (child.is_major) throw conflict(`${child.ref} is a major incident itself`);
    const { rows: grandchildren } = await db.query('SELECT 1 FROM incidents WHERE parent_id = $1 LIMIT 1', [child.id]);
    if (grandchildren[0]) throw conflict(`${child.ref} has related incidents of its own: link those to ${parent.ref} instead`);
    if (child.parent_id && child.parent_id !== parent.id) throw conflict(`${child.ref} is already related to another incident: unlink it first`);
    if (child.parent_id === parent.id && child.resolve_with_parent === input.resolve_with_parent) return;
    await db.query('UPDATE incidents SET parent_id = $2, resolve_with_parent = $3 WHERE id = $1', [child.id, parent.id, input.resolve_with_parent]);
    if (child.parent_id === parent.id) {
      await logIncident(db, child.id, user.id, 'update', input.resolve_with_parent ? `Resolves together with ${parent.ref}` : `Stays open when ${parent.ref} is resolved`, { resolve_with_parent: { from: child.resolve_with_parent, to: input.resolve_with_parent } });
      return;
    }
    await logIncident(db, child.id, user.id, 'link', `Related to ${parent.ref}`, { kind: 'incident', relation: 'parent', reference: parent.ref, action: 'add' });
    await logIncident(db, parent.id, user.id, 'link', `Related incident ${child.ref}`, { kind: 'incident', relation: 'child', reference: child.ref, action: 'add', resolve_with_parent: input.resolve_with_parent });
    // It counts for the parent's problem too, so the problem's impact is not understated.
    if (parent.problem_id && !child.problem_id) {
      const { rows: problem } = await db.query('SELECT id, ref FROM problems WHERE id = $1 FOR UPDATE', [parent.problem_id]);
      if (problem[0]) await attachToProblem(db, user.id, child, problem[0]);
    }
  });
  return getIncident(user, parentRef);
}

export async function unlinkChild(user: User, parentRef: string, childRef: string) {
  authorize(user, 'incident.update');
  await tx(async (db) => {
    const { rows } = await db.query(
      `SELECT c.id, c.ref, p.id AS parent_id, p.ref AS parent_ref FROM incidents c JOIN incidents p ON p.id = c.parent_id
       WHERE c.ref = $1 AND p.ref = $2 FOR UPDATE OF c`,
      [childRef.toUpperCase(), parentRef.toUpperCase()],
    );
    if (!rows[0]) throw notFound(`${childRef} is not related to ${parentRef}`);
    await db.query('UPDATE incidents SET parent_id = NULL, resolve_with_parent = true WHERE id = $1', [rows[0].id]);
    await logIncident(db, rows[0].id, user.id, 'link', `No longer related to ${rows[0].parent_ref}`, { kind: 'incident', relation: 'parent', reference: rows[0].parent_ref, action: 'remove' });
    await logIncident(db, rows[0].parent_id, user.id, 'link', `${rows[0].ref} is no longer related`, { kind: 'incident', relation: 'child', reference: rows[0].ref, action: 'remove' });
  });
  return getIncident(user, parentRef);
}

/**
 * When a parent is resolved, its related incidents that resolve with it get its resolution, each with its own
 * history and audit entry. Ones someone unticked stay open.
 */
export async function resolveChildren(db: Db, actorId: number, parent: { id: number; ref: string; restricted?: boolean; classification?: string; problem_id?: number | null }, code: string, resolution: string) {
  const { rows: children } = await db.query(
    "SELECT id, ref, title, status, restricted, classification, problem_id FROM incidents WHERE parent_id = $1 AND resolve_with_parent AND status NOT IN ('resolved', 'closed') ORDER BY id FOR UPDATE",
    [parent.id],
  );
  const { rows: problem } = parent.problem_id ? await db.query('SELECT id, ref FROM problems WHERE id = $1', [parent.problem_id]) : { rows: [] as any[] };
  for (const c of children) {
    // A restricted or confidential parent's resolution never reaches a child more people can read: only the reference.
    const narrower = (parent.restricted && !c.restricted) || (parent.classification === 'confidential' && c.classification !== 'confidential');
    const text = (narrower ? `Resolved with ${parent.ref}.` : `Resolved with ${parent.ref}: ${resolution}`).slice(0, 20000);
    if (problem[0] && !c.problem_id) await attachToProblem(db, actorId, c, problem[0]);
    await db.query(
      `UPDATE incidents SET status = 'resolved', resolution_code = $2, resolution = $3, resolved_at = now(),
         responded_at = coalesce(responded_at, now()) WHERE id = $1`,
      [c.id, code, text],
    );
    await slaOnTransition(db, c.id, 'resolved');
    await logIncident(db, c.id, actorId, 'status', '', { from: c.status, to: 'resolved', resolution_code: code, resolution: text, with_parent: parent.ref });
  }
  if (children.length) {
    await logIncident(db, parent.id, actorId, 'update', `Resolved ${children.length} related incident${children.length === 1 ? '' : 's'} with it`, { resolved_children: children.map((c) => c.ref) });
  }
  return children.map((c) => c.ref as string);
}

// ---- What the incident page shows ----------------------------------------------------------------

/**
 * The same outage reported again: an open major incident that shares a CI or an affected service with this one, the
 * services worked out through the impact graph for both (a major on a server and a report on the shop it serves).
 */
async function suggestParent(incidentId: number, affectedServices: { ref: string }[]) {
  const { rows: majors } = await query(
    `SELECT m.id, m.ref, m.title, m.impact FROM incidents m WHERE m.is_major AND m.status NOT IN ('resolved', 'closed') AND m.id <> $1 AND m.parent_id IS NULL
     ORDER BY m.priority, m.major_declared_at DESC LIMIT 10`,
    [incidentId],
  );
  if (!majors.length) return { rows: [] };
  const { rows: mine } = await query('SELECT c.ref FROM incident_cis x JOIN configuration_items c ON c.id = x.ci_id WHERE x.incident_id = $1', [incidentId]);
  const here = new Set([...mine.map((c) => c.ref as string), ...affectedServices.map((s) => s.ref)]);
  if (!here.size) return { rows: [] };
  for (const m of majors) {
    const { rows: cis } = await query('SELECT c.id, c.ref, c.name, c.class, c.criticality FROM incident_cis x JOIN configuration_items c ON c.id = x.ci_id WHERE x.incident_id = $1', [m.id]);
    if (cis.some((c) => here.has(c.ref))) return { rows: [{ ref: m.ref, title: m.title }] };
    const { affected_services } = await affectedFrom(cis, m.impact);
    if (affected_services.some((sv: { ref: string }) => here.has(sv.ref))) return { rows: [{ ref: m.ref, title: m.title }] };
  }
  return { rows: [] };
}

/** The major incident header, related incidents, a suggested parent and a status page proposal. */
export async function majorDetail(user: User, i: any, affectedServices: { ref: string; name: string }[]) {
  const [children, parent, people, lastUpdate, suggested, statusPosted] = await Promise.all([
    query('SELECT ref, title, status, priority, resolve_with_parent FROM incidents WHERE parent_id = $1 ORDER BY id', [i.id]),
    i.parent_id ? query('SELECT ref, title, status, is_major FROM incidents WHERE id = $1', [i.parent_id]) : Promise.resolve({ rows: [] as any[] }),
    query('SELECT id, display_name FROM users WHERE id = ANY($1)', [[i.major_lead_id, i.major_comms_id, i.pir_owner_id].filter(Boolean)]),
    i.is_major ? query("SELECT body, created_at FROM incident_activity WHERE incident_id = $1 AND kind = 'communication' ORDER BY created_at DESC, id DESC LIMIT 1", [i.id]) : Promise.resolve({ rows: [] as any[] }),
    !i.is_major && !i.parent_id && isOpen(i) ? suggestParent(i.id, affectedServices) : Promise.resolve({ rows: [] as any[] }),
    i.is_major ? query('SELECT 1 FROM status_updates WHERE incident_id = $1 LIMIT 1', [i.id]) : Promise.resolve({ rows: [] as any[] }),
  ]);
  const name = (id: number | null) => people.rows.find((p) => p.id === id)?.display_name ?? null;
  const open = isOpen(i);
  const major = i.is_major
    ? {
        declared_at: i.major_declared_at,
        lead_id: i.major_lead_id, lead: name(i.major_lead_id),
        comms_id: i.major_comms_id, comms: name(i.major_comms_id),
        bridge: i.major_bridge,
        update_minutes: i.major_update_minutes,
        next_update_at: open ? i.major_next_update_at : null,
        update_overdue: open && !!i.major_next_update_at && new Date(i.major_next_update_at) < new Date(),
        last_update: lastUpdate.rows[0] ?? null,
        pir_owner_id: i.pir_owner_id, pir_owner: name(i.pir_owner_id), pir_due: i.pir_due,
      }
    : null;
  // A proposal only: a person reviews it and posts it to the status board; nothing goes public by itself.
  const services = affectedServices.slice(0, 20);
  const statusProposal = i.is_major && open && !statusPosted.rows[0] && services.length && can(user.role, 'status.set')
    ? {
        services: services.map((s) => s.ref),
        status: i.priority <= 1 ? 'major_outage' : i.priority === 2 ? 'partial_outage' : 'degraded',
        phase: 'investigating',
        message: `We are investigating a disruption affecting ${services.map((s) => s.name).join(', ')}.${i.major_next_update_at ? ' We will post an update as soon as we know more.' : ''}`,
      }
    : null;
  return { major, children: children.rows, parent: parent.rows[0] ?? null, suggested_parent: suggested.rows[0] ?? null, status_proposal: statusProposal };
}

// ---- Timeline ----------------------------------------------------------------------------------

const STATUS_LABEL: Record<string, string> = { new: 'New', in_progress: 'In progress', on_hold: 'On hold', resolved: 'Resolved', closed: 'Closed' };

/**
 * The key moments only: declared, first response, communications, status changes, linked changes, events and
 * problems, related incidents, the workaround and resolution, and anything someone marked. Oldest first.
 */
export async function timeline(user: User, ref: string) {
  authorize(user, 'incident.read');
  const { rows: inc } = await query('SELECT id, ref, title, created_at, responded_at, is_major, major_declared_at FROM incidents WHERE ref = $1', [ref.toUpperCase()]);
  if (!inc[0]) throw notFound(`Incident ${ref} not found`);
  const i = inc[0];
  // A confidential incident's notes, updates and resolution stay masked for those who may not read them (#61), also in
  // the Markdown export, which the response masking cannot reach. Agents never read them.
  const masked = (await maskedRefs(currentContext().channel === 'mcp' ? null : user, [i.ref])).has(i.ref);
  const { rows } = await query(
    `SELECT a.id, a.kind, a.body, a.data, a.key_moment, a.created_at, u.display_name AS by
     FROM incident_activity a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.incident_id = $1 AND (a.key_moment OR a.kind IN ('created', 'major', 'communication', 'status')
       OR (a.kind = 'link' AND a.data->>'kind' IN ('change', 'event', 'problem', 'incident')))
     ORDER BY a.created_at, a.id`,
    [i.id],
  );
  const entries = rows.map((a) => ({
    activity_id: a.id as number, at: a.created_at as Date, kind: a.kind as string, key_moment: a.key_moment as boolean, by: a.by as string | null,
    label: a.kind === 'status'
      ? `${STATUS_LABEL[a.data.from] ?? a.data.from} → ${STATUS_LABEL[a.data.to] ?? a.data.to}${a.data.resolution_code ? ` (${String(a.data.resolution_code).replace('_', ' ')})` : ''}${a.data.with_parent ? ` with ${a.data.with_parent}` : ''}`
      : a.kind === 'communication' ? 'Communication update' : a.kind === 'created' ? 'Logged' : a.kind === 'comment' ? 'Note' : a.body,
    body: masked ? '' : a.kind === 'communication' || a.kind === 'comment' ? a.body : a.kind === 'status' ? (a.data.resolution ?? a.body ?? '') : '',
  }));
  if (i.responded_at) entries.push({ activity_id: 0, at: i.responded_at, kind: 'response', key_moment: false, by: null, label: 'First response', body: '' });
  entries.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime() || a.activity_id - b.activity_id);
  return { ref: i.ref, title: i.title, is_major: i.is_major, declared_at: i.major_declared_at, confidential_masked: masked || undefined, entries };
}

export function timelineMarkdown(t: Awaited<ReturnType<typeof timeline>>) {
  const time = (d: Date) => new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const lines = [`# Timeline: ${t.ref} ${t.title}`, '', ...(t.confidential_masked ? ['Confidential: notes, updates and the resolution are not included.', ''] : []), '| Time | What | By |', '|---|---|---|'];
  // Backslashes first, then pipes, so a cell cannot end the table row early.
  const cell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  for (const e of t.entries) lines.push(`| ${time(e.at)} | ${cell(e.label)}${e.body ? `: ${cell(e.body.slice(0, 500))}` : ''}${e.key_moment ? ' ★' : ''} | ${cell(e.by ?? '')} |`);
  return lines.join('\n') + '\n';
}

/** Anyone working on incidents may mark any entry a key moment; the change is audited, not added to the feed. */
export async function setKeyMoment(user: User, ref: string, activityId: number, key: boolean) {
  authorize(user, 'incident.update');
  await tx(async (db) => {
    const { rows } = await db.query(
      'UPDATE incident_activity a SET key_moment = $3 FROM incidents i WHERE a.id = $1 AND a.incident_id = i.id AND i.ref = $2 RETURNING a.id',
      [activityId, ref.toUpperCase(), key],
    );
    if (!rows[0]) throw notFound('Activity entry not found');
    await audit(db, { entity_type: 'incident', entity_ref: ref.toUpperCase(), action: key ? 'key_moment' : 'key_moment_removed', changes: { activity_id: activityId } });
  });
  return timeline(user, ref);
}

// ---- Overdue updates ---------------------------------------------------------------------------

/** Tells the communications lead (or the lead) once per period that an update is overdue. */
export async function checkOverdueUpdates() {
  const { rows } = await query(
    `SELECT id FROM incidents WHERE is_major AND status NOT IN ('resolved', 'closed') AND major_next_update_at < now()
       AND major_overdue_notified_for IS DISTINCT FROM major_next_update_at`,
  );
  let sent = 0;
  for (const { id } of rows) {
    await tx(async (db) => {
      // Claimed in one statement, so another replica (or an update posted meanwhile) cannot cause a second notice.
      const { rows: claimed } = await db.query(
        `UPDATE incidents SET major_overdue_notified_for = major_next_update_at
         WHERE id = $1 AND is_major AND status NOT IN ('resolved', 'closed') AND major_next_update_at < now()
           AND major_overdue_notified_for IS DISTINCT FROM major_next_update_at
         RETURNING ref, title, major_next_update_at,
           -- The comms lead, else the lead, else the assignee, if still active; nobody named reaches the managers.
           (SELECT u.id FROM users u WHERE u.active AND u.id = ANY(ARRAY[major_comms_id, major_lead_id, assignee_id])
            ORDER BY array_position(ARRAY[major_comms_id, major_lead_id, assignee_id], u.id) LIMIT 1) AS who`,
        [id],
      );
      const r = claimed[0];
      if (!r) return;
      sent++;
      await notify(db, { users: r.who ? [r.who] : await managers(db), event: 'major_update_due', ref: r.ref, title: r.title, summary: 'A stakeholder update is overdue on the major incident.', path: `/incidents/${r.ref}`, dedupe: `major_due:${r.ref}:${new Date(r.major_next_update_at).toISOString()}`, actorId: null });
    });
  }
  return sent;
}

export function startMajorIncidentWorker(log: (msg: string) => void, enabled: () => boolean) {
  setInterval(() => enabled() && checkOverdueUpdates().catch((err) => log(`Major incident check failed: ${err.message}`)), 60_000).unref();
}
