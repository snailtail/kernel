// CI lifecycle (#18): active → missing (the sources stopped reporting it) → proposed for retirement (missing for the
// connector's retire_after_days) → retired, by a person. Never automatic and never a hard delete: a CI that comes back
// before it is retired returns to active, and a retired CI keeps its history.
import { z } from 'zod';
import type { User } from '../security/auth.js';
import { loadCi, logCi } from './cmdb.js';
import { type Db, query, tx } from '../core/db.js';
import { forbidden } from '../core/errors.js';
import { authorize, can } from '../security/policy.js';
import { recordUrl, typeForRef } from '../records/records.js';

export const retireSchema = z.object({
  refs: z.array(z.string().trim().min(1).max(30)).min(1).max(200),
  comment: z.string().trim().max(5000).optional(),
  /** Retire even when open incidents, problems or changes still name the CI. */
  acknowledge_open: z.boolean().default(false),
});

/** Open records that name a CI: retiring it would leave them pointing at something we say no longer exists. */
async function openRecords(db: Db, ciIds: number[]) {
  const { rows } = await db.query(
    `SELECT x.ci_id, i.ref, 'incident' AS kind, i.title FROM incident_cis x JOIN incidents i ON i.id = x.incident_id
       WHERE x.ci_id = ANY($1) AND i.status NOT IN ('resolved', 'closed')
     UNION ALL
     SELECT x.ci_id, p.ref, 'problem', p.title FROM problem_cis x JOIN problems p ON p.id = x.problem_id
       WHERE x.ci_id = ANY($1) AND p.status NOT IN ('resolved', 'closed')
     UNION ALL
     SELECT x.ci_id, c.ref, 'change', c.title FROM change_cis x JOIN changes c ON c.id = x.change_id
       WHERE x.ci_id = ANY($1) AND c.status NOT IN ('closed', 'rejected', 'cancelled')
     ORDER BY 2`,
    [ciIds],
  );
  const by = new Map<number, { ref: string; kind: string; title: string }[]>();
  for (const r of rows) by.set(r.ci_id, [...(by.get(r.ci_id) ?? []), { ref: r.ref, kind: r.kind, title: r.title }]);
  return by;
}

const mayRetire = (user: User, ownerId: number | null) => can(user.role, 'ci.manage') || ownerId === user.id;

/** CIs missing long enough to be proposed for retirement, with what a person needs to decide. */
export async function retireProposals(user: User) {
  authorize(user, 'ci.read');
  const { rows } = await query(
    `SELECT c.id, c.ref, c.class, c.name, c.ci_type, t.label AS type_label, c.environment, c.owner_id, o.display_name AS owner, c.team,
            d.missing_since, d.retire_after_days, d.proposed_at,
            (SELECT coalesce(json_agg(json_build_object('source_system', s.source_system, 'source_id', s.source_id, 'source_url', s.source_url,
                                                        'last_seen_at', s.last_seen_at, 'connector', k.name) ORDER BY s.source_system), '[]')
             FROM ci_sources s LEFT JOIN connectors k ON k.source_system = s.source_system WHERE s.ci_id = c.id) AS sources,
            (SELECT max(s.last_seen_at) FROM ci_sources s WHERE s.ci_id = c.id) AS last_seen_at,
            (SELECT coalesce(json_agg(json_build_object('type', r.type, 'direction', r.direction, 'ref', r.ref, 'name', r.name) ORDER BY r.type, r.name), '[]')
             FROM (SELECT r.type, CASE WHEN r.from_ci = c.id THEN 'out' ELSE 'in' END AS direction, x.ref, x.name
                   FROM ci_relationships r JOIN configuration_items x ON x.id = CASE WHEN r.from_ci = c.id THEN r.to_ci ELSE r.from_ci END
                   WHERE c.id IN (r.from_ci, r.to_ci) LIMIT 20) r) AS relationships
     FROM ci_retire_due d JOIN configuration_items c ON c.id = d.id JOIN ci_types t ON t.name = c.ci_type LEFT JOIN users o ON o.id = c.owner_id
     WHERE d.proposed_at <= now()
     ORDER BY d.missing_since, c.ref
     LIMIT 1000`,
  );
  const open = await tx((db) => openRecords(db, rows.map((r) => r.id)));
  return rows.map(({ id, ...r }) => ({ ...r, url: recordUrl(typeForRef(r.ref), r.ref), open_records: open.get(id) ?? [], can_retire: mayRetire(user, r.owner_id) }));
}

/**
 * Retires missing CIs, one transaction each, and reports what happened to every one. Administrators and CMDB managers
 * may retire any; an owner may retire their own. A CI that is reported again, or that open records still name
 * (unless acknowledged), is skipped with the reason.
 */
export async function retireCis(user: User, input: z.infer<typeof retireSchema>) {
  authorize(user, 'ci.read');
  const results: { ref: string; outcome: 'retired' | 'unchanged' | 'skipped' | 'failed'; reason?: string }[] = [];
  for (const ref of [...new Set(input.refs.map((r) => r.toUpperCase()))]) {
    try {
      results.push(await tx(async (db) => {
        const ci = await loadCi(db, ref);
        if (!mayRetire(user, ci.owner_id)) throw forbidden(`Only an administrator, a CMDB manager or the owner can retire ${ref}`);
        if (ci.status === 'retired') return { ref, outcome: 'unchanged' as const, reason: 'Already retired' };
        if (ci.status !== 'missing') return { ref, outcome: 'skipped' as const, reason: `${ref} is ${ci.status}, not missing: its source reports it again` };
        const open = (await openRecords(db, [ci.id])).get(ci.id) ?? [];
        if (open.length && !input.acknowledge_open) {
          return { ref, outcome: 'skipped' as const, reason: `Open records name it: ${open.map((o) => o.ref).join(', ')}. Confirm to retire it anyway.` };
        }
        await db.query("UPDATE configuration_items SET status = 'retired' WHERE id = $1", [ci.id]);
        await logCi(db, ci.id, user.id, 'status', input.comment || 'Retired: no source has reported it since it went missing', {
          from: 'missing', to: 'retired', missing_since: ci.missing_since, ...(open.length ? { open_records: open.map((o) => o.ref) } : {}),
          ...(input.comment ? { comment: input.comment } : {}),
        });
        return { ref, outcome: 'retired' as const };
      }));
    } catch (err) {
      results.push({ ref, outcome: 'failed', reason: (err as Error).message });
    }
  }
  return { retired: results.filter((r) => r.outcome === 'retired').length, results };
}
