// Problems and known errors linked to the CIs and services they affect (#26). Affected services come from the
// dependency graph, so priority and the error control risk can rest on the CMDB instead of free text.
import { z } from 'zod';
import type { User } from './auth.js';
import { computeImpact, impactSchema } from './cmdb-graph.js';
import { loadCi, logCi, registerCiExtra } from './cmdb.js';
import { query, tx } from './db.js';
import { conflict, notFound } from './errors.js';
import { authorize } from './policy.js';
import { getProblem, loadForUpdate, logActivity, registerProblemExtra } from './problems.js';

export const linkCiSchema = z.object({ ci: z.string().trim().min(1).max(30).describe('CI or service ref, e.g. CI000012') });

export async function linkCiToProblem(user: User, problemRef: string, ciRef: string) {
  authorize(user, 'problem.link');
  await tx(async (db) => {
    const p = await loadForUpdate(db, problemRef);
    const ci = await loadCi(db, ciRef);
    const { rowCount } = await db.query('INSERT INTO problem_cis (problem_id, ci_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [p.id, ci.id, user.id]);
    if (!rowCount) throw conflict(`${ci.ref} is already linked to ${p.ref}`);
    await logActivity(db, p.id, user.id, 'link', `Affects ${ci.ref} ${ci.name}`, { kind: ci.class, reference: ci.ref, action: 'add' });
    await logCi(db, ci.id, user.id, 'link', `Affected by problem ${p.ref}`, { kind: 'problem', reference: p.ref, action: 'add' });
    await db.query('UPDATE problems SET updated_at = now() WHERE id = $1', [p.id]);
  });
  return getProblem(problemRef);
}

export async function unlinkCiFromProblem(user: User, problemRef: string, ciRef: string) {
  authorize(user, 'problem.link');
  await tx(async (db) => {
    const p = await loadForUpdate(db, problemRef);
    const ci = await loadCi(db, ciRef);
    const { rowCount } = await db.query('DELETE FROM problem_cis WHERE problem_id = $1 AND ci_id = $2', [p.id, ci.id]);
    if (!rowCount) throw notFound(`${ci.ref} is not linked to ${p.ref}`);
    await logActivity(db, p.id, user.id, 'link', `No longer affects ${ci.ref} ${ci.name}`, { kind: ci.class, reference: ci.ref, action: 'remove' });
    await logCi(db, ci.id, user.id, 'link', `Unlinked from problem ${p.ref}`, { kind: 'problem', reference: p.ref, action: 'remove' });
    await db.query('UPDATE problems SET updated_at = now() WHERE id = $1', [p.id]);
  });
  return getProblem(problemRef);
}

/** Records about a CI link that CI to the problem they are linked to (used when records are linked). */
export async function linkRecordCis(db: Pick<import('pg').PoolClient, 'query'>, userId: number, problem: { id: number; ref: string }, record: { system: string; kind: string; reference: string }) {
  const { rows } = await db.query(
    `INSERT INTO problem_cis (problem_id, ci_id, added_by)
     SELECT $1, r.ci_id, $2 FROM external_records r WHERE r.system = $3 AND r.kind = $4 AND r.reference = $5 AND r.ci_id IS NOT NULL
     ON CONFLICT DO NOTHING
     RETURNING ci_id, (SELECT ref FROM configuration_items WHERE id = ci_id) AS ref, (SELECT class FROM configuration_items WHERE id = ci_id) AS class`,
    [problem.id, userId, record.system, record.kind, record.reference],
  );
  for (const r of rows) {
    await logActivity(db, problem.id, userId, 'link', `Affects ${r.ref} (from ${record.kind} ${record.reference})`, { kind: r.class, reference: r.ref, action: 'add' });
  }
}

const IMPACT_FROM_CRITICALITY: Record<number, number> = { 1: 1, 2: 2, 3: 3, 4: 3 };
const CRIT_LABEL = ['', 'business critical', 'high', 'medium', 'low'];
const IMPACT_LABEL = ['', 'High', 'Medium', 'Low'];

/** Affected CIs and the services reached through the dependency graph, with a priority hint. */
async function affected(problem: { id: number; impact: number }) {
  const { rows: cis } = await query(
    `SELECT c.id, c.ref, c.name, c.class, c.ci_type, t.label AS type_label, c.status, c.environment, c.criticality, pc.added_at
     FROM problem_cis pc JOIN configuration_items c ON c.id = pc.ci_id JOIN ci_types t ON t.name = c.ci_type
     WHERE pc.problem_id = $1 ORDER BY c.class DESC, c.criticality, c.name`,
    [problem.id],
  );
  return affectedFrom(cis, problem.impact);
}

/** Shared by problems and incidents: services reached from the CIs, and an impact hint when it should be higher. */
export async function affectedFrom(cis: { id: number; ref: string; name: string; class: string; criticality: number }[], currentImpact: number) {
  const services = new Map<string, { ref: string; name: string; criticality: number; via: string[] }>();
  let incomplete = false;
  for (const ci of cis) {
    if (ci.class === 'service') services.set(ci.ref, { ref: ci.ref, name: ci.name, criticality: ci.criticality, via: [] });
  }
  // Bounded: the first 10 CIs; each walk is itself limited to 10 levels and 500 nodes.
  // TODO(#53): pass the record reader so scoping hides services and CIs they cannot see (user null = no filter).
  for (const ci of cis.slice(0, 10)) {
    const r = await computeImpact(null, ci.ref, impactSchema.parse({ direction: 'up' }));
    incomplete ||= r.truncated || r.depth_limit_reached;
    for (const s of r.services) {
      const seen = services.get(s.ref) ?? { ref: s.ref, name: s.name, criticality: s.criticality, via: [] as string[] };
      seen.via.push(ci.ref);
      services.set(s.ref, seen);
    }
  }
  if (cis.length > 10) incomplete = true;
  const affectedServices = [...services.values()].sort((a, b) => a.criticality - b.criticality || a.name.localeCompare(b.name));
  const worst = [...affectedServices, ...cis].reduce<{ name: string; criticality: number } | null>((w, x) => (!w || x.criticality < w.criticality ? x : w), null);
  const suggested = worst ? IMPACT_FROM_CRITICALITY[worst.criticality] : null;
  return {
    affected_cis: cis.map(({ id: _, ...c }) => ({ ...c, type: c.class === 'service' ? 'service' : 'ci' })),
    affected_services: affectedServices,
    impact_hint:
      worst && suggested && suggested < currentImpact
        ? { suggested_impact: suggested, reason: `Affects ${worst.name} (${CRIT_LABEL[worst.criticality]}): consider impact ${IMPACT_LABEL[suggested]}.`, incomplete }
        : null,
    impact_incomplete: incomplete,
  };
}

registerProblemExtra((p) => affected(p));

// The CI page: problems and known errors (with workarounds) – what the service desk needs during an incident.
registerCiExtra(async (ciId) => {
  const { rows } = await query(
    `SELECT p.ref, p.title, p.status, p.priority, p.workaround, p.workaround_effectiveness, p.ec_decision, p.updated_at
     FROM problem_cis pc JOIN problems p ON p.id = pc.problem_id
     WHERE pc.ci_id = $1
     ORDER BY (p.status = 'known_error') DESC, (p.status IN ('resolved', 'closed')), p.priority, p.updated_at DESC LIMIT 100`,
    [ciId],
  );
  const { rows: records } = await query(
    `SELECT system, kind, reference, summary, occurred_at, problem_id IS NOT NULL AS linked
     FROM external_records WHERE ci_id = $1 ORDER BY occurred_at DESC LIMIT 25`,
    [ciId],
  );
  return {
    problems: rows.filter((p) => p.status !== 'known_error').map(({ workaround: _, ...p }) => p),
    known_errors: rows.filter((p) => p.status === 'known_error'),
    recent_records: records,
  };
});
