// Everything an analyst (or agent) needs to investigate a problem, in one size-limited call (#76).
import type { User } from './auth.js';
import { query } from './db.js';
import { checkAnalysis } from './analysis-checks.js';
import { authorize } from './policy.js';
import { findSimilar, getProblem } from './problems.js';

const clip = (s: unknown, n: number) => (typeof s === 'string' && s.length > n ? s.slice(0, n - 1) + '…' : s);

export async function problemContext(user: User, ref: string) {
  authorize(user, 'problem.read');
  const p: any = await getProblem(ref);
  const [similar, sameService] = await Promise.all([
    findSimilar(`${p.title} ${p.description}`, p.ref, 5),
    p.affected_service
      ? query(
          `SELECT system, kind, reference, summary, occurred_at, problem_id IS NOT NULL AS linked
           FROM external_records WHERE lower(service) = lower($1) AND occurred_at > now() - interval '30 days'
           ORDER BY occurred_at DESC LIMIT 25`,
          [p.affected_service],
        )
      : Promise.resolve({ rows: [] as any[] }),
  ]);
  return {
    problem: {
      ref: p.ref, url: p.url, title: p.title, status: p.status, priority: p.priority, impact: p.impact, urgency: p.urgency,
      is_major: p.is_major, detection: p.detection, category: p.category, affected_service: p.affected_service,
      assignee: p.assignee, created_at: p.created_at,
      description: clip(p.description, 4000), root_cause: clip(p.root_cause, 4000), workaround: clip(p.workaround, 2000),
      resolution: clip(p.resolution, 2000), proposed_via_mcp: p.mcp_proposed,
    },
    next_steps: p.next_steps,
    linked_records: p.links.map((l: any) => ({ kind: l.kind, reference: l.reference, system: l.system, url: l.url, note: clip(l.note, 300), linked_at: l.created_at })),
    recent_records_for_service: sameService.rows.map((r: any) => ({ ...r, summary: clip(r.summary, 300) })),
    analyses: p.analyses.map((a: any) => ({
      id: a.id, technique: a.technique, title: a.title, conclusion: clip(a.conclusion, 1000),
      proposed_via_mcp: a.proposed_via_mcp, check: checkAnalysis(a.technique, a.data, a.conclusion),
    })),
    open_actions: p.actions.filter((a: any) => a.status === 'open').map((a: any) => ({ id: a.id, title: a.title, owner: a.owner, due_date: a.due_date })),
    work_notes: p.activity.filter((a: any) => a.kind === 'comment').slice(0, 15).map((a: any) => ({ at: a.created_at, by: a.user_name, via: a.channel, note: clip(a.body, 800) })),
    similar_problems: similar.map((s: any) => ({ ref: s.ref, title: s.title, status: s.status, workaround: clip(s.workaround, 300) })),
  };
}
