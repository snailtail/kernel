// Continual improvement register (#52): improvements (IMP000012) from post-incident reviews, problems, service
// reviews or anyone's idea. Lightweight on purpose: a title, value and effort, an owner, a manager's decision and the
// benefit it brought, linked to the changes, problems and actions that carry it out and to a dashboard KPI whose
// trend shows whether it worked. Shared by REST, MCP and the web UI.
import { z } from 'zod';
import { audienceOf, BROADEST, startNarrow, type Audience } from './audience.js';
import type { User } from './auth.js';
import { audit } from './audit.js';
import { assertMayWriteText, forgetExists, textFilterSql } from './confidential.js';
import { currentContext } from './context.js';
import { query, tx } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { kpis, TILES } from './kpis.js';
import { notify } from './notifications.js';
import { authorize, can } from './policy.js';
import { logActivity, registerProblemExtra, type Db, type StartNarrow } from './problems.js';
import { recordUrl, registerRecordType, typeForRef, type RecordType } from './records.js';
import { assertVisibleRef } from './visibility.js';

export const IMPROVEMENT_STATUSES = ['idea', 'approved', 'in_progress', 'done', 'rejected'] as const;
export const IMPROVEMENT_SOURCES = ['review', 'problem', 'service_review', 'idea'] as const;
/** The dashboard tiles an improvement can watch. */
export const TILES_FOR_IMPROVEMENTS = TILES;
const IMPROVEMENT_LINK_KINDS = ['change', 'problem', 'action', 'incident', 'review', 'document'] as const;
type Status = (typeof IMPROVEMENT_STATUSES)[number];

/** Where an improvement can go from each status; moves marked as decisions need improvement.approve. */
const TRANSITIONS: Record<Status, Status[]> = {
  idea: ['approved', 'rejected'],
  approved: ['in_progress', 'rejected', 'idea'],
  in_progress: ['done', 'approved'],
  done: ['in_progress'],
  rejected: ['idea'],
};
// Taking an approval back is a decision too.
const isDecision = (from: Status, to: Status) => (from === 'idea' && to === 'approved') || (from === 'approved' && to === 'idea') || to === 'rejected' || from === 'rejected';

/** The ITIL 4 continual improvement model, short, for guided mode (#37): the empty list and the create form. */
export const IMPROVEMENT_MODEL = [
  'What is the vision, and where are we now? Name the service and what hurts, with a number if you have one.',
  'Where do we want to be, and how do we get there? Rate value and effort; quick wins first.',
  'Take action: link the changes, problems and actions that carry it out.',
  'Did we get there? Write down the benefit, and watch the linked KPI to keep the momentum going.',
];

const rating = z.number().int().min(1).max(5).nullable();
const fields = {
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20000),
  owner_id: z.number().int().nullable(),
  /** The service (a CI of class service) by ref. */
  service: z.string().trim().max(30).nullable(),
  value: rating,
  effort: rating,
  kpi: z.enum(TILES).nullable(),
  benefit: z.string().max(20000),
};
export const createImprovementSchema = z.object({
  ...fields,
  source: z.enum(IMPROVEMENT_SOURCES).default('idea'),
  /** The record it came from: a review, a problem, or for a service review the service. */
  source_ref: z.string().trim().max(30).nullable().optional(),
}).partial().required({ title: true });
export const updateImprovementSchema = z.object(fields).partial();
export const transitionImprovementSchema = z.object({
  to: z.enum(IMPROVEMENT_STATUSES),
  /** Required for done (what it brought), unless it is already written down. */
  benefit: z.string().trim().max(20000).optional(),
  /** Required to reject. */
  reason: z.string().trim().max(2000).optional(),
});
export const listImprovementsSchema = z.object({
  status: z.enum([...IMPROVEMENT_STATUSES, 'open', 'all']).default('open'),
  owner: z.union([z.literal('me'), z.literal('none'), z.coerce.number().int()]).optional(),
  service: z.string().trim().max(30).optional(),
  source: z.enum(IMPROVEMENT_SOURCES).optional(),
  /** Value 4–5 and effort 1–2: the matrix's top-left quadrant. */
  quick_wins: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(['updated', 'value', 'created']).default('updated'),
  bulk: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export const improvementLinkSchema = z.object({
  kind: z.enum(IMPROVEMENT_LINK_KINDS),
  reference: z.string().trim().min(1).max(200),
  system: z.string().trim().max(100).default(''),
  url: z.string().trim().max(2000).refine((v) => v === '' || /^https?:\/\//i.test(v), 'URL must start with http:// or https://').default(''),
  note: z.string().trim().max(2000).default(''),
});

async function logImprovement(db: Db, id: number, userId: number | null, kind: string, body = '', data: object = {}) {
  await db.query('INSERT INTO improvement_activity (improvement_id, user_id, kind, body, data, channel) VALUES ($1, $2, $3, $4, $5, $6)', [
    id, userId, kind, body, JSON.stringify(data), currentContext().channel,
  ]);
  const { rows } = await db.query('UPDATE improvements SET updated_at = now() WHERE id = $1 RETURNING ref', [id]);
  await audit(db, { entity_type: 'improvement', entity_ref: rows[0].ref, action: kind, changes: kind === 'comment' ? { body } : (data as Record<string, unknown>) });
}

async function loadImprovement(db: Db, ref: string) {
  const { rows } = await db.query('SELECT * FROM improvements WHERE ref = $1 FOR UPDATE', [ref.toUpperCase()]);
  if (!rows[0]) throw notFound(`Improvement ${ref.toUpperCase()} not found`);
  return rows[0];
}

async function validateOwner(db: Db, id: number | null | undefined) {
  if (id == null) return;
  const { rows } = await db.query("SELECT 1 FROM users WHERE id = $1 AND active AND role NOT IN ('viewer', 'integration')", [id]);
  if (!rows[0]) throw badRequest('The owner must be an active user who can work on improvements');
}

async function serviceId(db: Db, ref: string | null | undefined) {
  if (ref == null) return ref;
  const { rows } = await db.query("SELECT id FROM configuration_items WHERE ref = $1 AND class = 'service'", [ref.toUpperCase()]);
  if (!rows[0]) throw badRequest(`${ref.toUpperCase()} is not a service`);
  return rows[0].id as number;
}

// ---- Reading ---------------------------------------------------------------------------------

const SELECT = `
  SELECT m.*, CASE WHEN m.source_ref IS NOT NULL AND kernel_ref_hidden(m.source_ref) THEN NULL ELSE m.source_ref END AS shown_source_ref,
         o.display_name AS owner, c.display_name AS created_by_name, d.display_name AS decided_by_name, s.ref AS service_ref, s.name AS service_name
  FROM improvements m LEFT JOIN users o ON o.id = m.owner_id LEFT JOIN users c ON c.id = m.created_by
  LEFT JOIN users d ON d.id = m.decided_by LEFT JOIN configuration_items s ON s.id = m.service_id`;

export async function getImprovement(user: User, ref: string) {
  authorize(user, 'improvement.read');
  const { rows } = await query(`${SELECT} WHERE m.ref = $1`, [ref.toUpperCase()]);
  const m = rows[0];
  if (!m) throw notFound(`Improvement ${ref.toUpperCase()} not found`);
  const [activity, links] = await Promise.all([
    query(
      `SELECT a.id, a.kind, a.body, a.data, a.channel, a.created_at, u.display_name AS user_name
       FROM improvement_activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.improvement_id = $1 ORDER BY a.created_at DESC, a.id DESC`,
      [m.id],
    ),
    linksOf(m.id),
  ]);
  const { search: _s, service_id: _sid, shown_source_ref, ...rest } = m;
  const detail = {
    type: 'improvement',
    ...rest,
    // A source the viewer may not see is not named.
    source_ref: shown_source_ref,
    service: m.service_ref ? { ref: m.service_ref, name: m.service_name } : null,
    links,
    activity: activity.rows,
    kpi_tile: m.kpi ? await kpiTile(user, m.kpi) : null,
    may_decide: can(user.role, 'improvement.approve'),
    transitions: TRANSITIONS[m.status as Status].filter((to) => !isDecision(m.status, to) || can(user.role, 'improvement.approve')),
    url: improvementUrl(m.ref),
  };
  return { ...detail, next_steps: improvementGuidance(detail) };
}

/** The linked records with their titles and statuses as the viewer sees them; hidden refs are left out by RLS. */
async function linksOf(improvementId: number) {
  const { rows } = await query(
    `SELECT l.id, l.kind, l.reference, l.system, l.url, l.note, l.created_at,
            coalesce(p.title, c.title, i.title, a.title, ri.title) AS title, coalesce(p.status, c.status, i.status, a.status, r.status) AS status, ap.ref AS action_problem_ref
     FROM improvement_links l
     LEFT JOIN problems p ON l.kind = 'problem' AND l.system IN ('', 'Kernel') AND p.ref = l.reference
     LEFT JOIN changes c ON l.kind = 'change' AND l.system IN ('', 'Kernel') AND c.ref = l.reference
     LEFT JOIN incidents i ON l.kind = 'incident' AND l.system IN ('', 'Kernel') AND i.ref = l.reference
     LEFT JOIN incident_reviews r ON l.kind = 'review' AND r.ref = l.reference LEFT JOIN incidents ri ON ri.id = r.incident_id
     LEFT JOIN problem_actions a ON l.kind = 'action' AND a.id::text = l.reference LEFT JOIN problems ap ON ap.id = a.problem_id
     WHERE l.improvement_id = $1 AND (l.kind <> 'action' OR a.id IS NOT NULL) ORDER BY l.kind, l.created_at`,
    [improvementId],
  );
  return rows;
}

/** The linked dashboard tile (read-only, the dashboard's own rights): its trend shows whether it worked. */
async function kpiTile(user: User, id: string) {
  if (!can(user.role, 'report.read')) return null;
  const k = await kpis(user, { period: 'month' });
  const t = k.tiles.find((x) => x.id === id);
  return t ? { id: t.id, label: t.label, value: t.value, unit: t.unit, trend: t.trend, trend_label: t.trend_label, lower_is_better: t.lower_is_better, starts: k.period.starts, link: t.link } : null;
}

/** Guided mode (#37): where the improvement stands in the continual improvement model. */
function improvementGuidance(m: { status: string; description: string; value: number | null; effort: number | null; owner_id: number | null; links: unknown[]; benefit: string; kpi: string | null }) {
  const steps = [
    { id: 'describe', label: 'Describe where we are and where we want to be', hint: 'The service, what hurts, and a number if you have one.', done: !!m.description.trim() },
    { id: 'rate', label: 'Rate value and effort', hint: 'Value 5 and effort 1 is a quick win; the matrix shows them top left.', done: m.value !== null && m.effort !== null },
    { id: 'decide', label: 'A manager approves or rejects it', hint: 'Approve what is worth doing now; reject with a reason so the idea is not lost.', done: m.status !== 'idea' },
    { id: 'owner', label: 'Give it an owner', hint: 'One person who sees it through.', done: m.owner_id !== null },
    { id: 'act', label: 'Link the changes, problems or actions that carry it out', hint: 'The work happens there; the improvement keeps the why.', done: m.links.length > 0 },
    { id: 'benefit', label: 'Write down the benefit and close it', hint: m.kpi ? 'Compare with the linked KPI trend.' : 'Link a KPI to see whether it worked.', done: m.status === 'done' },
  ];
  if (m.status === 'rejected') return { phase: 'Rejected', purpose: 'Kept with its reason, so the idea can be picked up again.', steps: [], next: 'Nothing pending.' };
  return {
    phase: m.status === 'idea' ? 'Idea' : m.status === 'done' ? 'Done' : m.status === 'approved' ? 'Approved' : 'In progress',
    purpose: 'Continual improvement: small, measurable steps towards a better service.',
    steps,
    next: m.status === 'done' ? 'Nothing pending.' : (steps.find((s) => !s.done)?.label ?? 'Close it with the benefit'),
  };
}

export async function listImprovements(user: User, f: z.infer<typeof listImprovementsSchema>) {
  authorize(user, 'improvement.read');
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll('?', `$${params.length}`)); };
  if (f.status === 'open') where.push("m.status IN ('idea', 'approved', 'in_progress')");
  else if (f.status !== 'all') add('m.status = ?', f.status);
  if (f.owner === 'none') where.push('m.owner_id IS NULL');
  else if (f.owner !== undefined) add('m.owner_id = ?', f.owner === 'me' ? user.id : f.owner);
  if (f.service) add('s.ref = ?', f.service.toUpperCase());
  if (f.source) add('m.source = ?', f.source);
  if (f.quick_wins) where.push('m.value >= 4 AND m.effort <= 2');
  if (f.bulk) add('m.ref IN (SELECT unnest(refs) FROM bulk_requests WHERE id = ?)', f.bulk);
  if (f.q) {
    const terms = f.q.split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}_.-]/gu, '')).filter(Boolean);
    if (terms.length) where.push(textFilterSql('m', 'improvement', terms.map((t) => `${t}:*`).join(' & '), params));
  }
  params.push(f.limit);
  const order = { updated: 'm.updated_at DESC', value: 'm.value DESC NULLS LAST, m.effort NULLS LAST, m.updated_at DESC', created: 'm.created_at DESC' }[f.sort];
  const { rows } = await query(
    `SELECT m.id, m.ref, m.title, m.status, m.source, CASE WHEN m.source_ref IS NOT NULL AND kernel_ref_hidden(m.source_ref) THEN NULL ELSE m.source_ref END AS source_ref, m.value, m.effort, m.kpi, m.owner_id, o.display_name AS owner,
            s.ref AS service_ref, s.name AS service_name, m.created_at, m.updated_at, m.done_at,
            (SELECT count(*) FROM improvement_links l WHERE l.improvement_id = m.id)::int AS links
     FROM improvements m LEFT JOIN users o ON o.id = m.owner_id LEFT JOIN configuration_items s ON s.id = m.service_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT $${params.length}`,
    params,
  );
  return rows.map(({ id: _, ...r }) => ({ type: 'improvement', ...r, url: improvementUrl(r.ref) }));
}

// ---- Changing --------------------------------------------------------------------------------

/**
 * In the caller's transaction, as narrow as the record it came from (`narrow`), so nothing about it reaches more
 * people than its source. The source stays in source_ref; links are for the work that carries it out.
 */
export async function createImprovementInTx(db: Db, user: User, input: z.infer<typeof createImprovementSchema>, narrow?: StartNarrow) {
  authorize(user, 'improvement.write');
  await validateOwner(db, input.owner_id);
  const service = await serviceId(db, input.service);
  const kpi = input.kpi ?? null;
  const { rows } = await db.query(
    `INSERT INTO improvements (title, description, source, source_ref, service_id, owner_id, value, effort, kpi, benefit, restricted, restricted_teams, classification, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id, ref`,
    [
      input.title, input.description ?? '', input.source ?? 'idea', input.source_ref?.toUpperCase() ?? null, service ?? null, input.owner_id ?? null,
      input.value ?? null, input.effort ?? null, kpi, input.benefit ?? '', narrow?.restricted ?? false, narrow?.restricted_teams ?? [], narrow?.classification ?? 'normal', user.id,
    ],
  );
  const m = rows[0] as { id: number; ref: string };
  await logImprovement(db, m.id, user.id, 'created', narrow?.from ? `Created from ${narrow.from}` : 'Created', { source: input.source ?? 'idea', source_ref: input.source_ref?.toUpperCase() ?? null, restricted: narrow?.restricted ?? false });
  if (narrow?.classification === 'confidential') forgetExists();
  return m;
}

/** The audience a new improvement starts with: as narrow as the Kernel record it came from. */
async function sourceAudience(db: Db | null, sourceRef: string | null | undefined): Promise<Audience> {
  if (!sourceRef || !/^(PRB|CHG|INC|PIR|IMP)\d{6}$/i.test(sourceRef)) return BROADEST;
  await assertVisibleRef(sourceRef);
  // A review is as narrow as its incident.
  if (/^PIR/i.test(sourceRef)) {
    const { rows } = await (db ?? { query }).query('SELECT i.ref FROM incident_reviews r JOIN incidents i ON i.id = r.incident_id WHERE r.ref = $1', [sourceRef.toUpperCase()]);
    if (!rows[0]) throw notFound(`${sourceRef.toUpperCase()} not found`);
    return { ...(await audienceOf(db, rows[0].ref)), ref: sourceRef.toUpperCase() };
  }
  return audienceOf(db, sourceRef);
}

export async function createImprovement(user: User, input: z.infer<typeof createImprovementSchema>) {
  authorize(user, 'improvement.write');
  const ref = await tx(async (db) => {
    const from = await sourceAudience(db, input.source_ref);
    return (await createImprovementInTx(db, user, input, from.ref ? startNarrow(from) : undefined)).ref;
  });
  return getImprovement(user, ref);
}

export async function updateImprovementLean(user: User, ref: string, input: z.infer<typeof updateImprovementSchema>): Promise<void> {
  authorize(user, 'improvement.write');
  // No blind overwrites of masked text (#61, #156).
  await assertMayWriteText(user, ref, input);
  await tx(async (db) => {
    const m = await loadImprovement(db, ref);
    if (input.owner_id !== undefined) await validateOwner(db, input.owner_id);
    const { service, ...rest } = input;
    const next: Record<string, unknown> = { ...rest };
    if (service !== undefined) next.service_id = await serviceId(db, service);
    if (next.benefit !== undefined && m.status === 'done' && !String(next.benefit).trim()) throw badRequest('A done improvement keeps its benefit');
    const changed = Object.entries(next).filter(([k, v]) => v !== undefined && (m[k] ?? null) !== (v ?? null));
    if (!changed.length) return;
    await db.query(`UPDATE improvements SET ${changed.map(([k], n) => `${k} = $${n + 2}`).join(', ')} WHERE id = $1`, [m.id, ...changed.map(([, v]) => v)]);
    const data = Object.fromEntries(changed.map(([k, v]) => [k, { from: m[k] ?? null, to: v ?? null }]));
    await logImprovement(db, m.id, user.id, 'update', `Updated ${changed.map(([k]) => k.replace('_id', '').replace('_', ' ')).join(', ')}`, data);
  });
}

export async function updateImprovement(...args: Parameters<typeof updateImprovementLean>) {
  await updateImprovementLean(...args);
  return getImprovement(args[0], args[1]);
}

export async function transitionImprovementLean(user: User, ref: string, input: z.infer<typeof transitionImprovementSchema>): Promise<void> {
  authorize(user, 'improvement.write');
  // No blind overwrites of masked text (#61, #156).
  await assertMayWriteText(user, ref, { benefit: input.benefit, reject_reason: input.reason });
  await tx(async (db) => {
    const m = await loadImprovement(db, ref);
    const from = m.status as Status;
    if (from === input.to) return;
    if (!TRANSITIONS[from].includes(input.to)) throw conflict(`An improvement cannot go from ${from.replace('_', ' ')} to ${input.to.replace('_', ' ')}`);
    if (isDecision(from, input.to)) authorize(user, 'improvement.approve');
    if (input.to === 'rejected' && !input.reason) throw badRequest('Give a reason for rejecting it, so the idea is not lost');
    const benefit = input.benefit ?? m.benefit;
    if (input.to === 'done' && !benefit.trim()) throw badRequest('Write down the benefit it brought before closing it');
    await db.query(
      `UPDATE improvements SET status = $2, benefit = $3,
         reject_reason = CASE WHEN $2 = 'rejected' THEN $4 ELSE reject_reason END,
         decided_by = CASE WHEN $5 THEN $6 ELSE decided_by END, decided_at = CASE WHEN $5 THEN now() ELSE decided_at END,
         done_at = CASE WHEN $2 = 'done' THEN now() ELSE NULL END
       WHERE id = $1`,
      [m.id, input.to, benefit, input.reason ?? '', isDecision(from, input.to), user.id],
    );
    const label = { idea: 'Back to idea', approved: 'Approved', in_progress: 'Started', done: 'Done', rejected: 'Rejected' }[input.to];
    await logImprovement(db, m.id, user.id, 'status', input.to === 'rejected' ? `${label}: ${input.reason}` : input.to === 'done' ? `${label}: ${benefit}` : label, {
      status: { from, to: input.to }, ...(input.reason ? { reason: input.reason } : {}), ...(input.benefit !== undefined ? { benefit: input.benefit } : {}),
    });
    if (isDecision(from, input.to)) {
      await notify(db, {
        users: [m.owner_id, m.created_by], event: 'watched_update', ref: m.ref, title: `${m.ref} ${label.toLowerCase()}`, summary: m.title,
        path: `/improvements/${m.ref}`, dedupe: `improvement:${m.ref}:${input.to}:${Date.now()}`, actorId: user.id,
      });
    }
  });
}

export async function transitionImprovement(...args: Parameters<typeof transitionImprovementLean>) {
  await transitionImprovementLean(...args);
  return getImprovement(args[0], args[1]);
}

export async function addImprovementComment(user: User, ref: string, body: string) {
  authorize(user, 'improvement.write');
  if (!body.trim()) throw badRequest('Comment cannot be empty');
  await tx(async (db) => {
    const m = await loadImprovement(db, ref);
    await logImprovement(db, m.id, user.id, 'comment', body.trim());
  });
  return getImprovement(user, ref);
}

const KIND_OF_PREFIX: Record<string, (typeof IMPROVEMENT_LINK_KINDS)[number]> = { PRB: 'problem', CHG: 'change', INC: 'incident', PIR: 'review' };

export async function addImprovementLink(user: User, ref: string, input: z.infer<typeof improvementLinkSchema>) {
  authorize(user, 'improvement.write');
  const kernel = !input.system || input.system === 'Kernel';
  let reference = input.reference;
  if (kernel && input.kind === 'action') {
    // An action by its id; RLS hides the actions of problems the caller cannot see.
    const { rows } = await query('SELECT id FROM problem_actions WHERE id = $1', [/^\d+$/.test(reference) ? Number(reference) : 0]);
    if (!rows[0]) throw notFound(`Action ${reference} not found`);
  } else if (kernel && input.kind !== 'document') {
    reference = reference.toUpperCase();
    await assertVisibleRef(reference);
    if (KIND_OF_PREFIX[reference.slice(0, 3)] !== input.kind) throw badRequest(`${reference} is not a ${input.kind}`);
    typeForRef(reference);
  }
  await tx(async (db) => {
    const m = await loadImprovement(db, ref);
    const { rowCount } = await db.query(
      'INSERT INTO improvement_links (improvement_id, kind, reference, system, url, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING',
      [m.id, input.kind, reference, kernel && input.kind !== 'document' ? 'Kernel' : input.system, input.url, input.note, user.id],
    );
    if (!rowCount) throw conflict(`${input.kind} ${reference} is already linked`);
    await logImprovement(db, m.id, user.id, 'link', `Linked ${input.kind} ${reference}`, { kind: input.kind, reference, system: input.system, action: 'add' });
  });
  return getImprovement(user, ref);
}

export async function removeImprovementLink(user: User, ref: string, linkId: number) {
  authorize(user, 'improvement.write');
  await tx(async (db) => {
    const m = await loadImprovement(db, ref);
    const { rows } = await db.query('DELETE FROM improvement_links WHERE id = $1 AND improvement_id = $2 RETURNING kind, reference', [linkId, m.id]);
    if (!rows[0]) throw notFound('Link not found');
    await logImprovement(db, m.id, user.id, 'link', `Unlinked ${rows[0].kind} ${rows[0].reference}`, { ...rows[0], action: 'remove' });
  });
  return getImprovement(user, ref);
}

/**
 * Lessons learned → improvement, from a resolved or closed problem (optional, never required). It starts as narrow
 * as the problem; the title and description are the person's own words.
 */
export const fromProblemSchema = z.object({ title: z.string().trim().min(1).max(300), description: z.string().max(20000).default(''), owner_id: z.number().int().nullable().optional() });

export async function improvementFromProblem(user: User, problemRef: string, input: z.infer<typeof fromProblemSchema>) {
  authorize(user, 'improvement.write');
  authorize(user, 'problem.read');
  const ref = await tx(async (db) => {
    const { rows } = await db.query('SELECT id, ref, status, team_id FROM problems WHERE ref = $1 FOR UPDATE', [problemRef.toUpperCase()]);
    const p = rows[0];
    if (!p) throw notFound(`Problem ${problemRef.toUpperCase()} not found`);
    if (!['resolved', 'closed'].includes(p.status)) throw conflict('Lessons learned become an improvement once the problem is resolved or closed');
    const from = await audienceOf(db, p.ref);
    const m = await createImprovementInTx(db, user, { title: input.title, description: input.description, owner_id: input.owner_id, source: 'problem', source_ref: p.ref }, startNarrow(from));
    await logActivity(db, p.id, user.id, 'link', `Lessons learned → improvement ${m.ref}`, { kind: 'improvement', reference: m.ref, system: 'Kernel', action: 'add' });
    return m.ref;
  });
  return getImprovement(user, ref);
}

// ---- Bulk, My work ---------------------------------------------------------------------------

export async function improvementRows(ids: string[]) {
  return (await query('SELECT ref AS id, title, status, owner_id FROM improvements WHERE ref = ANY($1)', [ids.map((i) => i.toUpperCase())])).rows;
}

export async function myImprovements(userId: number) {
  const { rows } = await query(
    "SELECT ref, title, status, value, effort, updated_at FROM improvements WHERE owner_id = $1 AND status IN ('approved', 'in_progress') ORDER BY status DESC, updated_at DESC LIMIT 30",
    [userId],
  );
  return rows;
}

// A problem shows the improvements that came from it or are linked to it.
registerProblemExtra(async (p) => {
  const { rows } = await query(
    `SELECT DISTINCT m.ref, m.title, m.status FROM improvements m, problems p
     WHERE p.id = $1 AND (m.source_ref = p.ref OR EXISTS (SELECT 1 FROM improvement_links l WHERE l.improvement_id = m.id AND l.kind = 'problem' AND l.reference = p.ref))
     ORDER BY m.ref DESC LIMIT 50`,
    [p.id],
  );
  return { improvements: rows };
});

// ---- Registry (#35) ----------------------------------------------------------------------------

const IMPROVEMENT_TYPE: RecordType = {
  type: 'improvement',
  prefix: 'IMP',
  pattern: /^IMP\d{6}$/,
  readAction: 'improvement.read',
  uiPath: (ref) => `/improvements/${ref}`,
  get: getImprovement,
  search: async (user, q, limit) =>
    (await listImprovements(user, listImprovementsSchema.parse({ q, status: 'all', limit }))).map((m) => ({
      type: 'improvement', ref: m.ref, title: m.title, status: m.status, url: m.url, summary: [m.service_name, m.value && m.effort ? `value ${m.value}, effort ${m.effort}` : null].filter(Boolean).join(' · '),
    })),
  rest: {
    list: '/api/improvements',
    create: '/api/improvements',
    get: '/api/improvements/:ref',
    update: '/api/improvements/:ref',
    transition: '/api/improvements/:ref/transition',
    links: '/api/improvements/:ref/links',
    comments: '/api/improvements/:ref/comments',
  },
  mcp: { list: 'list_improvements', get: 'get_improvement', create: 'create_improvement', update: 'update_improvement', transition: 'transition_improvement' },
};
registerRecordType(IMPROVEMENT_TYPE);

function improvementUrl(ref: string) {
  return recordUrl(IMPROVEMENT_TYPE, ref);
}

