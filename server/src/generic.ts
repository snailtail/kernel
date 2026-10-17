// Cross-practice operations over the record type registry: one predictable surface for agents and scripts.
import { moduleEnabled } from './modules.js';
import { MASKED_FIELDS, maskedRefs, onlyTitleMatches } from './confidential.js';
import { currentContext } from './context.js';
import { z } from 'zod';
import { linkArticleCi } from './knowledge.js';
import { myTeams } from './teams.js';
import { assertVisibleRef } from './visibility.js';
import type { User } from './auth.js';
import { queryAudit } from './audit.js';
import { impact, impactSchema } from './cmdb-graph.js';
import { query } from './db.js';
import { badRequest } from './errors.js';
import { authorize, can } from './policy.js';
import { listApprovals } from './approvals.js';
import { addCiLink, CI_LINK_KINDS } from './cmdb.js';
import { linkCiToProblem } from './problem-cis.js';
import { addIncidentLink, linkIncidentToProblem, setIncidentCi } from './incidents.js';
import { addChangeLink, setChangeCi } from './changes.js';

const incidentExists = async (ref: string) => (await query('SELECT 1 FROM incidents WHERE ref = $1', [ref.toUpperCase()])).rows.length > 0;
import { addLink, LINK_KINDS, SELECT_ACTION } from './problems.js';
import { recordTypes, recordUrl, typeForRef, type SearchHit } from './records.js';
import { addReviewComment, attentionCount, incidentRefOf, myReviews } from './reviews.js';
import { addComment as addProblemComment } from './problems.js';
import { addIncidentComment } from './incidents.js';
import { addChangeComment } from './changes.js';
import { addArticleComment } from './knowledge.js';
import { addCiComment } from './cmdb.js';

export const searchSchema = z.object({
  q: z.string().trim().min(1).max(200),
  types: z.string().max(200).optional().describe('Comma-separated record types, e.g. "problem"'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Searches every record type the user may read. */
export async function search(user: User, input: z.infer<typeof searchSchema>): Promise<SearchHit[]> {
  const wanted = input.types?.split(',').map((t) => t.trim());
  const types = recordTypes().filter((t) => can(user.role, t.readAction) && (!wanted || wanted.includes(t.type)));
  const results = await Promise.all(types.map((t) => t.search(user, input.q, input.limit)));
  return (await onlyTitleMatches(currentContext().channel === 'mcp' ? null : user, results.flat(), input.q)).slice(0, input.limit);
}

/** Any record by its ref (the prefix selects the type). */
export async function getRecord(user: User, ref: string) {
  const t = typeForRef(ref);
  authorize(user, t.readAction);
  return t.get(user, ref.toUpperCase());
}

/**
 * Who changed what on any record, newest first, from the audit trail. Reading the record first applies the type's
 * read permission and visibility (RLS): a record you cannot open has no history for you either.
 */
export async function recordHistory(user: User, ref: string, limit = 100) {
  const t = typeForRef(ref);
  authorize(user, t.readAction);
  const record = await t.get(user, ref.toUpperCase());
  const refs = t.history?.refs?.(record) ?? [String(record.ref)];
  const rows = await queryAudit({ record: { entity_type: t.history?.entityType ?? t.type, refs, mentions: t.history?.mentions?.(record) ?? [] }, limit });
  // A confidential record's masked fields show that they changed, not to what (short values are kept readable in the
  // trail). Agents never read confidential text.
  const masked = (await maskedRefs(currentContext().channel === 'mcp' ? null : user, [String(record.ref)])).size > 0;
  return rows.map(({ user_agent, ip, ...e }) => masked
    ? { ...e, changes: Object.fromEntries(Object.entries(e.changes ?? {}).map(([k, v]) => [k, MASKED_FIELDS.has(k) ? { masked: true } : v])) }
    : e);
}

/** What is affected if a CI or service is down (the dependency graph, walking up to services). */
export async function getImpact(user: User, ref: string, input: z.input<typeof impactSchema> = {}) {
  const t = typeForRef(ref);
  if (t.type !== 'ci' && t.type !== 'service') throw badRequest(`Impact is for CIs and services; ${ref.toUpperCase()} is a ${t.type}`);
  return impact(user, ref, impactSchema.parse({ direction: 'up', ...input }));
}

export async function nextSteps(user: User, ref: string) {
  const record = await getRecord(user, ref);
  return { ref: record.ref, type: record.type, url: record.url, next_steps: record.next_steps ?? null };
}

export const linkBodySchema = z.object({ to: z.string().trim().min(1).max(200), kind: z.string().max(20).optional(), system: z.string().max(100).optional(), url: z.string().max(2000).optional(), note: z.string().max(2000).optional() });

/** A work note on any record, through its practice's own rules. */
export async function addComment(user: User, ref: string, body: string) {
  const type = typeForRef(ref).type;
  if (type === 'problem') await addProblemComment(user, ref, body);
  else if (type === 'incident') await addIncidentComment(user, ref, { body, kind: 'comment' });
  else if (type === 'change') await addChangeComment(user, ref, body);
  else if (type === 'article') await addArticleComment(user, ref, body);
  else if (type === 'review') await addReviewComment(user, ref, body);
  else await addCiComment(user, ref, body);
}

/** Links a record to another Kernel record or to an external record. */
export async function linkRecords(user: User, from: string, to: string, options: { kind?: string; system?: string; url?: string; note?: string }): Promise<unknown> {
  const source = typeForRef(from);
  if (!options.system || options.system === 'Kernel') await assertVisibleRef(to);
  let kind = options.kind;
  try {
    const target = typeForRef(to);
    kind ??= target.type;
  } catch {
    if (!kind) throw badRequest('Give the kind (incident, event, change, problem) for an external reference');
  }
  // A post-incident review shares its incident's links (#35): linking from or to a review links its incident.
  const kernelRef = !options.system || options.system === 'Kernel';
  if (source.type === 'review') return linkRecords(user, await incidentRefOf(from), to, options);
  if (kind === 'review' && kernelRef) return linkRecords(user, from, await incidentRefOf(to), { ...options, kind: 'incident' });
  // Knowledge articles (#47) apply to CIs and services.
  if (source.type === 'article') {
    if (kind !== 'ci' && kind !== 'service') throw badRequest('An article links to the CIs and services it applies to');
    return (await linkArticleCi(user, from, to, true)).cis;
  }
  // Native changes (#29): CIs they change, the problem they fix, links to PRs, pipelines and documents.
  const nativeChange = (ref: string) => { try { return typeForRef(ref).type === 'change' && !(options.system && options.system !== 'Kernel'); } catch { return false; } };
  if (source.type === 'change') {
    if (kind === 'ci' || kind === 'service') return (await setChangeCi(user, from, to, true)).affected_cis;
    if (!['change', 'incident', 'pull_request', 'pipeline', 'document'].includes(kind!)) throw badRequest(`A change cannot link a ${kind}`);
    return (await addChangeLink(user, from, { kind: kind as 'change', reference: to, system: options.system ?? '', url: options.url ?? '', note: options.note ?? '' })).links;
  }
  if (kind === 'change' && nativeChange(to) && (source.type === 'ci' || source.type === 'service')) return (await setChangeCi(user, to, from, true)).affected_cis;

  // Native incidents (#28): to a problem, to a CI, or to external references.
  const native = (ref: string) => { try { return typeForRef(ref).type === 'incident' && !(options.system && options.system !== 'Kernel'); } catch { return false; } };
  if (source.type === 'incident') {
    if (kind === 'problem') return (await linkIncidentToProblem(user, from, to)).problem_ref;
    if (kind === 'ci' || kind === 'service') return (await setIncidentCi(user, from, to, true)).affected_cis;
    if (!['incident', 'event', 'change', 'document'].includes(kind!)) throw badRequest(`An incident cannot link a ${kind}`);
    return (await addIncidentLink(user, from, { kind: kind as 'incident', reference: to, system: options.system ?? '', url: options.url ?? '', note: options.note ?? '' })).links;
  }
  if (kind === 'incident' && native(to) && (await incidentExists(to))) {
    if (source.type === 'problem') return (await linkIncidentToProblem(user, to, from)).problem_ref;
    if (source.type === 'ci' || source.type === 'service') return (await setIncidentCi(user, to, from, true)).affected_cis;
  }
  // A problem and a CI: the CI is affected by the problem (#26), whichever side the link starts from.
  if (kind === 'problem' && (source.type === 'ci' || source.type === 'service')) return (await linkCiToProblem(user, to, from)).affected_cis;
  if (source.type === 'problem' && (kind === 'ci' || kind === 'service')) return (await linkCiToProblem(user, from, to)).affected_cis;
  if (source.type === 'ci' || source.type === 'service') {
    if (!(CI_LINK_KINDS as readonly string[]).includes(kind!)) throw badRequest(`A CI cannot link a ${kind}; use a CI relationship instead`);
    return (await addCiLink(user, from, { kind: kind as (typeof CI_LINK_KINDS)[number], reference: to, system: options.system ?? '', url: options.url ?? '', note: options.note ?? '' })).links;
  }
  if (!(LINK_KINDS as readonly string[]).includes(kind!)) throw badRequest(`Unknown link kind ${kind}`);
  const result = await addLink(user, from, { kind: kind as (typeof LINK_KINDS)[number], reference: to, system: options.system ?? '', url: options.url ?? '', note: options.note ?? '' });
  return result.links;
}

/** What the user should work on: their open problems and actions, and recent changes on what they watch. */
export async function myWork(user: User) {
  const decide = can(user.role, 'problem.accept_risk');
  const [problems, actions, watched, decisions, incidents, changeVotes, myChanges] = await Promise.all([
    query(
      `SELECT ref, title, status, priority, updated_at FROM problems WHERE assignee_id = $1 AND status NOT IN ('resolved', 'closed') ORDER BY priority, updated_at DESC LIMIT 50`,
      [user.id],
    ),
    query(`${SELECT_ACTION} WHERE a.owner_id = $1 AND a.status = 'open' ORDER BY a.due_date NULLS LAST LIMIT 50`, [user.id]),
    query(
      `SELECT p.ref, p.title, a.kind, a.body, a.created_at, u.display_name AS by
       FROM problem_activity a JOIN problems p ON p.id = a.problem_id LEFT JOIN users u ON u.id = a.user_id
       JOIN problem_watchers w ON w.problem_id = a.problem_id AND w.user_id = $1
       WHERE a.user_id IS DISTINCT FROM $1 AND a.created_at > now() - interval '7 days' ORDER BY a.created_at DESC LIMIT 30`,
      [user.id],
    ),
    decide
      ? query(`SELECT ref, title, priority, known_error_at FROM problems WHERE status = 'known_error' AND coalesce(ec_decision, 'pending') = 'pending' ORDER BY priority, known_error_at LIMIT 30`)
      : Promise.resolve({ rows: [] as any[] }),
    can(user.role, 'incident.read')
      ? query(
          `SELECT ref, title, status, priority, is_major, created_at,
                  (is_major AND major_next_update_at < now()) AS update_overdue FROM incidents
           WHERE assignee_id = $1 AND status NOT IN ('resolved', 'closed') ORDER BY priority, created_at LIMIT 50`,
          [user.id],
        )
      : Promise.resolve({ rows: [] as any[] }),
    can(user.role, 'change.approve')
      ? query(
          `SELECT c.ref, c.title, c.change_type, c.planned_start FROM changes c WHERE c.status = 'authorize' AND c.created_by IS DISTINCT FROM $1 AND c.assignee_id IS DISTINCT FROM $1
           AND NOT EXISTS (SELECT 1 FROM change_votes v WHERE v.change_id = c.id AND v.user_id = $1) ORDER BY c.planned_start NULLS LAST LIMIT 30`,
          [user.id],
        )
      : Promise.resolve({ rows: [] as any[] }),
    can(user.role, 'change.read')
      ? query(
          `SELECT ref, title, status, change_type, planned_start FROM changes WHERE (assignee_id = $1 OR created_by = $1)
           AND status NOT IN ('closed', 'rejected', 'cancelled') ORDER BY planned_start NULLS LAST LIMIT 30`,
          [user.id],
        )
      : Promise.resolve({ rows: [] as any[] }),
  ]);
  // Major incidents I lead or communicate for (#108): the next stakeholder update, overdue first.
  const majorUpdates = can(user.role, 'incident.read')
    ? (await query(
        `SELECT ref, title, priority, major_next_update_at AS next_update_at, major_next_update_at < now() AS update_overdue,
                CASE WHEN major_comms_id = $1 THEN 'communications lead' ELSE 'incident lead' END AS role
         FROM incidents WHERE is_major AND status NOT IN ('resolved', 'closed') AND (major_lead_id = $1 OR major_comms_id = $1)
         ORDER BY major_next_update_at NULLS LAST LIMIT 20`,
        [user.id],
      )).rows
    : [];
  const reviews = can(user.role, 'incident.read') ? await myReviews(user.id) : [];
  const problemType = recordTypes().find((t) => t.type === 'problem')!;
  const teams = can(user.role, 'team.read') ? await myTeams(user.id) : [];
  const teamQueue = can(user.role, 'incident.read') && teams.length
    ? (await query(
        `SELECT i.ref, i.title, i.status, i.priority, i.is_major, i.created_at, i.team_id, t.name AS team FROM incidents i JOIN teams t ON t.id = i.team_id
         WHERE i.assignee_id IS NULL AND i.status NOT IN ('resolved', 'closed') AND i.team_id = ANY($1) ORDER BY i.priority, i.created_at LIMIT 50`,
        [teams.map((t) => t.id)],
      )).rows
    : [];
  return {
    teams,
    team_queue: teamQueue,
    problems: problems.rows.map((p) => ({ type: 'problem', ...p, url: recordUrl(problemType, p.ref) })),
    incidents: incidents.rows,
    major_updates: majorUpdates,
    reviews,
    change_votes: changeVotes.rows,
    changes: myChanges.rows,
    actions: actions.rows,
    watched_changes: watched.rows,
    decisions: decisions.rows.map((p) => ({ type: 'problem', ...p, url: recordUrl(problemType, p.ref) })),
    approvals: decide ? await listApprovals() : [],
  };
}

/**
 * The menu's badges (#102): only things that need someone, counted with the caller's visibility (row-level security)
 * and the modules that are on. One cheap query per badge.
 */
export async function navCounts(user: User) {
  const n = async (sql: string, params: unknown[] = []) => Number((await query(sql, params)).rows[0].n);
  const zero = Promise.resolve(0);
  const [myProblems, myIncidents, myActions, alerts, queue, decisions, overdue] = await Promise.all([
    n("SELECT count(*) AS n FROM problems WHERE assignee_id = $1 AND status NOT IN ('resolved', 'closed')", [user.id]),
    can(user.role, 'incident.read') && moduleEnabled('incident') ? n("SELECT count(*) AS n FROM incidents WHERE assignee_id = $1 AND status NOT IN ('resolved', 'closed')", [user.id]) : zero,
    n("SELECT count(*) AS n FROM problem_actions WHERE owner_id = $1 AND status = 'open'", [user.id]),
    can(user.role, 'event.read') && moduleEnabled('event') ? n("SELECT count(*) AS n FROM alerts WHERE status = 'open' AND incident_id IS NULL AND suppressed = ''") : zero,
    can(user.role, 'incident.read') && moduleEnabled('incident')
      ? n("SELECT count(*) AS n FROM incidents i WHERE i.assignee_id IS NULL AND i.status NOT IN ('resolved', 'closed') AND i.team_id IN (SELECT team_id FROM team_members WHERE user_id = $1)", [user.id])
      : zero,
    can(user.role, 'problem.accept_risk') ? n("SELECT count(*) AS n FROM problems WHERE status = 'known_error' AND coalesce(ec_decision, 'pending') = 'pending'") : zero,
    n("SELECT count(*) AS n FROM problem_actions WHERE status = 'open' AND due_date < current_date"),
  ]);
  const reviews = can(user.role, 'incident.read') && moduleEnabled('incident') ? await attentionCount(user.id) : 0;
  return { my_work: myProblems + myIncidents + myActions, events: alerts, incidents: queue, kedb: decisions, actions: overdue, reviews };
}
