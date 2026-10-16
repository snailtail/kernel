// Problem candidates (#5, #31): records worth a problem, found by rules over incidents, events and the CMDB, each
// with a reason and its evidence, plus candidates reported by external analysis. Candidates are computed on read;
// only rule settings, decisions (dismiss or snooze, per candidate key) and reported candidates are stored.
//
// Every query runs as the viewer, so row-level security decides which incidents count: a candidate never shows or
// counts a record its reader cannot see. A candidate's key is its rule plus its subject ("recurring_records:ci:CI000012").
import { z } from 'zod';
import type { User } from './auth.js';
import { audit, requireReason } from './audit.js';
import { BROADEST, copyText, mayCopyText, type Audience } from './audience.js';
import { query, tx } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { attachToProblem } from './incidents.js';
import { linkRecord } from './integrations.js';
import { authorize } from './policy.js';
import { createProblemInTx, createProblemSchema, getProblem, loadForUpdate, logActivity, problemFields, type Db } from './problems.js';
import { redact, scan } from './sensitive.js';

// ---- Rules ------------------------------------------------------------------------------------------------------

const days = (d: number) => z.number().int().min(1).max(365).default(d);
const count = (n: number) => z.number().int().min(2).max(1000).default(n);

export const RULES = {
  recurring_records: {
    label: 'Recurring records on a CI or service',
    description: 'At least min_records incidents or events on the same CI or service within window_days days, none of them linked to a problem.',
    // Reactive when incidents have happened; proactive when only events point at it (#31, ITIL 4).
    detection: 'reactive',
    settings: z.object({ min_records: count(5), window_days: days(7) }),
  },
  common_upstream: {
    label: 'Incidents sharing an underlying CI',
    description: 'At least min_records unlinked incidents on min_cis or more different CIs within window_days days that all depend on the same CI, up to max_depth steps down the dependency graph.',
    detection: 'reactive',
    settings: z.object({ min_records: count(3), min_cis: z.number().int().min(2).max(50).default(2), window_days: days(7), max_depth: z.number().int().min(1).max(5).default(3) }),
  },
  major_without_problem: {
    label: 'Major incident resolved without a problem',
    description: 'A major incident resolved within the last window_days days that no problem explains yet. Its underlying cause is not being managed.',
    detection: 'reactive',
    settings: z.object({ window_days: days(30) }),
  },
  recurring_resolution: {
    label: 'Same category and resolution',
    description: 'At least min_records incidents in the same category resolved with the same resolution code within window_days days, none linked to a problem. A workaround that keeps being applied is the classic sign.',
    detection: 'reactive',
    settings: z.object({ min_records: count(4), window_days: days(30) }),
  },
  reported: {
    label: 'Reported by external analysis',
    description: 'Candidates reported through REST or MCP (report_problem_candidate), for example by an agent analysing logs or a monitoring tool’s own trend analysis.',
    detection: 'proactive',
    settings: z.object({}),
  },
} as const;
export type RuleId = keyof typeof RULES;
export const RULE_IDS = Object.keys(RULES) as [RuleId, ...RuleId[]];
type Settings<R extends RuleId> = z.infer<(typeof RULES)[R]['settings']>;

export async function getRules(db?: Db) {
  const { rows } = await (db ?? { query }).query('SELECT rule, enabled, settings FROM candidate_rules');
  const stored = new Map(rows.map((r: any) => [r.rule as string, r]));
  return RULE_IDS.map((rule) => {
    const row = stored.get(rule);
    const parsed = RULES[rule].settings.safeParse(row?.settings ?? {});
    return {
      rule, label: RULES[rule].label, description: RULES[rule].description,
      enabled: row?.enabled ?? true,
      settings: (parsed.success ? parsed.data : RULES[rule].settings.parse({})) as Record<string, number>,
    };
  });
}

export const ruleUpdateSchema = z.object({ enabled: z.boolean().optional(), settings: z.record(z.string(), z.number()).optional() });

/** Turns a rule on or off, or changes its thresholds (problem managers). Audited with before and after. */
export async function setRule(user: User, rule: string, input: z.infer<typeof ruleUpdateSchema>) {
  authorize(user, 'candidate.rule');
  if (!(RULE_IDS as string[]).includes(rule)) throw notFound(`Unknown candidate rule "${rule}". Rules: ${RULE_IDS.join(', ')}.`);
  const id = rule as RuleId;
  const before = (await getRules()).find((r) => r.rule === id)!;
  const settings = RULES[id].settings.parse({ ...before.settings, ...input.settings });
  const enabled = input.enabled ?? before.enabled;
  await tx(async (db) => {
    await db.query(
      `INSERT INTO candidate_rules (rule, enabled, settings, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (rule) DO UPDATE SET enabled = excluded.enabled, settings = excluded.settings, updated_by = excluded.updated_by, updated_at = now()`,
      [id, enabled, settings, user.id],
    );
    await audit(db, {
      entity_type: 'setting', entity_ref: `candidate_rule:${id}`, action: 'update',
      changes: { enabled: { from: before.enabled, to: enabled }, settings: { from: before.settings, to: settings } },
    });
  });
  return (await getRules()).find((r) => r.rule === id)!;
}

// ---- Candidates -------------------------------------------------------------------------------------------------

/** One piece of evidence. key identifies it across rules: r:<external record id>, i:<incident ref>, a:<alert id>, x:<reported id>. */
export interface EvidenceRecord {
  key: string;
  kind: 'incident' | 'event' | 'external';
  id: number | null;
  incident_ref: string | null;
  alert_id: number | null;
  system: string;
  reference: string;
  summary: string;
  category: string;
  occurred_at: string | null;
  ci_ref: string | null;
  resolution_code?: string | null;
  url?: string | null;
}
interface EvidenceCi { ref: string; name: string; role: 'subject' | 'upstream' | 'affected'; depth?: number }

interface Raw {
  key: string;
  rule: RuleId;
  subject: { type: 'ci' | 'service' | 'incident' | 'category' | 'reported'; ref: string | null; name: string };
  service: string;
  ci_ref: string | null;
  ci_class: string | null;
  records: EvidenceRecord[];
  cis: EvidenceCi[];
  notes?: string;
  source?: string;
  contains_personal_data?: boolean;
  /** A title for the problem; from Kernel text only where it may be copied (checked in draft()). */
  title: (records: EvidenceRecord[]) => string;
  /** The reason for these records, or null when they no longer meet the rule (after a dismissal took some away). */
  finish: (records: EvidenceRecord[]) => string | null;
}

/** Shown per candidate; the full list is used server side when a problem is logged from it. */
const EVIDENCE_SHOWN = 50;
const LIMIT = 200;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const recordWords = (rs: EvidenceRecord[]) => {
  const inc = rs.filter((r) => r.kind === 'incident').length, ev = rs.length - inc;
  return inc && ev ? `${plural(inc, 'incident')} and ${plural(ev, 'event')}` : inc ? plural(inc, 'incident') : plural(ev, 'event');
};
const named = (name: string, ref: string | null) => (ref ? `${name} (${ref})` : name);

/** Unlinked records of the last $1 days: external records, native incidents (#28) and alerts (#30), each with one CI. */
const RECORDS_SQL = `
  SELECT 'r:' || r.id AS key, r.id, NULL::text AS incident_ref, NULL::bigint AS alert_id, r.system, r.kind, r.reference, r.summary, r.category,
         r.occurred_at, r.service, r.ci_id
  FROM external_records r
  WHERE r.problem_id IS NULL AND NOT r.dismissed AND r.occurred_at > now() - $1 * interval '1 day'
  UNION ALL
  SELECT 'i:' || i.ref, NULL, i.ref, NULL, 'Kernel', 'incident', i.ref, i.title, coalesce(cat.name, ''), i.created_at, '',
         (SELECT x.ci_id FROM incident_cis x JOIN configuration_items c ON c.id = x.ci_id WHERE x.incident_id = i.id ORDER BY c.criticality, c.id LIMIT 1)
  FROM incidents i LEFT JOIN categories cat ON cat.id = i.category_id
  WHERE i.problem_id IS NULL AND NOT i.candidate_dismissed AND i.created_at > now() - $1 * interval '1 day'
    AND i.resolution_code IS DISTINCT FROM 'duplicate' AND i.resolution_code IS DISTINCT FROM 'cancelled'
  UNION ALL
  -- Alerts from monitoring that did not become an incident and no problem explains yet.
  SELECT 'a:' || a.id, NULL, NULL, a.id, a.source, 'event', a.check_key, a.message, '', a.first_seen, a.ci_hint, a.ci_id
  FROM alerts a
  WHERE a.problem_id IS NULL AND a.incident_id IS NULL AND NOT a.candidate_dismissed AND a.suppressed = ''
    AND a.first_seen > now() - $1 * interval '1 day'`;

const RECORD_JSON = (r: string, ci: string) => `json_build_object('key', ${r}.key, 'kind', ${r}.kind, 'id', ${r}.id, 'incident_ref', ${r}.incident_ref, 'alert_id', ${r}.alert_id,
  'system', ${r}.system, 'reference', ${r}.reference, 'summary', ${r}.summary, 'category', ${r}.category, 'occurred_at', ${r}.occurred_at, 'ci_ref', ${ci}.ref)`;

async function recurringRecords(db: Db, s: Settings<'recurring_records'>): Promise<Raw[]> {
  const { rows } = await db.query(
    `WITH recs AS (${RECORDS_SQL})
     SELECT coalesce(c.name, nullif(r.service, ''), 'Unspecified') AS service, c.ref AS ci_ref, c.class AS ci_class,
            json_agg(${RECORD_JSON('r', 'c')} ORDER BY r.occurred_at DESC) AS records
     FROM recs r LEFT JOIN configuration_items c ON c.id = r.ci_id
     GROUP BY 1, 2, 3 HAVING count(*) >= $2 ORDER BY count(*) DESC LIMIT ${LIMIT}`,
    [s.window_days, s.min_records],
  );
  return rows.map((g) => ({
    key: g.ci_ref ? `recurring_records:ci:${g.ci_ref}` : `recurring_records:service:${String(g.service).toLowerCase()}`,
    rule: 'recurring_records',
    subject: { type: g.ci_ref ? (g.ci_class === 'service' ? 'service' : 'ci') : 'service', ref: g.ci_ref, name: g.service },
    service: g.service, ci_ref: g.ci_ref, ci_class: g.ci_class,
    records: g.records,
    cis: g.ci_ref ? [{ ref: g.ci_ref, name: g.service, role: 'subject' }] : [],
    title: (rs) => `Recurring ${rs.filter((r) => r.kind === 'incident').length * 2 >= rs.length ? 'incidents' : 'events'} on ${g.service}`,
    finish: (rs) => (rs.length >= s.min_records ? `${recordWords(rs)} on ${named(g.service, g.ci_ref)} in ${s.window_days} days, none linked to a problem` : null),
  }));
}

/**
 * Incidents on different CIs that depend on the same CI. The walk goes down the dependency graph (the way an outage
 * does not travel: from each incident's CI to what it runs on, uses or connects to), with a depth limit and a path
 * check against cycles. An incident on the shared CI itself counts too. When several shared CIs explain exactly the
 * same incidents, only the closest is kept: the database under three apps, not the data centre under everything.
 */
async function commonUpstream(db: Db, s: Settings<'common_upstream'>): Promise<Raw[]> {
  const { rows } = await db.query(
    `WITH RECURSIVE edges AS (
       SELECT CASE WHEN t.propagation = 'forward' THEN r.from_ci ELSE r.to_ci END AS dependent,
              CASE WHEN t.propagation = 'forward' THEN r.to_ci ELSE r.from_ci END AS dependency
       FROM ci_relationships r JOIN ci_relationship_types t ON t.name = r.type
     ),
     recs AS (
       SELECT 'i:' || i.ref AS key, 'incident' AS kind, NULL::int AS id, i.ref AS incident_ref, NULL::bigint AS alert_id, 'Kernel' AS system, i.ref AS reference,
              i.title AS summary, coalesce(cat.name, '') AS category, i.created_at AS occurred_at, x.ci_id
       FROM incidents i JOIN incident_cis x ON x.incident_id = i.id LEFT JOIN categories cat ON cat.id = i.category_id
       WHERE i.problem_id IS NULL AND NOT i.candidate_dismissed AND i.created_at > now() - $1 * interval '1 day'
         AND i.resolution_code IS DISTINCT FROM 'duplicate' AND i.resolution_code IS DISTINCT FROM 'cancelled'
       UNION ALL
       SELECT 'r:' || r.id, 'incident', r.id, NULL, NULL, r.system, r.reference, r.summary, r.category, r.occurred_at, r.ci_id
       FROM external_records r
       WHERE r.kind = 'incident' AND r.ci_id IS NOT NULL AND r.problem_id IS NULL AND NOT r.dismissed AND r.occurred_at > now() - $1 * interval '1 day'
     ),
     starts AS (SELECT DISTINCT ci_id FROM recs),
     walk (start, upstream, depth, path) AS (
       SELECT s.ci_id, e.dependency, 1, ARRAY[s.ci_id, e.dependency] FROM starts s JOIN edges e ON e.dependent = s.ci_id
       UNION ALL
       SELECT w.start, e.dependency, w.depth + 1, w.path || e.dependency FROM walk w JOIN edges e ON e.dependent = w.upstream
       WHERE w.depth < $3 AND e.dependency <> ALL (w.path)
     ),
     reach AS (SELECT start, upstream, min(depth) AS depth FROM walk GROUP BY 1, 2 UNION ALL SELECT ci_id, ci_id, 0 FROM starts),
     hits AS (
       SELECT DISTINCT ON (x.upstream, r.key) x.upstream, x.depth, r.*
       FROM recs r JOIN reach x ON x.start = r.ci_id ORDER BY x.upstream, r.key, x.depth
     )
     SELECT u.ref AS upstream_ref, u.name AS upstream_name, max(h.depth)::int AS depth,
            json_agg(${RECORD_JSON('h', 'c')} ORDER BY h.occurred_at DESC) AS records,
            json_agg(DISTINCT jsonb_build_object('ref', c.ref, 'name', c.name, 'depth', h.depth)) AS cis
     FROM hits h JOIN configuration_items u ON u.id = h.upstream JOIN configuration_items c ON c.id = h.ci_id
     WHERE u.class <> 'service'
     GROUP BY u.id HAVING count(*) >= $2 AND count(DISTINCT h.ci_id) >= $4
     ORDER BY count(*) DESC LIMIT ${LIMIT}`,
    [s.window_days, s.min_records, s.max_depth, s.min_cis],
  );
  // The closest shared CI wins when several explain the same incidents.
  const best = new Map<string, any>();
  for (const g of rows) {
    const set = g.records.map((r: EvidenceRecord) => r.key).sort().join(',');
    const seen = best.get(set);
    if (!seen || g.depth < seen.depth) best.set(set, g);
  }
  const distinctCis = (rs: EvidenceRecord[]) => new Set(rs.map((r) => r.ci_ref)).size;
  return [...best.values()].map((g) => ({
    key: `common_upstream:ci:${g.upstream_ref}`,
    rule: 'common_upstream',
    subject: { type: 'ci', ref: g.upstream_ref, name: g.upstream_name },
    service: g.upstream_name, ci_ref: g.upstream_ref, ci_class: 'ci',
    records: g.records,
    cis: [
      { ref: g.upstream_ref, name: g.upstream_name, role: 'upstream' },
      ...g.cis.filter((c: EvidenceCi) => c.ref !== g.upstream_ref).sort((a: EvidenceCi, b: EvidenceCi) => a.name.localeCompare(b.name)).map((c: EvidenceCi) => ({ ...c, role: 'affected' as const })),
    ],
    title: () => `Incidents on CIs that depend on ${g.upstream_name}`,
    finish: (rs) => (rs.length >= s.min_records && distinctCis(rs) >= s.min_cis
      ? `${plural(rs.length, 'incident')} on ${distinctCis(rs)} different CIs in ${s.window_days} days all depend on ${named(g.upstream_name, g.upstream_ref)}, none linked to a problem`
      : null),
  }));
}

async function majorWithoutProblem(db: Db, s: Settings<'major_without_problem'>): Promise<Raw[]> {
  const { rows } = await db.query(
    `SELECT i.ref, i.title, i.resolved_at, i.resolution_code, coalesce(cat.name, '') AS category, c.ref AS ci_ref, c.name AS ci_name, c.class AS ci_class,
            (SELECT coalesce(json_agg(json_build_object('key', 'i:' || ch.ref, 'kind', 'incident', 'id', NULL, 'incident_ref', ch.ref, 'alert_id', NULL, 'system', 'Kernel',
                     'reference', ch.ref, 'summary', ch.title, 'category', '', 'occurred_at', ch.created_at, 'ci_ref', NULL) ORDER BY ch.id), '[]')
             FROM incidents ch WHERE ch.parent_id = i.id AND ch.problem_id IS NULL) AS related
     FROM incidents i LEFT JOIN categories cat ON cat.id = i.category_id
     LEFT JOIN LATERAL (SELECT c.ref, c.name, c.class FROM incident_cis x JOIN configuration_items c ON c.id = x.ci_id WHERE x.incident_id = i.id ORDER BY c.criticality, c.id LIMIT 1) c ON true
     WHERE i.is_major AND i.problem_id IS NULL AND NOT i.candidate_dismissed AND i.status IN ('resolved', 'closed')
       AND i.resolved_at > now() - $1 * interval '1 day'
       AND i.resolution_code IS DISTINCT FROM 'duplicate' AND i.resolution_code IS DISTINCT FROM 'cancelled'
       AND NOT EXISTS (SELECT 1 FROM problem_links l WHERE l.kind = 'incident' AND l.system = 'Kernel' AND l.reference = i.ref)
     ORDER BY i.resolved_at DESC LIMIT ${LIMIT}`,
    [s.window_days],
  );
  return rows.map((i) => {
    const main: EvidenceRecord = {
      key: `i:${i.ref}`, kind: 'incident', id: null, incident_ref: i.ref, alert_id: null, system: 'Kernel', reference: i.ref, summary: i.title,
      category: i.category, occurred_at: i.resolved_at, ci_ref: i.ci_ref, resolution_code: i.resolution_code,
    };
    return {
      key: `major_without_problem:incident:${i.ref}`,
      rule: 'major_without_problem' as const,
      subject: { type: 'incident' as const, ref: i.ref, name: i.ref },
      service: i.ci_name ?? '', ci_ref: i.ci_ref, ci_class: i.ci_class,
      records: [main, ...i.related],
      cis: i.ci_ref ? [{ ref: i.ci_ref, name: i.ci_name, role: 'affected' as const }] : [],
      title: () => `Underlying cause of major incident ${i.ref}`,
      finish: (rs: EvidenceRecord[]) => (rs.some((r) => r.key === main.key)
        ? `Major incident ${i.ref} was resolved ${new Date(i.resolved_at).toISOString().slice(0, 10)} without a problem record, so its underlying cause is not being managed${rs.length > 1 ? ` (${plural(rs.length - 1, 'related incident')})` : ''}`
        : null),
    };
  });
}

const RESOLUTION_LABEL: Record<string, string> = { fixed: 'fixed', workaround: 'a workaround', no_fault_found: 'no fault found' };

async function recurringResolution(db: Db, s: Settings<'recurring_resolution'>): Promise<Raw[]> {
  const { rows } = await db.query(
    `SELECT i.category_id, cat.name AS category, i.resolution_code,
            json_agg(json_build_object('key', 'i:' || i.ref, 'kind', 'incident', 'id', NULL, 'incident_ref', i.ref, 'alert_id', NULL, 'system', 'Kernel',
              'reference', i.ref, 'summary', i.title, 'category', cat.name, 'occurred_at', i.resolved_at, 'resolution_code', i.resolution_code,
              'ci_ref', (SELECT c.ref FROM incident_cis x JOIN configuration_items c ON c.id = x.ci_id WHERE x.incident_id = i.id ORDER BY c.criticality, c.id LIMIT 1))
              ORDER BY i.resolved_at DESC) AS records
     FROM incidents i JOIN categories cat ON cat.id = i.category_id
     WHERE i.problem_id IS NULL AND NOT i.candidate_dismissed AND i.resolved_at > now() - $1 * interval '1 day'
       AND i.resolution_code IN ('fixed', 'workaround', 'no_fault_found')
     GROUP BY 1, 2, 3 HAVING count(*) >= $2 ORDER BY count(*) DESC LIMIT ${LIMIT}`,
    [s.window_days, s.min_records],
  );
  return rows.map((g) => {
    const how = RESOLUTION_LABEL[g.resolution_code] ?? g.resolution_code;
    return {
      key: `recurring_resolution:category:${g.category_id}:${g.resolution_code}`,
      rule: 'recurring_resolution' as const,
      subject: { type: 'category' as const, ref: null, name: `${g.category} · ${String(g.resolution_code).replace(/_/g, ' ')}` },
      service: '', ci_ref: null, ci_class: null,
      records: g.records,
      cis: [],
      title: () => `Recurring ${g.category} incidents resolved with ${how}`,
      finish: (rs: EvidenceRecord[]) => (rs.length >= s.min_records
        ? `${plural(rs.length, 'incident')} in ${g.category} resolved with ${how} in ${s.window_days} days, none linked to a problem${g.resolution_code === 'workaround' ? ': the same workaround keeps being applied' : ''}`
        : null),
    };
  });
}

async function reportedCandidates(db: Db): Promise<Raw[]> {
  const { rows } = await db.query(
    `SELECT rc.id, rc.source, rc.title, rc.reason, rc.service, rc.evidence, rc.contains_personal_data, rc.first_reported_at, rc.last_reported_at, c.ref AS ci_ref, c.name AS ci_name, c.class AS ci_class
     FROM reported_candidates rc LEFT JOIN configuration_items c ON c.id = rc.ci_id
     WHERE rc.problem_ref IS NULL ORDER BY rc.last_reported_at DESC LIMIT ${LIMIT}`,
  );
  if (!rows.length) return [];
  // Kernel records named in the evidence, as the reader may see them (row-level security), and still unlinked.
  const incRefs = [...new Set(rows.flatMap((r) => r.evidence.incident_refs ?? []))];
  const alertIds = [...new Set(rows.flatMap((r) => r.evidence.alert_ids ?? []))];
  const ciRefs = [...new Set(rows.flatMap((r) => r.evidence.ci_refs ?? []))];
  const { rows: incs } = await db.query(
    `SELECT i.ref, i.title, i.created_at, coalesce(cat.name, '') AS category,
            (SELECT c.ref FROM incident_cis x JOIN configuration_items c ON c.id = x.ci_id WHERE x.incident_id = i.id ORDER BY c.criticality, c.id LIMIT 1) AS ci_ref
     FROM incidents i LEFT JOIN categories cat ON cat.id = i.category_id WHERE i.ref = ANY($1) AND i.problem_id IS NULL`,
    [incRefs],
  );
  const { rows: alerts } = await db.query(
    'SELECT a.id, a.source, a.check_key, a.message, a.first_seen, c.ref AS ci_ref FROM alerts a LEFT JOIN configuration_items c ON c.id = a.ci_id WHERE a.id = ANY($1) AND a.problem_id IS NULL',
    [alertIds],
  );
  const { rows: cis } = await db.query('SELECT ref, name FROM configuration_items WHERE ref = ANY($1)', [ciRefs]);
  const incBy = new Map(incs.map((i) => [i.ref, i])), alertBy = new Map(alerts.map((a) => [Number(a.id), a])), ciBy = new Map(cis.map((c) => [c.ref, c]));
  return rows.map((r) => {
    const own: EvidenceRecord = {
      key: `x:${r.id}`, kind: 'external', id: null, incident_ref: null, alert_id: null, system: r.source, reference: `Reported by ${r.source}`,
      summary: r.title, category: '', occurred_at: r.last_reported_at, ci_ref: r.ci_ref,
    };
    const records: EvidenceRecord[] = [
      own,
      ...(r.evidence.incident_refs ?? []).filter((ref: string) => incBy.has(ref)).map((ref: string) => {
        const i = incBy.get(ref);
        return { key: `i:${ref}`, kind: 'incident' as const, id: null, incident_ref: ref, alert_id: null, system: 'Kernel', reference: ref, summary: i.title, category: i.category, occurred_at: i.created_at, ci_ref: i.ci_ref };
      }),
      ...(r.evidence.alert_ids ?? []).filter((id: number) => alertBy.has(id)).map((id: number) => {
        const a = alertBy.get(id);
        return { key: `a:${id}`, kind: 'event' as const, id: null, incident_ref: null, alert_id: id, system: a.source, reference: a.check_key, summary: a.message, category: '', occurred_at: a.first_seen, ci_ref: a.ci_ref };
      }),
      ...(r.evidence.items ?? []).map((it: any, n: number) => ({
        key: `x:${r.id}:${n}`, kind: 'external' as const, id: null, incident_ref: null, alert_id: null, system: r.source, reference: it.reference,
        summary: it.summary ?? '', category: '', occurred_at: it.occurred_at ?? null, ci_ref: null, url: it.url ?? null,
      })),
    ];
    const name = r.ci_name ?? (r.service || r.source);
    return {
      key: `reported:${r.id}`,
      rule: 'reported' as const,
      subject: { type: 'reported' as const, ref: r.ci_ref, name },
      service: r.ci_name ?? r.service, ci_ref: r.ci_ref, ci_class: r.ci_class,
      records,
      cis: [
        ...(r.ci_ref ? [{ ref: r.ci_ref, name: r.ci_name, role: 'subject' as const }] : []),
        ...(r.evidence.ci_refs ?? []).filter((ref: string) => ciBy.has(ref) && ref !== r.ci_ref).map((ref: string) => ({ ref, name: ciBy.get(ref).name, role: 'affected' as const })),
      ],
      notes: r.evidence.notes || undefined,
      source: r.source,
      contains_personal_data: !!r.contains_personal_data,
      title: () => r.title,
      // A dismissal covers the report itself; the reporter sends a new key for a new finding.
      finish: (rs: EvidenceRecord[]) => (rs.some((x) => x.key === own.key) ? r.reason : null),
    };
  });
}

const COMPUTE: Record<RuleId, (db: Db, settings: any) => Promise<Raw[]>> = {
  recurring_records: recurringRecords, common_upstream: commonUpstream, major_without_problem: majorWithoutProblem,
  recurring_resolution: recurringResolution, reported: (db) => reportedCandidates(db),
};

interface Decision { key: string; rule: string; decision: 'dismissed' | 'snoozed'; until: string | null; evidence: string[]; reason: string; decided_by_name: string | null; decided_at: string }

export type Candidate = ReturnType<typeof present>;

function present(raw: Raw, records: EvidenceRecord[], reason: string, decision?: Decision) {
  const times = records.map((r) => r.occurred_at).filter(Boolean).sort() as string[];
  return {
    key: raw.key,
    rule: raw.rule,
    rule_label: RULES[raw.rule].label,
    reason,
    subject: raw.subject,
    service: raw.service,
    ci_ref: raw.ci_ref,
    ci_class: raw.ci_class,
    source: raw.source,
    ...(raw.contains_personal_data ? { contains_personal_data: true } : {}),
    count: records.length,
    incidents: records.filter((r) => r.kind === 'incident').length,
    events: records.filter((r) => r.kind === 'event').length,
    first_at: times[0] ?? null,
    last_at: times[times.length - 1] ?? null,
    evidence: {
      records: records.slice(0, EVIDENCE_SHOWN),
      total_records: records.length,
      cis: raw.cis,
      ...(raw.notes ? { notes: raw.notes } : {}),
    },
    ...(decision ? { decision: { decision: decision.decision, until: decision.until, reason: decision.reason, by: decision.decided_by_name, at: decision.decided_at } } : {}),
  };
}

/** A candidate with all its records (not only those shown), for logging or linking a problem. */
interface Resolved { raw: Raw; records: EvidenceRecord[]; reason: string; decision?: Decision; hidden: boolean }

/**
 * Runs the rules (all enabled ones, or one) as the viewer, with a statement timeout so a large graph cannot hold a
 * request (#65), and applies the decisions: a snooze hides a candidate until its time; a dismissal takes away the
 * evidence it was made on, and the candidate comes back only if the rest is enough for the rule on its own.
 */
async function compute(db: Db, only?: RuleId): Promise<Resolved[]> {
  await db.query("SET LOCAL statement_timeout = '10s'");
  const rules = (await getRules(db)).filter((r) => r.enabled && (!only || r.rule === only));
  // One after another: they share the transaction's connection.
  const raws: Raw[] = [];
  for (const r of rules) raws.push(...(await COMPUTE[r.rule](db, r.settings)));
  const { rows: decisions } = await db.query<Decision>(
    `SELECT d.key, d.rule, d.decision, d.until, d.evidence, d.reason, u.display_name AS decided_by_name, d.decided_at
     FROM candidate_decisions d LEFT JOIN users u ON u.id = d.decided_by WHERE d.key = ANY($1)`,
    [raws.map((r) => r.key)],
  );
  const byKey = new Map(decisions.map((d) => [d.key, d]));
  const out: Resolved[] = [];
  for (const raw of raws) {
    const d = byKey.get(raw.key);
    const snoozed = d?.decision === 'snoozed' && new Date(d.until!) > new Date();
    if (d?.decision === 'dismissed') {
      const rest = raw.records.filter((r) => !d.evidence.includes(r.key));
      const reason = raw.finish(rest);
      if (reason) out.push({ raw, records: rest, reason, hidden: false });
      else out.push({ raw, records: raw.records, reason: raw.finish(raw.records) ?? '', decision: d, hidden: true });
      continue;
    }
    out.push({ raw, records: raw.records, reason: raw.finish(raw.records) ?? '', decision: snoozed ? d : undefined, hidden: snoozed });
  }
  return out;
}

export const listQuerySchema = z.object({ rule: z.enum(RULE_IDS).optional(), show: z.enum(['open', 'hidden']).default('open') });

/** The candidates the viewer can see, with each rule's settings and how many are dismissed or snoozed. */
export async function listCandidates(opts: Partial<z.infer<typeof listQuerySchema>> = {}) {
  const show = opts.show ?? 'open';
  const all = await tx((db) => compute(db));
  const rules = await getRules();
  const counts = Object.fromEntries(RULE_IDS.map((r) => [r, all.filter((c) => c.raw.rule === r && !c.hidden).length]));
  const candidates = all
    .filter((c) => (show === 'hidden' ? c.hidden : !c.hidden) && (!opts.rule || c.raw.rule === opts.rule))
    // A major incident without a problem comes first, whatever its size; then the most evidence.
    .sort((a, b) => Number(b.raw.rule === 'major_without_problem') - Number(a.raw.rule === 'major_without_problem') || b.records.length - a.records.length)
    .map((c) => present(c.raw, c.records, c.reason, c.decision));
  return {
    rules: rules.map((r) => ({ ...r, count: counts[r.rule] })),
    hidden: { dismissed: all.filter((c) => c.hidden && c.decision?.decision === 'dismissed').length, snoozed: all.filter((c) => c.hidden && c.decision?.decision === 'snoozed').length },
    candidates,
  };
}

const keySchema = z.string().trim().min(3).max(300);
const ruleOfKey = (key: string) => {
  const rule = key.split(':')[0] as RuleId;
  if (!RULE_IDS.includes(rule)) throw badRequest(`"${key}" is not a candidate key. Keys come from list_problem_candidates.`);
  return rule;
};

async function findCandidate(db: Db, key: string, includeHidden = false) {
  const found = (await compute(db, ruleOfKey(key))).find((c) => c.raw.key === key && (includeHidden || !c.hidden));
  if (!found) throw notFound(`No candidate ${key}: it may have been handled, dismissed, or no longer meets its rule`);
  return found;
}

// ---- Decisions --------------------------------------------------------------------------------------------------

export const decisionSchema = z.object({
  key: keySchema,
  reason: z.string().max(1000),
  /** Snooze until this time instead of dismissing (at most a year ahead). */
  until: z.string().datetime({ offset: true }).optional(),
});

/** Dismisses a candidate for the evidence it has now, or snoozes it until a time. A reason is required; audited. */
export async function decideCandidate(user: User, input: z.infer<typeof decisionSchema>) {
  authorize(user, 'candidate.act');
  const reason = requireReason(input.reason);
  const until = input.until ? new Date(input.until) : null;
  if (until && (until <= new Date() || until.getTime() > Date.now() + 366 * 86_400_000)) throw badRequest('Snooze until a time in the next year');
  return tx(async (db) => {
    const c = await findCandidate(db, input.key, true);
    const decision = until ? 'snoozed' : 'dismissed';
    await db.query(
      `INSERT INTO candidate_decisions (key, rule, decision, until, evidence, reason, decided_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (key) DO UPDATE SET decision = excluded.decision, until = excluded.until, evidence = excluded.evidence, reason = excluded.reason,
         decided_by = excluded.decided_by, decided_at = now()`,
      [c.raw.key, c.raw.rule, decision, until, c.raw.records.map((r) => r.key), reason, user.id],
    );
    await audit(db, { entity_type: 'problem_candidate', entity_ref: c.raw.key, action: until ? 'snooze' : 'dismiss', reason, changes: { records: c.raw.records.length, ...(until ? { until: until.toISOString() } : {}) } });
    return { key: c.raw.key, decision, until: until?.toISOString() ?? null };
  });
}

/** Undoes a dismissal or snooze. */
export async function restoreCandidate(user: User, key: string) {
  authorize(user, 'candidate.act');
  return tx(async (db) => {
    const { rows } = await db.query('DELETE FROM candidate_decisions WHERE key = $1 RETURNING decision', [key]);
    if (!rows[0]) throw notFound(`${key} is not dismissed or snoozed`);
    await audit(db, { entity_type: 'problem_candidate', entity_ref: key, action: 'restore', changes: { was: rows[0].decision } });
    return { key, restored: true };
  });
}

// ---- Reported candidates ----------------------------------------------------------------------------------------

const httpUrl = z.string().trim().max(1000).refine((v) => /^https?:\/\//i.test(v), 'URL must start with http:// or https://');
export const reportSchema = z.object({
  /** The analysing system, e.g. "log-agent" or "grafana-trends". With external_key it identifies the report. */
  source: z.string().trim().min(1).max(100),
  /** The reporter's own id for this finding: reporting it again updates it instead of adding another. */
  external_key: z.string().trim().min(1).max(200),
  title: z.string().trim().min(3).max(200),
  /** Why this is worth a problem, in a sentence or two. */
  reason: z.string().trim().min(3).max(2000),
  ci_ref: z.string().trim().max(30).optional(),
  service: z.string().trim().max(200).default(''),
  evidence: z.object({
    incident_refs: z.array(z.string().trim().max(20)).max(200).default([]),
    alert_ids: z.array(z.number().int()).max(200).default([]),
    ci_refs: z.array(z.string().trim().max(30)).max(100).default([]),
    /** Findings outside Kernel: log lines, dashboards, tickets. */
    items: z.array(z.object({
      reference: z.string().trim().min(1).max(200),
      summary: z.string().max(1000).default(''),
      occurred_at: z.string().datetime({ offset: true }).optional(),
      url: httpUrl.optional(),
    })).max(200).default([]),
    notes: z.string().max(10000).default(''),
  }).prefault({}),
});
/** The stored evidence, as JSON, is capped too: many long items together must not grow a row without limit. */
const MAX_EVIDENCE_BYTES = 64 * 1024;

/** Redacts secrets in every string (#61) and says whether any held personal data. */
function cleanStrings<T>(value: T, found: { personal: boolean; secrets: Set<string> }): T {
  if (typeof value === 'string') {
    const hits = scan(value);
    if (hits.some((h) => h.class === 'personal')) found.personal = true;
    if (!hits.some((h) => h.class === 'secret')) return value;
    for (const h of hits.filter((x) => x.class === 'secret')) found.secrets.add(h.type);
    return redact(value, ['secret']).text as T;
  }
  if (Array.isArray(value)) return value.map((v) => cleanStrings(v, found)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanStrings(v, found)])) as T;
  return value;
}

/**
 * A candidate from external analysis (REST/MCP), idempotent on source + external_key: the same finding reported again
 * updates it, by the same reporter only. Free text is scanned like any inbound text: secrets redacted, personal data flagged.
 */
export async function reportCandidate(user: User, input: z.infer<typeof reportSchema>) {
  authorize(user, 'candidate.report');
  const found = { personal: false, secrets: new Set<string>() };
  const clean = cleanStrings({ title: input.title, reason: input.reason, service: input.service, evidence: input.evidence }, found);
  clean.evidence.incident_refs = [...new Set(clean.evidence.incident_refs.map((r) => r.toUpperCase()))];
  clean.evidence.ci_refs = [...new Set(clean.evidence.ci_refs.map((r) => r.toUpperCase()))];
  if (Buffer.byteLength(JSON.stringify(clean.evidence)) > MAX_EVIDENCE_BYTES) throw badRequest(`The evidence is larger than ${MAX_EVIDENCE_BYTES / 1024} KB. Send references and short summaries, not whole logs.`);
  return tx(async (db) => {
    let ciId: number | null = null;
    if (input.ci_ref) {
      const { rows } = await db.query('SELECT id FROM configuration_items WHERE ref = $1', [input.ci_ref.toUpperCase()]);
      if (!rows[0]) throw badRequest(`Unknown CI ${input.ci_ref}`);
      ciId = rows[0].id;
    }
    const { rows } = await db.query(
      `INSERT INTO reported_candidates (source, external_key, title, reason, ci_id, service, evidence, contains_personal_data, reported_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (source, external_key) DO UPDATE SET title = excluded.title, reason = excluded.reason, ci_id = excluded.ci_id, service = excluded.service,
         evidence = excluded.evidence, contains_personal_data = excluded.contains_personal_data, last_reported_at = now()
       WHERE reported_candidates.reported_by = excluded.reported_by
       RETURNING id, (xmax = 0) AS created, problem_ref`,
      [input.source, input.external_key, clean.title, clean.reason, ciId, clean.service, clean.evidence, found.personal, user.id],
    );
    if (!rows[0]) throw conflict(`${input.source} / ${input.external_key} was reported by someone else. Use your own source or key.`);
    const r = rows[0];
    await audit(db, { entity_type: 'problem_candidate', entity_ref: `reported:${r.id}`, action: r.created ? 'report' : 'update', changes: { source: input.source, external_key: input.external_key, ...(found.secrets.size ? { redacted: [...found.secrets] } : {}) } });
    return { key: `reported:${r.id}`, created: r.created as boolean, problem_ref: r.problem_ref as string | null, redacted: [...found.secrets], contains_personal_data: found.personal };
  });
}

// ---- From candidate to problem ----------------------------------------------------------------------------------

/** Audiences of the Kernel incidents in the evidence, in one query; one the reader cannot see counts as the narrowest. */
async function incidentAudiences(db: Db, refs: string[]) {
  const { rows } = await db.query('SELECT ref, restricted, restricted_teams, classification FROM incidents WHERE ref = ANY($1)', [refs]);
  const by = new Map<string, Audience>(rows.map((r) => [r.ref, { ref: r.ref, restricted: !!r.restricted, restricted_teams: r.restricted_teams ?? [], classification: r.classification ?? 'normal' }]));
  return (ref: string): Audience => by.get(ref) ?? { ref, restricted: true, restricted_teams: [], classification: 'confidential' };
}

/**
 * The problem a candidate suggests: title, a description listing the reason and the evidence, its CIs and service.
 * The new problem is read by everyone, so a Kernel incident's title is copied only where the copy rules allow (#117);
 * otherwise the line keeps just the ref. With a db that is creating the problem, withheld text is audited.
 */
async function draft(db: Db, c: Resolved, creating: boolean) {
  const audienceOf = await incidentAudiences(db, c.records.filter((r) => r.incident_ref).map((r) => r.incident_ref!));
  const titleOf = async (r: EvidenceRecord) => {
    if (!r.incident_ref) return r.summary;
    const from = audienceOf(r.incident_ref);
    return creating ? copyText(db, from, BROADEST, r.summary, '', 'problem candidate → new problem', 'title') : (mayCopyText(from, BROADEST, 'title') ? r.summary : '');
  };
  const lines: string[] = [];
  for (const r of c.records.slice(0, 100)) {
    const text = (await titleOf(r)).replace(/\s+/g, ' ').slice(0, 200);
    const when = r.occurred_at ? ` (${String(r.occurred_at).slice(0, 10)})` : '';
    lines.push(`- ${r.reference}${r.ci_ref ? ` on ${r.ci_ref}` : ''}${text ? `: ${text}` : ''}${when}${r.url ? ` ${r.url}` : ''}`);
  }
  if (c.records.length > 100) lines.push(`- and ${c.records.length - 100} more`);
  let title = c.raw.title(c.records);
  // A major incident's own title says best what happened, where it may be copied.
  if (c.raw.rule === 'major_without_problem') {
    const main = c.records[0];
    const text = await titleOf(main);
    if (text) title = `${title}: ${text}`;
  }
  const cis = c.raw.cis.map((x) => `${x.name} (${x.ref}${x.role === 'upstream' ? ', shared dependency' : ''})`);
  const description = [
    `Identified from a problem candidate (${RULES[c.raw.rule].label}): ${c.reason}.`,
    '',
    'Evidence:',
    ...lines,
    ...(cis.length ? ['', `CIs: ${cis.join(', ')}`] : []),
    ...(c.raw.notes ? ['', c.raw.notes] : []),
  ].join('\n');
  return {
    title: title.slice(0, 300),
    description: description.slice(0, 20000),
    affected_service: c.raw.subject.type === 'service' || (c.raw.service && !c.raw.ci_ref) ? c.raw.service.slice(0, 200) : '',
    detection: detectionOf(c.raw.rule, c.records),
    ci_refs: c.raw.cis.map((x) => x.ref),
  };
}

/** Problems found from incidents that already happened are reactive; only events, or external analysis, proactive. */
export function detectionOf(rule: RuleId, records: EvidenceRecord[]): 'reactive' | 'proactive' {
  if (rule === 'recurring_records') return records.some((r) => r.kind === 'incident') ? 'reactive' : 'proactive';
  return RULES[rule].detection;
}

/** The prefilled problem for a candidate, as the form shows it before anything is created. */
export async function candidateDraft(user: User, key: string) {
  authorize(user, 'candidate.act');
  return tx(async (db) => {
    const c = await findCandidate(db, key);
    return { key, ...(await draft(db, c, false)), records: c.records.length };
  });
}

export const candidateIdsSchema = z.object({
  record_ids: z.array(z.number().int()).max(1000).default([]),
  /** Native incidents (INC…) in the candidate. */
  incident_refs: z.array(z.string().max(20)).max(1000).default([]),
  /** Monitoring alerts in the candidate. */
  alert_ids: z.array(z.number().int()).max(1000).default([]),
});
/** A candidate by key (preferred: Kernel takes its evidence), or its records by id. */
export const candidateActionSchema = candidateIdsSchema.extend({ key: keySchema.optional() })
  .refine((v) => v.key || v.record_ids.length + v.incident_refs.length + v.alert_ids.length > 0, 'Give the candidate key, or record_ids, incident_refs or alert_ids');
type Ids = z.infer<typeof candidateIdsSchema>;

const idsOf = (records: EvidenceRecord[]): Ids => ({
  record_ids: records.filter((r) => r.id !== null).map((r) => r.id!),
  incident_refs: records.filter((r) => r.incident_ref).map((r) => r.incident_ref!),
  alert_ids: records.filter((r) => r.alert_id !== null).map((r) => Number(r.alert_id)),
});

/** Links records to a problem in the caller's transaction: external records, alerts and Kernel incidents (with related incidents). */
async function linkEvidence(db: Db, user: User, problem: { id: number; ref: string }, ids: Ids) {
  let linked = 0;
  if (ids.record_ids.length) {
    const { rows } = await db.query('SELECT * FROM external_records WHERE id = ANY($1) AND problem_id IS NULL', [ids.record_ids]);
    for (const r of rows) {
      await linkRecord(db, user, problem, r);
      linked++;
    }
  }
  // Alerts: the problem lists them as linked events, and their CIs become affected CIs.
  const { rows: alerts } = await db.query(
    `UPDATE alerts a SET problem_id = $2 FROM (SELECT id FROM alerts WHERE id = ANY($1) AND problem_id IS NULL FOR UPDATE) x
     WHERE a.id = x.id RETURNING a.id, a.source, a.check_key, a.ci_id, a.ci_hint, (SELECT ref FROM configuration_items WHERE id = a.ci_id) AS ci_ref`,
    [ids.alert_ids, problem.id],
  );
  for (const a of alerts) {
    const reference = `${a.check_key} @ ${a.ci_ref ?? (a.ci_hint || 'unknown')}`.slice(0, 200);
    const { rowCount } = await db.query(
      `INSERT INTO problem_links (problem_id, kind, reference, system, note, created_by) VALUES ($1, 'event', $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [problem.id, reference, a.source, `Alert ${a.id}`, user.id],
    );
    if (rowCount) await logActivity(db, problem.id, user.id, 'link', `Linked event ${reference}`, { kind: 'event', reference, system: a.source, alert_id: a.id, action: 'add' });
    if (a.ci_id) await db.query('INSERT INTO problem_cis (problem_id, ci_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [problem.id, a.ci_id, user.id]);
    linked++;
  }
  // Incidents, both ways, and the related incidents of a major incident (#108) that have no problem of their own.
  const { rows: incs } = await db.query('SELECT id, ref, title FROM incidents WHERE ref = ANY($1) AND problem_id IS NULL ORDER BY id FOR UPDATE', [ids.incident_refs.map((r) => r.toUpperCase())]);
  const attached = new Set<number>();
  for (const inc of incs) {
    if (attached.has(inc.id)) continue;
    await attachToProblem(db, user.id, inc, problem);
    attached.add(inc.id);
    linked++;
    const { rows: children } = await db.query('SELECT id, ref, title FROM incidents WHERE parent_id = $1 AND problem_id IS NULL ORDER BY id FOR UPDATE', [inc.id]);
    for (const ch of children) {
      await attachToProblem(db, user.id, ch, problem);
      attached.add(ch.id);
    }
  }
  return linked;
}

/**
 * After a candidate became (part of) a problem: the problem's history says where it came from, a report is marked
 * handled, and a decision about the candidate no longer applies.
 */
async function settle(db: Db, user: User, key: string | undefined, problem: { id: number; ref: string }) {
  if (!key) return;
  const rule = RULES[ruleOfKey(key)].label;
  await logActivity(db, problem.id, user.id, 'link', `From problem candidate: ${rule}`, { kind: 'candidate', reference: key, action: 'add' });
  if (key.startsWith('reported:')) await db.query('UPDATE reported_candidates SET problem_ref = $2 WHERE id = $1', [Number(key.slice(9)) || 0, problem.ref]);
  await db.query('DELETE FROM candidate_decisions WHERE key = $1', [key]);
}

/** Fields that override the prefill. No defaults here: a field the caller did not send must not blank the prefill. */
export const problemOverridesSchema = z.object(problemFields).partial();
export const fromCandidateSchema = z.object({ problem: problemOverridesSchema.optional() });

/**
 * Logs a problem from a candidate. By key, the problem is prefilled from the evidence (title, description, CIs,
 * service) and anything given in `problem` overrides it; all the candidate's records are linked. By ids (the older
 * form), `problem` with a title is required. One transaction: the problem exists only with its links.
 */
export async function createFromCandidate(user: User, input: z.infer<typeof candidateActionSchema> & z.infer<typeof fromCandidateSchema>) {
  authorize(user, 'candidate.act');
  authorize(user, 'problem.link');
  const ref = await tx(async (db) => {
    let ids: Ids = input, prefill: Record<string, unknown> = {}, ciRefs: string[] = [];
    if (input.key) {
      const c = await findCandidate(db, input.key);
      const d = await draft(db, c, true);
      ({ ci_refs: ciRefs, ...prefill } = d);
      ids = idsOf(c.records);
    }
    const fields = createProblemSchema.parse({ ...prefill, ...input.problem });
    const ref = await createProblemInTx(db, user, fields);
    const problem = await loadForUpdate(db, ref);
    await linkEvidence(db, user, problem, ids);
    if (ciRefs.length) await db.query('INSERT INTO problem_cis (problem_id, ci_id, added_by) SELECT $1, id, $2 FROM configuration_items WHERE ref = ANY($3) ON CONFLICT DO NOTHING', [problem.id, user.id, ciRefs]);
    await settle(db, user, input.key, problem);
    return ref;
  });
  return getProblem(ref);
}

/** Links a candidate's records (by key, or by id) to an existing problem. */
export async function linkCandidate(user: User, ref: string, input: z.infer<typeof candidateActionSchema>) {
  authorize(user, 'candidate.act');
  authorize(user, 'problem.link');
  await tx(async (db) => {
    const problem = await loadForUpdate(db, ref);
    const ids = input.key ? idsOf((await findCandidate(db, input.key)).records) : input;
    const linked = await linkEvidence(db, user, problem, ids);
    // A report may name nothing in Kernel; linking it records that the problem covers the finding.
    if (!linked && !input.key?.startsWith('reported:')) throw badRequest('None of the records are unlinked any more');
    await settle(db, user, input.key, problem);
  });
  return getProblem(ref);
}
