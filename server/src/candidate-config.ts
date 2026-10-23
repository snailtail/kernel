// Configuration risk as problem candidates (part 3 of #31): CIs that keep going missing in sync, versions past (or
// near) their end of life from a small editable table, and single points of failure in the dependency graph. The same
// model as candidates.ts (Raw + finish); imports from it are types only, so the modules load in either order.
import { z } from 'zod';
import type { User } from './auth.js';
import { audit } from './audit.js';
import type { EvidenceCi, EvidenceRecord, Raw } from './candidates.js';
import { query, tx } from './db.js';
import { conflict, notFound } from './errors.js';
import { authorize } from './policy.js';
import type { Db } from './problems.js';
import { plural } from './core/text.js';

const count = (n: number) => z.number().int().min(2).max(1000).default(n);

export const CONFIG_RULES = {
  repeatedly_missing: {
    label: 'CIs that keep going missing',
    description: 'A CI that synced sources reported missing at least min_times times within window_days days: flaky discovery, or something that keeps disappearing.',
    detection: 'proactive',
    proactive: true,
    settings: z.object({ min_times: count(2), window_days: z.number().int().min(1).max(365).default(90) }),
  },
  eol_versions: {
    label: 'Versions at end of life',
    description: 'CIs whose synced version (os, or engine/product and version) has passed its end-of-life date in the EOL table, or reaches it within warn_days days.',
    detection: 'proactive',
    proactive: true,
    settings: z.object({ warn_days: z.number().int().min(0).max(730).default(180) }),
  },
  single_point_of_failure: {
    label: 'Single points of failure',
    description: 'A CI that at least min_services services depend on (up to max_depth steps), where something relies on it with no alternative of the same type. Tag a clustered CI redundant to leave it out.',
    detection: 'proactive',
    proactive: true,
    settings: z.object({ min_services: count(3), max_depth: z.number().int().min(1).max(8).default(5) }),
  },
} as const;
type Settings<R extends keyof typeof CONFIG_RULES> = z.infer<(typeof CONFIG_RULES)[R]['settings']>;

const LIMIT = 200;
const named = (name: string, ref: string | null) => (ref ? `${name} (${ref})` : name);
const ciRecord = (c: { ref: string; name: string; at?: string | null; note?: string }): EvidenceRecord => ({
  key: `ci:${c.ref}`, kind: 'ci', id: null, incident_ref: null, alert_id: null, system: 'Kernel', reference: c.ref,
  summary: c.name, category: '', occurred_at: c.at ?? null, ci_ref: c.ref, note: c.note ?? null,
});

/** Missing transitions are logged on the CI by the sync (connectors.ts) as status changes to 'missing'. */
export async function repeatedlyMissing(db: Db, s: Settings<'repeatedly_missing'>): Promise<Raw[]> {
  const { rows } = await db.query(
    `SELECT c.ref, c.name, c.class, c.status,
            json_agg(json_build_object('key', 'm:' || a.id, 'kind', 'sync', 'id', NULL, 'incident_ref', NULL, 'alert_id', NULL, 'system', coalesce(a.data->>'source_system', 'sync'),
              'reference', coalesce(a.data->>'source_system', 'sync'), 'summary', a.body, 'category', '', 'occurred_at', a.created_at, 'ci_ref', c.ref, 'note', 'marked missing')
              ORDER BY a.created_at DESC) AS records
     FROM ci_activity a JOIN configuration_items c ON c.id = a.ci_id
     WHERE a.kind = 'status' AND a.data->>'to' = 'missing' AND a.created_at > now() - $1 * interval '1 day' AND c.status <> 'retired'
     GROUP BY c.id HAVING count(*) >= $2 ORDER BY count(*) DESC LIMIT ${LIMIT}`,
    [s.window_days, s.min_times],
  );
  return rows.map((c) => ({
    key: `repeatedly_missing:ci:${c.ref}`,
    rule: 'repeatedly_missing' as const,
    subject: { type: c.class === 'service' ? ('service' as const) : ('ci' as const), ref: c.ref, name: c.name },
    service: c.name, ci_ref: c.ref, ci_class: c.class,
    records: c.records,
    cis: [{ ref: c.ref, name: c.name, role: 'subject' as const }],
    title: () => `${c.name} keeps going missing in sync`,
    finish: (rs: EvidenceRecord[]) => (rs.length >= s.min_times
      ? `${named(c.name, c.ref)} was reported missing ${plural(rs.length, 'time')} in ${s.window_days} days${c.status === 'missing' ? ' and is missing now' : ''}`
      : null),
  }));
}

/**
 * The version labels a CI carries, lower case: its os ("Ubuntu 22.04"), and engine, product or os with a version.
 * A table row matches a label equal to "product version", or one that continues with a dot or a space ("12.4", "7 SP1").
 */
const LABELS_SQL = `
  SELECT c.id, c.ref, c.name, c.class, lower(trim(t.label)) AS label
  FROM configuration_items c,
       LATERAL (VALUES (c.attributes->>'os'), (concat_ws(' ', c.attributes->>'engine', c.attributes->>'version')),
                       (concat_ws(' ', c.attributes->>'product', c.attributes->>'version')), (concat_ws(' ', c.attributes->>'os', c.attributes->>'os_version'))) t(label)
  WHERE c.status NOT IN ('retired', 'planned') AND t.label IS NOT NULL AND position(' ' in trim(t.label)) > 0`;

export async function eolVersions(db: Db, s: Settings<'eol_versions'>): Promise<Raw[]> {
  const { rows } = await db.query(
    `WITH labels AS (${LABELS_SQL}),
     m AS (
       SELECT DISTINCT e.id AS eol_id, e.product, e.version, e.eol_date, e.note, l.ref, l.name, l.label
       FROM eol_versions e JOIN labels l
         ON l.label = lower(e.product || ' ' || e.version)
         OR starts_with(l.label, lower(e.product || ' ' || e.version || '.'))
         OR starts_with(l.label, lower(e.product || ' ' || e.version || ' '))
       WHERE e.eol_date <= current_date + $1::int
     )
     SELECT eol_id, product, version, eol_date::text AS eol_date, note, (eol_date < current_date) AS passed,
            json_agg(json_build_object('ref', ref, 'name', name, 'label', label) ORDER BY name) AS cis
     FROM m GROUP BY eol_id, product, version, m.eol_date, note ORDER BY m.eol_date LIMIT ${LIMIT}`,
    [s.warn_days],
  );
  return rows.map((e) => {
    const cis = [...new Map(e.cis.map((c: any) => [c.ref, c])).values()] as { ref: string; name: string; label: string }[];
    const what = `${e.product} ${e.version}`;
    const when = e.passed ? `reached end of life on ${e.eol_date}` : `reaches end of life on ${e.eol_date}`;
    return {
      key: `eol_versions:eol:${e.eol_id}`,
      rule: 'eol_versions' as const,
      subject: { type: 'version' as const, ref: null, name: what },
      service: '', ci_ref: null, ci_class: null,
      records: cis.map((c) => ciRecord({ ref: c.ref, name: c.name, note: c.label })),
      cis: cis.map((c): EvidenceCi => ({ ref: c.ref, name: c.name, role: 'affected' })),
      notes: e.note ? `${what}: ${e.note} (${e.eol_date}).` : undefined,
      title: () => `${what} ${e.passed ? 'past' : 'near'} end of life`,
      // A dismissal covers the CIs it was made on; another CI on the same version brings it back.
      finish: (rs: EvidenceRecord[]) => (rs.length ? `${plural(rs.length, 'CI')} ${rs.length === 1 ? 'runs' : 'run'} ${what}, which ${when}${e.passed ? ': no more security fixes' : ''}` : null),
    };
  });
}

/**
 * Walks down from every service (what it depends on, the way part 1 walks to a shared CI) and counts the services
 * behind each CI. A CI is redundant when everything that relies on it directly also relies on another CI of the same
 * type in the same way (two nodes, two replicas), or when it is tagged redundant (a cluster kept as one CI).
 */
export async function singlePointOfFailure(db: Db, s: Settings<'single_point_of_failure'>): Promise<Raw[]> {
  const { rows } = await db.query(
    `WITH RECURSIVE edges AS (
       SELECT CASE WHEN t.propagation = 'forward' THEN r.from_ci ELSE r.to_ci END AS dependent,
              CASE WHEN t.propagation = 'forward' THEN r.to_ci ELSE r.from_ci END AS dependency, r.type
       FROM ci_relationships r JOIN ci_relationship_types t ON t.name = r.type
     ),
     -- Over nodes, not paths: UNION drops repeated (service, node, depth) rows, and the depth limit ends cycles.
     down (service, node, depth) AS (
       SELECT s.id, e.dependency, 1 FROM configuration_items s JOIN edges e ON e.dependent = s.id
       WHERE s.class = 'service' AND s.status NOT IN ('retired', 'planned')
       UNION
       SELECT d.service, e.dependency, d.depth + 1 FROM down d JOIN edges e ON e.dependent = d.node
       WHERE d.depth < $2 AND e.dependency <> d.service
     ),
     behind AS (SELECT node, array_agg(DISTINCT service) AS services FROM down GROUP BY node HAVING count(DISTINCT service) >= $1),
     -- Something relies on the CI directly with no other CI of the same type, related the same way.
     sole AS (
       SELECT b.node FROM behind b JOIN configuration_items x ON x.id = b.node
       WHERE x.class <> 'service' AND x.status NOT IN ('retired', 'missing') AND NOT ('redundant' = ANY (x.tags))
         AND EXISTS (
           SELECT 1 FROM edges e WHERE e.dependency = b.node AND NOT EXISTS (
             SELECT 1 FROM edges o JOIN configuration_items y ON y.id = o.dependency
             WHERE o.dependent = e.dependent AND o.type = e.type AND o.dependency <> b.node AND y.ci_type = x.ci_type AND y.status NOT IN ('retired', 'missing')))
     )
     SELECT x.ref, x.name, x.class, x.ci_type, x.criticality,
            (SELECT json_agg(json_build_object('ref', sv.ref, 'name', sv.name, 'criticality', sv.criticality) ORDER BY sv.criticality, sv.name)
             FROM configuration_items sv WHERE sv.id = ANY(b.services)) AS services
     FROM sole JOIN behind b ON b.node = sole.node JOIN configuration_items x ON x.id = sole.node
     ORDER BY cardinality(b.services) DESC, x.criticality LIMIT ${LIMIT}`,
    [s.min_services, s.max_depth],
  );
  return rows.map((x) => ({
    key: `single_point_of_failure:ci:${x.ref}`,
    rule: 'single_point_of_failure' as const,
    subject: { type: 'ci' as const, ref: x.ref, name: x.name },
    service: x.name, ci_ref: x.ref, ci_class: x.class,
    records: x.services.map((sv: any) => ciRecord({ ref: sv.ref, name: sv.name, note: `service, criticality ${sv.criticality}` })),
    cis: [{ ref: x.ref, name: x.name, role: 'subject' as const }, ...x.services.map((sv: any): EvidenceCi => ({ ref: sv.ref, name: sv.name, role: 'affected' }))],
    title: () => `${x.name} is a single point of failure`,
    finish: (rs: EvidenceRecord[]) => (rs.length >= s.min_services
      ? `${plural(rs.length, 'service')} depend on ${named(x.name, x.ref)}, and something relies on it with no alternative: if it fails, they all do`
      : null),
  }));
}

// ---- The EOL table -------------------------------------------------------------------------------------------------

export const eolSchema = z.object({
  product: z.string().trim().min(1).max(100),
  version: z.string().trim().min(1).max(50),
  eol_date: z.iso.date(),
  note: z.string().trim().max(300).default(''),
});

export async function listEol() {
  return (await query('SELECT id, product, version, eol_date, note, updated_at FROM eol_versions ORDER BY lower(product), eol_date')).rows;
}

/** Adds or changes a row (managers), audited with before and after. */
export async function saveEol(user: User, id: number | null, input: z.infer<typeof eolSchema>) {
  authorize(user, 'candidate.rule');
  return tx(async (db) => {
    const before = id ? (await db.query('SELECT product, version, eol_date, note FROM eol_versions WHERE id = $1 FOR UPDATE', [id])).rows[0] : null;
    if (id && !before) throw notFound('No such end-of-life row');
    try {
      const { rows } = id
        ? await db.query('UPDATE eol_versions SET product = $2, version = $3, eol_date = $4, note = $5, updated_by = $6, updated_at = now() WHERE id = $1 RETURNING id, product, version, eol_date, note', [id, input.product, input.version, input.eol_date, input.note, user.id])
        : await db.query('INSERT INTO eol_versions (product, version, eol_date, note, updated_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, product, version, eol_date, note', [input.product, input.version, input.eol_date, input.note, user.id]);
      await audit(db, { entity_type: 'setting', entity_ref: `eol:${rows[0].id}`, action: id ? 'update' : 'create', changes: { from: before, to: input } });
      return rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict(`${input.product} ${input.version} is already in the table`);
      throw err;
    }
  });
}

export async function deleteEol(user: User, id: number) {
  authorize(user, 'candidate.rule');
  return tx(async (db) => {
    const { rows } = await db.query('DELETE FROM eol_versions WHERE id = $1 RETURNING product, version, eol_date', [id]);
    if (!rows[0]) throw notFound('No such end-of-life row');
    await audit(db, { entity_type: 'setting', entity_ref: `eol:${id}`, action: 'delete', changes: { from: rows[0] } });
    return { deleted: true };
  });
}
