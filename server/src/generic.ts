// Cross-practice operations over the record type registry: one predictable surface for agents and scripts.
import { z } from 'zod';
import type { User } from './auth.js';
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
  return results.flat().slice(0, input.limit);
}

/** Any record by its ref (the prefix selects the type). */
export async function getRecord(user: User, ref: string) {
  const t = typeForRef(ref);
  authorize(user, t.readAction);
  return t.get(user, ref.toUpperCase());
}

export async function nextSteps(user: User, ref: string) {
  const record = await getRecord(user, ref);
  return { ref: record.ref, type: record.type, url: record.url, next_steps: record.next_steps ?? null };
}

/** Links a record to another Kernel record or to an external record. */
export async function linkRecords(user: User, from: string, to: string, options: { kind?: string; system?: string; url?: string; note?: string }) {
  const source = typeForRef(from);
  let kind = options.kind;
  try {
    const target = typeForRef(to);
    kind ??= target.type;
  } catch {
    if (!kind) throw badRequest('Give the kind (incident, event, change, problem) for an external reference');
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
          `SELECT ref, title, status, priority, is_major, created_at FROM incidents
           WHERE assignee_id = $1 AND status NOT IN ('resolved', 'closed') ORDER BY priority, created_at LIMIT 50`,
          [user.id],
        )
      : Promise.resolve({ rows: [] as any[] }),
    can(user.role, 'change.approve')
      ? query(
          `SELECT c.ref, c.title, c.change_type, c.planned_start FROM changes c WHERE c.status = 'authorize' AND c.created_by IS DISTINCT FROM $1
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
  const problemType = recordTypes().find((t) => t.type === 'problem')!;
  return {
    problems: problems.rows.map((p) => ({ type: 'problem', ...p, url: recordUrl(problemType, p.ref) })),
    incidents: incidents.rows,
    change_votes: changeVotes.rows,
    changes: myChanges.rows,
    actions: actions.rows,
    watched_changes: watched.rows,
    decisions: decisions.rows.map((p) => ({ type: 'problem', ...p, url: recordUrl(problemType, p.ref) })),
    approvals: decide ? await listApprovals() : [],
  };
}
