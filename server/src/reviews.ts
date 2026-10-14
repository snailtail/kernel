// Post-incident reviews (#109): a short, blameless look back that people actually finish. It starts filled in with
// what Kernel already knows (the timeline, the impact, changes shortly before), follows a guided template, and turns
// contributing factors into problems and follow-ups into actions, linked both ways. One per incident: scheduled when
// a major incident is resolved, optional for any other. Shared by REST, MCP and the web UI.
import { z } from 'zod';
import { insertAction } from './actions.js';
import { audit } from './audit.js';
import type { User } from './auth.js';
import { audienceOf, copyText, mayCopyText, startNarrow, titleAudience, whyNotForEveryone } from './audience.js';
import { maskedRefs } from './confidential.js';
import { currentContext } from './context.js';
import { query, tx } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { logIncident } from './incident-log.js';
import { getIncident } from './incidents.js';
import { createArticle } from './knowledge.js';
import { timeline } from './major-incidents.js';
import { authorize, can } from './policy.js';
import { createProblemInTx, loadForUpdate, logActivity, registerProblemExtra, type Db } from './problems.js';
import { loadCalendar } from './sla.js';

export const REVIEW_STATUSES = ['scheduled', 'draft', 'published', 'waived'] as const;
export const ITEM_KINDS = ['factor', 'follow_up', 'gap'] as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const text = z.string().max(20000);

export const createReviewSchema = z.object({ owner_id: z.number().int().nullable().optional(), due: date.nullable().optional() });
export const updateReviewSchema = z.object({
  owner_id: z.number().int().nullable(),
  due: date.nullable(),
  attendees: z.string().max(2000),
  what_happened: text,
  impact_summary: text,
  went_well: text,
  was_hard: text,
  lucky: text,
}).partial();
export const itemSchema = z.object({ kind: z.enum(ITEM_KINDS), body: z.string().trim().min(1).max(2000) });
export const itemProblemSchema = z.object({ problem: z.string().trim().max(20).optional() });
export const itemActionSchema = z.object({ title: z.string().trim().min(1).max(300).optional(), owner_id: z.number().int().nullable().optional(), due_date: date.nullable().optional(), problem: z.string().trim().max(20).optional() });
export const waiveSchema = z.object({ reason: z.string().trim().min(5).max(2000) });

/** The guide shown with the template: what each section is for, and blameless wording. */
export const REVIEW_GUIDE = {
  purpose: 'Learn from the incident, not find someone to blame. People acted sensibly on what they knew at the time; the review asks what made the outcome possible and what would make it less likely.',
  wording: 'Describe actions and conditions, not people: "the deploy ran without a canary" rather than "Erik forgot the canary". Ask "how did it make sense at the time?"',
  sections: {
    what_happened: 'What happened, in order. It starts from the timeline; add what people knew and decided.',
    impact_summary: 'Who and what was affected, for how long. It starts from the services, CIs, people and SLAs Kernel knows.',
    went_well: 'What helped: detection, people, tools, a workaround.',
    was_hard: 'What slowed the response down or confused people.',
    lucky: 'Where it could have been worse: near misses worth fixing before they bite.',
  },
};

/**
 * N working days after a date, by a business calendar: a day counts when it has opening hours and is not a holiday
 * (Swedish holidays and eves included where the calendar says so). Without a calendar, Monday to Friday.
 */
export function addWorkingDays(from: Date, days: number, cal?: { always: boolean; hours: Record<string, [number, number][]>; holidays: Set<string> }) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  for (let n = 0, guard = 0; n < days && guard < 400; guard++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.toISOString().slice(0, 10);
    const iso = String(((d.getUTCDay() + 6) % 7) + 1);
    const open = cal ? (cal.always || (cal.hours[iso] ?? []).length > 0) && !cal.holidays.has(day) : d.getUTCDay() !== 0 && d.getUTCDay() !== 6;
    if (open) n++;
  }
  return d.toISOString().slice(0, 10);
}

/** The incident's SLA calendar, else the default SLA's, for counting working days. */
async function calendarForIncident(db: Db, incidentId: number) {
  const { rows } = await db.query(
    `SELECT coalesce((SELECT s.calendar_id FROM incidents i JOIN slas s ON s.id = i.sla_id WHERE i.id = $1),
                     (SELECT calendar_id FROM slas WHERE is_default ORDER BY id LIMIT 1)) AS id`,
    [incidentId],
  );
  return rows[0]?.id ? loadCalendar(db, rows[0].id) : undefined;
}

const fmtTime = (d: Date | string) => new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const fmtDuration = (ms: number) => {
  const min = Math.round(ms / 60_000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
};

/** What Kernel already knows about the impact, as facts the team can edit. */
async function impactFacts(user: User, ref: string) {
  const i: any = await getIncident(user, ref);
  const end = i.resolved_at ?? new Date();
  const facts: string[] = [];
  facts.push(`- Duration: ${fmtDuration(new Date(end).getTime() - new Date(i.created_at).getTime())} (logged ${fmtTime(i.created_at)}${i.resolved_at ? `, resolved ${fmtTime(i.resolved_at)}` : ', still open'})`);
  if (i.major?.declared_at) facts.push(`- Major incident from ${fmtTime(i.major.declared_at)}`);
  if (i.affected_services.length) facts.push(`- Services: ${i.affected_services.map((s: any) => s.name).join(', ')}`);
  if (i.affected_cis.length) facts.push(`- CIs: ${i.affected_cis.map((c: any) => c.name).join(', ')}`);
  const orgs = [...new Set((i.affected_people ?? []).map((p: any) => p.organisation).filter(Boolean))];
  if (i.affected_people?.length) facts.push(`- People recorded as affected: ${i.affected_people.length}${orgs.length ? ` (${orgs.join(', ')})` : ''}`);
  if (i.children?.length) facts.push(`- Related incidents: ${i.children.length} (${i.children.map((c: any) => c.ref).join(', ')})`);
  if (i.sla) facts.push(`- SLA ${i.sla.name}: response ${i.sla.response.state.replace('_', ' ')}, resolution ${i.sla.resolution.state.replace('_', ' ')}`);
  if (i.possible_change_causes?.length) facts.push(`- Changes shortly before: ${i.possible_change_causes.map((c: any) => `${c.ref} on ${c.ci_name} (started ${fmtTime(c.started_at)})`).join('; ')}`);
  if (i.alerts?.length) facts.push(`- Monitoring alerts: ${i.alerts.length} from ${[...new Set(i.alerts.map((a: any) => a.source))].join(', ')}`);
  return { incident: i, text: facts.join('\n') };
}

/**
 * The prefill uses the full timeline, whoever opens the review first: the review's fields are masked when read
 * (MASKED_FIELDS), so a confidential incident's text is stored once and shown only to those who may read it.
 */
async function prefill(user: User, ref: string) {
  const t = await timeline(user, ref, { full: true });
  const story = t.entries.map((e) => `- ${fmtTime(e.at)} ${e.label}${e.body ? `: ${e.body.split('\n')[0].slice(0, 200)}` : ''}`).join('\n');
  const { text: impact } = await impactFacts(user, ref);
  return { what_happened: story, impact_summary: impact };
}

async function loadReview(db: Db, incidentRef: string, lock = false) {
  const { rows } = await db.query(
    `SELECT r.*, r.due::text AS due, i.ref, i.title AS incident_title, i.is_major, i.major_lead_id, i.problem_id, i.impact, i.urgency, i.category_id, i.status AS incident_status,
            i.restricted, i.restricted_teams, i.classification
     FROM incident_reviews r JOIN incidents i ON i.id = r.incident_id WHERE i.ref = $1 ${lock ? 'FOR UPDATE OF r' : ''}`,
    [incidentRef.toUpperCase()],
  );
  if (!rows[0]) throw notFound(`${incidentRef.toUpperCase()} has no post-incident review`);
  return rows[0];
}

/** Owner, lead or a manager may finish the review; anyone working on incidents may contribute to it. */
const mayFinish = (user: User, r: any) => r.owner_id === user.id || r.major_lead_id === user.id || can(user.role, 'incident.flag_major');
const isOpenReview = (r: { status: string }) => r.status === 'scheduled' || r.status === 'draft';

/**
 * Schedules the review when an incident is resolved (the caller's transaction): the owner asked for, else the lead,
 * else the person resolving; due in five working days unless a date was given. A second resolve keeps the review.
 */
export async function scheduleReviewInTx(db: Db, actorId: number, incident: { id: number; major_lead_id?: number | null }, input: { owner_id?: number | null; due?: string | null }) {
  if (input.owner_id) {
    const { rows } = await db.query("SELECT 1 FROM users WHERE id = $1 AND active AND role NOT IN ('viewer', 'integration')", [input.owner_id]);
    if (!rows[0]) throw badRequest('The review owner must be an active user who can work on incidents');
  }
  const owner = input.owner_id ?? incident.major_lead_id ?? actorId;
  const due = input.due ?? addWorkingDays(new Date(), 5, await calendarForIncident(db, incident.id));
  const { rows } = await db.query(
    `INSERT INTO incident_reviews (incident_id, owner_id, due, created_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (incident_id) DO UPDATE SET owner_id = CASE WHEN $5 THEN excluded.owner_id ELSE incident_reviews.owner_id END,
       due = CASE WHEN $6 THEN excluded.due ELSE incident_reviews.due END, updated_at = now()
     RETURNING id, owner_id, due::text AS due, (xmax = 0) AS created`,
    [incident.id, owner, due, actorId, input.owner_id !== undefined && input.owner_id !== null, !!input.due],
  );
  return rows[0] as { id: number; owner_id: number; due: string; created: boolean };
}

/** The review summary the incident page and lists show. */
export async function reviewSummary(incidentId: number) {
  const { rows } = await query(
    `SELECT r.status, r.owner_id, u.display_name AS owner, r.due::text AS due, r.published_at,
            (r.due - current_date) AS due_in_days, (r.status IN ('scheduled', 'draft') AND r.due < current_date) AS overdue
     FROM incident_reviews r LEFT JOIN users u ON u.id = r.owner_id WHERE r.incident_id = $1`,
    [incidentId],
  );
  return rows[0] ?? null;
}

// ---- Reading ---------------------------------------------------------------------------------

export async function getReview(user: User, ref: string) {
  authorize(user, 'incident.read');
  const r = await loadReview({ query } as unknown as Db, ref);
  const [items, owner, t, facts] = await Promise.all([
    query(
      `SELECT x.id, x.kind, x.body, x.created_at, u.display_name AS created_by, p.ref AS problem_ref, p.title AS problem_title, p.status AS problem_status,
              a.id AS action_id, a.title AS action_title, a.status AS action_status, a.due_date::text AS action_due, o.display_name AS action_owner, ap.ref AS action_problem_ref
       FROM incident_review_items x LEFT JOIN users u ON u.id = x.created_by LEFT JOIN problems p ON p.id = x.problem_id
       LEFT JOIN problem_actions a ON a.id = x.action_id LEFT JOIN users o ON o.id = a.owner_id LEFT JOIN problems ap ON ap.id = a.problem_id
       WHERE x.review_id = $1 ORDER BY x.kind, x.id`,
      [r.id],
    ),
    query('SELECT id, display_name FROM users WHERE id = ANY($1)', [[r.owner_id, r.published_by].filter(Boolean)]),
    timeline(user, ref),
    impactFacts(user, ref),
  ]);
  const name = (id: number | null) => owner.rows.find((u) => u.id === id)?.display_name ?? null;
  const dueIn = r.due ? Math.round((Date.parse(r.due) - Date.parse(new Date().toISOString().slice(0, 10))) / 86400_000) : null;
  return {
    ref: r.ref, incident_title: r.incident_title, is_major: r.is_major, incident_status: r.incident_status,
    status: r.status, owner_id: r.owner_id, owner: name(r.owner_id), due: r.due ?? null,
    due_in_days: dueIn, overdue: isOpenReview(r) && dueIn !== null && dueIn < 0,
    attendees: r.attendees, what_happened: r.what_happened, impact_summary: r.impact_summary, went_well: r.went_well, was_hard: r.was_hard, lucky: r.lucky,
    waived_reason: r.waived_reason, published_at: r.published_at, published_by: name(r.published_by),
    items: items.rows,
    may_finish: mayFinish(user, r),
    context: { timeline: t.entries, impact: facts.text, problem_ref: facts.incident.problem_ref ?? null },
    guide: REVIEW_GUIDE,
    url: `/incidents/${r.ref}/review`,
  };
}

// ---- Changing --------------------------------------------------------------------------------

/** A review for any incident (major ones get one when resolved). */
export async function createReview(user: User, ref: string, input: z.infer<typeof createReviewSchema>) {
  authorize(user, 'incident.update');
  const fill = await prefill(user, ref);
  await tx(async (db) => {
    const { rows } = await db.query('SELECT id, ref, major_lead_id FROM incidents WHERE ref = $1 FOR UPDATE', [ref.toUpperCase()]);
    if (!rows[0]) throw notFound(`Incident ${ref} not found`);
    const { rows: existing } = await db.query('SELECT 1 FROM incident_reviews WHERE incident_id = $1', [rows[0].id]);
    if (existing[0]) throw conflict(`${rows[0].ref} already has a post-incident review`);
    const r = await scheduleReviewInTx(db, user.id, rows[0], input);
    await db.query('UPDATE incident_reviews SET what_happened = $2, impact_summary = $3 WHERE id = $1', [r.id, fill.what_happened, fill.impact_summary]);
    await logIncident(db, rows[0].id, user.id, 'update', 'Scheduled a post-incident review', { review: { owner_id: r.owner_id, due: r.due } });
  });
  return getReview(user, ref);
}

/** Fills in a scheduled review the first time it is opened for editing, so nobody retypes what Kernel knows. */
async function ensureFilled(user: User, ref: string) {
  const { rows } = await query("SELECT r.id FROM incident_reviews r JOIN incidents i ON i.id = r.incident_id WHERE i.ref = $1 AND r.what_happened = '' AND r.impact_summary = '' AND r.status = 'scheduled'", [ref.toUpperCase()]);
  if (!rows[0]) return;
  const fill = await prefill(user, ref);
  await query("UPDATE incident_reviews SET what_happened = $2, impact_summary = $3 WHERE id = $1 AND what_happened = '' AND impact_summary = ''", [rows[0].id, fill.what_happened, fill.impact_summary]);
}

export async function openReview(user: User, ref: string) {
  authorize(user, 'incident.read');
  if (can(user.role, 'incident.update')) await ensureFilled(user, ref);
  return getReview(user, ref);
}

export async function updateReview(user: User, ref: string, input: z.infer<typeof updateReviewSchema>) {
  authorize(user, 'incident.update');
  await ensureFilled(user, ref);
  await tx(async (db) => {
    const r = await loadReview(db, ref, true);
    if (!isOpenReview(r)) throw conflict(`The review is ${r.status}: it can no longer be edited`);
    if ((input.owner_id !== undefined || input.due !== undefined) && !mayFinish(user, r)) throw forbidden('Only the review owner, the incident lead or a manager can change the owner or the date');
    if (input.owner_id) {
      const { rows } = await db.query("SELECT 1 FROM users WHERE id = $1 AND active AND role NOT IN ('viewer', 'integration')", [input.owner_id]);
      if (!rows[0]) throw badRequest('The review owner must be an active user who can work on incidents');
    }
    const changed = Object.entries(input).filter(([k, v]) => v !== undefined && String(r[k] ?? '') !== String(v ?? ''));
    if (!changed.length) return;
    await db.query(
      `UPDATE incident_reviews SET ${changed.map(([k], n) => `${k} = $${n + 2}`).join(', ')}, status = CASE WHEN status = 'scheduled' THEN 'draft' ELSE status END, updated_at = now() WHERE id = $1`,
      [r.id, ...changed.map(([, v]) => v)],
    );
    // Who changed which sections, not the text itself.
    await audit(db, { entity_type: 'incident_review', entity_ref: r.ref, action: 'update', changes: { fields: changed.map(([k]) => k) } });
  });
  return getReview(user, ref);
}

export async function addItem(user: User, ref: string, input: z.infer<typeof itemSchema>) {
  authorize(user, 'incident.update');
  await tx(async (db) => {
    const r = await loadReview(db, ref, true);
    if (!isOpenReview(r)) throw conflict(`The review is ${r.status}: it can no longer be edited`);
    await db.query('INSERT INTO incident_review_items (review_id, kind, body, created_by) VALUES ($1, $2, $3, $4)', [r.id, input.kind, input.body, user.id]);
    await db.query("UPDATE incident_reviews SET status = CASE WHEN status = 'scheduled' THEN 'draft' ELSE status END, updated_at = now() WHERE id = $1", [r.id]);
  });
  return getReview(user, ref);
}

export async function removeItem(user: User, ref: string, itemId: number) {
  authorize(user, 'incident.update');
  await tx(async (db) => {
    const r = await loadReview(db, ref, true);
    if (!isOpenReview(r)) throw conflict(`The review is ${r.status}: it can no longer be edited`);
    // A factor that became a problem, or a follow-up that became an action, stays: the link is the trace.
    const { rows } = await db.query('DELETE FROM incident_review_items WHERE id = $1 AND review_id = $2 AND problem_id IS NULL AND action_id IS NULL RETURNING id', [itemId, r.id]);
    if (!rows[0]) throw conflict('Only an item that has not become a problem or an action can be removed');
  });
  return getReview(user, ref);
}

/**
 * Contributing factor → problem: a new problem with the factor as its statement, or an existing one, linked both ways.
 * A new problem is as narrow as the incident (restricted, confidential); an existing, broader one gets the link but
 * not the factor's text.
 */
export async function itemToProblem(user: User, ref: string, itemId: number, input: z.infer<typeof itemProblemSchema>) {
  authorize(user, 'incident.update');
  authorize(user, 'problem.link');
  await tx(async (db) => {
    const r = await loadReview(db, ref, true);
    // The item stays locked while the problem is created, so two clicks cannot make two problems.
    const { rows: items } = await db.query('SELECT * FROM incident_review_items WHERE id = $1 AND review_id = $2 FOR UPDATE', [itemId, r.id]);
    const item = items[0];
    if (!item) throw notFound('Review item not found');
    if (item.kind !== 'factor') throw badRequest('Only a contributing factor becomes a problem; a follow-up becomes an action');
    if (item.problem_id) throw conflict('This factor already has a problem');
    let problemRef = input.problem?.toUpperCase();
    const created = !problemRef;
    const from = await audienceOf(db, r.ref);
    if (!problemRef) {
      // In this transaction and as narrow as the incident from the start, so no notice, webhook or event about the
      // new problem ever goes out while it is broader than its source.
      // A confidential record's title stays readable to everyone (#61), so the factor's words become one only when the
      // title is as narrow as the factor.
      const narrow = startNarrow(from);
      problemRef = await createProblemInTx(db, user, {
        title: (await copyText(db, from, titleAudience({ ...from, ref: null }), item.body.split('\n')[0], `Contributing factor from the post-incident review of ${r.ref}`, 'review factor → problem title')).slice(0, 300),
        description: `Contributing factor from the post-incident review of ${r.ref} (${r.incident_title}):\n\n${item.body}`,
        impact: r.impact, urgency: r.urgency, ...(r.category_id ? { category_id: r.category_id } : {}),
      }, narrow);
    }
    const problem = await loadForUpdate(db, problemRef!);
    const wide = !created && !mayCopyText(from, await audienceOf(db, problem.ref));
    await db.query('UPDATE incident_review_items SET problem_id = $2 WHERE id = $1', [item.id, problem.id]);
    await db.query(
      `INSERT INTO problem_links (problem_id, kind, reference, system, note, created_by) VALUES ($1, 'incident', $2, 'Kernel', $3, $4) ON CONFLICT DO NOTHING`,
      [problem.id, r.ref, `From the post-incident review of ${r.ref}`, user.id],
    );
    // An existing problem more people can read gets the reference, never the factor's words.
    // The history (and every webhook summary made from it) names the review, never the factor's words.
    await logActivity(db, problem.id, user.id, 'link', `${wide ? 'Linked from' : 'A contributing factor from'} the post-incident review of ${r.ref}`, { kind: 'incident', reference: r.ref, system: 'Kernel', action: 'add', review_item: item.id });
    await logIncident(db, r.incident_id, user.id, 'link', `Contributing factor → problem ${problem.ref}`, { kind: 'problem', reference: problem.ref, action: 'add', review_item: item.id });
    // The incident needs a problem before it closes: the first factor's problem is it, unless it has one.
    if (!r.problem_id) await db.query('UPDATE incidents SET problem_id = $2 WHERE id = $1 AND problem_id IS NULL', [r.incident_id, problem.id]);
  });
  return getReview(user, ref);
}

/** Follow-up → action on a problem: the one named, the factor's, or the incident's. */
export async function itemToAction(user: User, ref: string, itemId: number, input: z.infer<typeof itemActionSchema>) {
  authorize(user, 'incident.update');
  authorize(user, 'action.write');
  await tx(async (db) => {
    const r = await loadReview(db, ref, true);
    const { rows: items } = await db.query('SELECT * FROM incident_review_items WHERE id = $1 AND review_id = $2 FOR UPDATE', [itemId, r.id]);
    const item = items[0];
    if (!item) throw notFound('Review item not found');
    if (item.kind === 'factor') throw badRequest('A contributing factor becomes a problem; add the follow-up as its own item');
    if (item.action_id) throw conflict('This follow-up already has an action');
    let problemId: number | null = null;
    if (input.problem) problemId = (await loadForUpdate(db, input.problem)).id;
    else {
      const { rows: factor } = await db.query("SELECT problem_id FROM incident_review_items WHERE review_id = $1 AND kind = 'factor' AND problem_id IS NOT NULL ORDER BY id LIMIT 1", [r.id]);
      problemId = factor[0]?.problem_id ?? r.problem_id;
    }
    if (!problemId) throw badRequest('Actions live on a problem: turn a contributing factor into a problem first, or name one');
    const { rows: p } = await db.query('SELECT id, ref, restricted, classification FROM problems WHERE id = $1 FOR UPDATE', [problemId]);
    // On a problem more people can read, the action says where it came from but not what the review said.
    const wide = !mayCopyText(await audienceOf(db, r.ref), await audienceOf(db, p[0].ref));
    if (wide && !input.title) throw badRequest(`${p[0].ref} is readable by more people than ${r.ref}: give the action a title of its own`);
    const actionId = await insertAction(db, user, p[0], {
      title: (input.title ?? item.body.split('\n')[0]).slice(0, 300),
      description: wide ? `Follow-up from the post-incident review of ${r.ref}.` : `Follow-up from the post-incident review of ${r.ref}:\n\n${item.body}`,
      ...(input.owner_id !== undefined ? { owner_id: input.owner_id } : {}),
      ...(input.due_date !== undefined ? { due_date: input.due_date } : {}),
    });
    await db.query('UPDATE incident_review_items SET action_id = $2 WHERE id = $1', [item.id, actionId]);
    await logIncident(db, r.incident_id, user.id, 'link', `Follow-up → action on ${p[0].ref}`, { kind: 'problem', reference: p[0].ref, action: 'add', review_item: item.id, action_id: actionId });
  });
  return getReview(user, ref);
}

export async function publishReview(user: User, ref: string) {
  authorize(user, 'incident.update');
  await tx(async (db) => {
    const r = await loadReview(db, ref, true);
    if (!isOpenReview(r)) throw conflict(`The review is already ${r.status}`);
    if (!mayFinish(user, r)) throw forbidden('Only the review owner, the incident lead or a manager can publish the review');
    const missing = [['what_happened', 'what happened'], ['impact_summary', 'the impact']].filter(([k]) => !String(r[k]).trim()).map(([, l]) => l);
    if (missing.length) throw conflict(`Describe ${missing.join(' and ')} before publishing`);
    await db.query("UPDATE incident_reviews SET status = 'published', published_at = now(), published_by = $2, updated_at = now() WHERE id = $1", [r.id, user.id]);
    await logIncident(db, r.incident_id, user.id, 'update', 'Published the post-incident review', { review: { status: { from: r.status, to: 'published' } } });
  });
  return getReview(user, ref);
}

/** Waiving takes a manager and a reason, and is audited (#57). */
export async function waiveReview(user: User, ref: string, input: z.infer<typeof waiveSchema>) {
  authorize(user, 'incident.flag_major');
  await tx(async (db) => {
    const r = await loadReview(db, ref, true);
    if (!isOpenReview(r)) throw conflict(`The review is already ${r.status}`);
    await db.query("UPDATE incident_reviews SET status = 'waived', waived_reason = $2, updated_at = now() WHERE id = $1", [r.id, input.reason]);
    await logIncident(db, r.incident_id, user.id, 'update', `Waived the post-incident review: ${input.reason}`, { review: { status: { from: r.status, to: 'waived' }, reason: input.reason } });
  });
  return getReview(user, ref);
}

/** The lessons as a draft knowledge article (#47), for a person to edit and publish. */
export async function reviewToArticle(user: User, ref: string) {
  const refusal = whyNotForEveryone(await audienceOf(null, ref), 'an article');
  if (refusal) throw badRequest(refusal);
  const r = await getReview(user, ref);
  const sections = [
    ['What happened', r.what_happened], ['What went well', r.went_well], ['What was hard', r.was_hard], ['Where we were lucky', r.lucky],
    ['Contributing factors', r.items.filter((x: any) => x.kind === 'factor').map((x: any) => `- ${x.body}`).join('\n')],
  ].filter(([, v]) => String(v).trim());
  const body = `Lessons from the post-incident review of ${r.ref}.\n\n${sections.map(([h, v]) => `## ${h}\n\n${v}`).join('\n\n')}`;
  const { rows } = await query('SELECT id FROM incidents WHERE ref = $1', [r.ref]);
  return createArticle(user, { title: `Lessons from ${r.ref}: ${r.incident_title}`.slice(0, 200), body, article_type: 'troubleshooting', audience: 'internal' }, { incidentId: rows[0].id });
}

export async function reviewMarkdown(user: User, ref: string) {
  const r = await getReview(user, ref);
  const masked = (await maskedRefs(currentContext().channel === 'mcp' ? null : user, [r.ref])).has(r.ref);
  const section = (h: string, v: string) => `## ${h}\n\n${masked ? '_Confidential._' : v.trim() || '–'}\n`;
  const items = (kind: string, title: string) => {
    const list = r.items.filter((x: any) => x.kind === kind);
    return list.length ? `## ${title}\n\n${list.map((x: any) => `- ${masked ? '_Confidential._' : x.body}${x.problem_ref ? ` → ${x.problem_ref}` : ''}${x.action_id ? ` → action on ${x.action_problem_ref}${x.action_owner ? ` (${x.action_owner}${x.action_due ? `, ${x.action_due}` : ''})` : ''}` : ''}`).join('\n')}\n` : '';
  };
  return [
    `# Post-incident review: ${r.ref} ${r.incident_title}`, '',
    `Status: ${r.status}${r.owner ? ` · Owner: ${r.owner}` : ''}${r.due ? ` · Due: ${r.due}` : ''}${r.published_at ? ` · Published ${new Date(r.published_at).toISOString().slice(0, 10)}${r.published_by ? ` by ${r.published_by}` : ''}` : ''}`, '',
    ...(r.attendees && !masked ? [`Attendees: ${r.attendees}`, ''] : []),
    section('What happened', r.what_happened), section('Impact', r.impact_summary), section('What went well', r.went_well),
    section('What was hard', r.was_hard), section('Where we were lucky', r.lucky),
    items('factor', 'Contributing factors'), items('follow_up', 'Follow-up'), items('gap', 'Detection and response gaps'),
  ].filter((l) => l !== '').join('\n');
}

// ---- Closing rule, My work and reports -------------------------------------------------------------

/** settings major_incident.review_required (default on): a major incident closes once its review is done. */
export async function reviewBlocksClosing(db: Db, incidentId: number) {
  const { rows: s } = await db.query("SELECT value FROM settings WHERE key = 'major_incident'");
  if (s[0]?.value?.review_required === false) return null;
  const { rows } = await db.query('SELECT status FROM incident_reviews WHERE incident_id = $1', [incidentId]);
  if (rows[0] && ['published', 'waived'].includes(rows[0].status)) return null;
  return 'A major incident closes once its post-incident review is published, or waived with a reason by a manager';
}

export async function myReviews(userId: number) {
  const { rows } = await query(
    `SELECT i.ref, i.title, r.status, r.due::text AS due, (r.due < current_date) AS overdue
     FROM incident_reviews r JOIN incidents i ON i.id = r.incident_id
     WHERE r.owner_id = $1 AND r.status IN ('scheduled', 'draft') ORDER BY r.due NULLS LAST LIMIT 30`,
    [userId],
  );
  return rows;
}

/** For reports: how many major incidents resolved in the period got a published review, and how fast. */
export async function reviewStats(from: string, to: string) {
  const { rows } = await query(
    `SELECT count(*)::int AS major_resolved,
            count(*) FILTER (WHERE r.status = 'published')::int AS reviewed,
            count(*) FILTER (WHERE r.status = 'waived')::int AS waived,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.published_at - i.resolved_at) / 86400) FILTER (WHERE r.published_at IS NOT NULL) AS median_days_to_review
     FROM incidents i LEFT JOIN incident_reviews r ON r.incident_id = i.id
     WHERE i.is_major AND i.resolved_at >= $1::date AND i.resolved_at < $2::date + 1`,
    [from, to],
  );
  const x = rows[0];
  return {
    major_resolved: x.major_resolved, reviewed: x.reviewed, waived: x.waived,
    reviewed_share: x.major_resolved ? Math.round((x.reviewed / x.major_resolved) * 100) : null,
    median_days_to_review: x.median_days_to_review === null ? null : Math.round(Number(x.median_days_to_review) * 10) / 10,
  };
}

// A problem that came out of a review says so ("from the post-incident review of INC…").
registerProblemExtra(async (p) => {
  const { rows } = await query(
    `SELECT DISTINCT i.ref AS incident_ref, i.title AS incident_title FROM incident_review_items x JOIN incident_reviews r ON r.id = x.review_id
     JOIN incidents i ON i.id = r.incident_id WHERE x.problem_id = $1`,
    [p.id],
  );
  return { from_reviews: rows };
});
