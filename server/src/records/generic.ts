// Cross-practice operations over the record type registry: one predictable surface for agents and scripts.
import { moduleEnabled } from '../core/modules.js';
import { MASKED_FIELDS, maskedRefs, onlyTitleMatches } from '../security/confidential.js';
import { currentContext } from '../core/context.js';
import { z } from 'zod';
import { linkArticleCi } from '../reporting/knowledge.js';
import { myTeams } from '../people/teams.js';
import { assertVisibleRef } from '../security/visibility.js';
import type { User } from '../security/auth.js';
import { queryAudit } from '../security/audit.js';
import { impact, impactSchema } from '../cmdb/cmdb-graph.js';
import { query } from '../core/db.js';
import { badRequest } from '../core/errors.js';
import { authorize, can } from '../security/policy.js';
import { listApprovals } from '../changes/approvals.js';
import { addCiLink, CI_LINK_KINDS } from '../cmdb/cmdb.js';
import { linkCiToProblem } from '../problems/problem-cis.js';
import { addIncidentLink, linkIncidentToProblem, myIncidentWork, setIncidentCi } from '../incidents/incidents.js';
import { addChangeLink, myChangeWork, setChangeCi } from '../changes/changes.js';

const incidentExists = async (ref: string) => (await query('SELECT 1 FROM incidents WHERE ref = $1', [ref.toUpperCase()])).rows.length > 0;
import { addLink, LINK_KINDS, myProblemWork } from '../problems/problems.js';
import { recordTypes, recordUrl, typeForRef, type SearchHit } from './records.js';
import { attentionCount, incidentRefOf, myReviews } from '../incidents/post-incident-reviews.js';
import { addImprovementLink, improvementLinkSchema, myImprovements } from '../improvements/improvements.js';
import { addRequestLink, myRequestWork, requestLinkSchema, teamRequestTasks } from '../requests/requests.js';
import { actionCounts, myActions } from '../problems/actions.js';
import { addWorkItemLink, myWorkItems, workItemLinkSchema } from '../development/work-items.js';

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
  await typeForRef(ref).comment(user, ref, body);
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
  // An improvement (#52) keeps the links to what carries it out, whichever side the link starts from.
  if (source.type === 'improvement') {
    return (await addImprovementLink(user, from, improvementLinkSchema.parse({ kind, reference: to, system: options.system, url: options.url, note: options.note }))).links;
  }
  // A work item (#165) links related work items and documents; the links to ITSM records come with #167.
  if (source.type === 'work_item') {
    return (await addWorkItemLink(user, from, workItemLinkSchema.parse({ kind, reference: to, system: options.system, url: options.url, note: options.note }))).links;
  }
  // A service request (#44) keeps its own links: the incident, change or problem it relates to, a CI, a document.
  if (source.type === 'request') {
    return (await addRequestLink(user, from, requestLinkSchema.parse({ kind: kind === 'service' ? 'ci' : kind, reference: to, system: options.system, url: options.url, note: options.note }))).links;
  }
  if (kind === 'request' && kernelRef) {
    if (!['problem', 'change', 'incident', 'ci', 'service'].includes(source.type)) throw badRequest(`A request links to incidents, changes, problems and CIs, not a ${source.type}`);
    return (await addRequestLink(user, to, requestLinkSchema.parse({ kind: source.type === 'service' ? 'ci' : source.type, reference: from, note: options.note }))).links;
  }
  if (kind === 'improvement' && kernelRef) {
    if (!['problem', 'change', 'incident', 'review'].includes(source.type)) throw badRequest(`An improvement links to the problems, changes, incidents and reviews that carry it out, not a ${source.type}`);
    return (await addImprovementLink(user, to, improvementLinkSchema.parse({ kind: source.type, reference: from, note: options.note }))).links;
  }
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

/**
 * What the user should work on: their open records and actions, and recent changes on what they watch. Each practice
 * only while its module is on and the user may read it; the actions register is always there (#184).
 */
export async function myWork(user: User) {
  const problemRead = can(user.role, 'problem.read');
  const decide = can(user.role, 'problem.accept_risk');
  const teams = can(user.role, 'team.read') ? await myTeams(user.id) : [];
  const incidentRead = can(user.role, 'incident.read');
  const [problemWork, actions, incidentWork, changeWork] = await Promise.all([
    problemRead ? myProblemWork(user.id, decide) : { problems: [], watched: [], decisions: [] },
    myActions(user),
    incidentRead ? myIncidentWork(user.id, teams.map((t) => t.id)) : null,
    myChangeWork(user.id, can(user.role, 'change.approve'), can(user.role, 'change.read')),
  ]);
  const reviews = incidentRead ? await myReviews(user.id) : [];
  const improvements = can(user.role, 'improvement.read') ? await myImprovements(user.id) : [];
  // Service requests (#44), when the module is on: my tasks, my teams' open tasks and what waits for my approval.
  const requests = can(user.role, 'request.read') ? await myRequestWork(user.id) : null;
  // Development work (#165), when the module is on: what I am working on.
  const workItems = can(user.role, 'work.read') ? await myWorkItems(user.id) : [];
  const problemType = recordTypes().find((t) => t.type === 'problem')!;
  return {
    teams,
    team_queue: incidentWork?.team_queue ?? [],
    problems: problemWork.problems.map((p) => ({ type: 'problem', ...p, url: recordUrl(problemType, p.ref) })),
    incidents: incidentWork?.incidents ?? [],
    major_updates: incidentWork?.major_updates ?? [],
    reviews,
    improvements,
    work_items: workItems,
    request_tasks: requests?.tasks ?? [],
    request_approvals: requests?.approvals ?? [],
    request_queue: requests && teams.length ? (await teamRequestTasks(teams.map((t) => t.id))).filter((t) => !t.assignee_id) : [],
    change_votes: changeWork.votes,
    changes: changeWork.changes,
    actions,
    watched_changes: problemWork.watched,
    decisions: problemWork.decisions.map((p) => ({ type: 'problem', ...p, url: recordUrl(problemType, p.ref) })),
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
  const [myProblems, myIncidents, actions, alerts, queue, decisions] = await Promise.all([
    can(user.role, 'problem.read') ? n("SELECT count(*) AS n FROM problems WHERE assignee_id = $1 AND status NOT IN ('resolved', 'closed')", [user.id]) : zero,
    can(user.role, 'incident.read') && moduleEnabled('incident') ? n("SELECT count(*) AS n FROM incidents WHERE assignee_id = $1 AND status NOT IN ('resolved', 'closed')", [user.id]) : zero,
    actionCounts(user),
    can(user.role, 'event.read') && moduleEnabled('event') ? n("SELECT count(*) AS n FROM alerts WHERE status = 'open' AND incident_id IS NULL AND suppressed = ''") : zero,
    can(user.role, 'incident.read') && moduleEnabled('incident')
      ? n("SELECT count(*) AS n FROM incidents i WHERE i.assignee_id IS NULL AND i.status NOT IN ('resolved', 'closed') AND i.team_id IN (SELECT team_id FROM team_members WHERE user_id = $1)", [user.id])
      : zero,
    can(user.role, 'problem.accept_risk') ? n("SELECT count(*) AS n FROM problems WHERE status = 'known_error' AND coalesce(ec_decision, 'pending') = 'pending'") : zero,
  ]);
  const reviews = can(user.role, 'incident.read') && moduleEnabled('incident') ? await attentionCount(user.id) : 0;
  // Service requests (#44): unassigned tasks in my teams, and requests waiting for my approval.
  const requests = can(user.role, 'request.read')
    ? await n(
        `SELECT (SELECT count(*) FROM request_tasks t WHERE t.status = 'open' AND t.assignee_id IS NULL AND t.team_id IN (SELECT team_id FROM team_members WHERE user_id = $1))
              + (SELECT count(*) FROM requests WHERE status = 'awaiting_approval' AND $1 = ANY(approver_ids)) AS n`,
        [user.id],
      )
    : 0;
  return { my_work: myProblems + myIncidents + actions.mine, events: alerts, incidents: queue, kedb: decisions, actions: actions.overdue, reviews, requests };
}
