// Finding problem candidates (#5, #31): the rules and their settings, the detectors over incidents, events and the
// CMDB, and compute, which runs the enabled rules as the viewer and applies dismissals and snoozes.
//
// Every query runs as the viewer, so row-level security decides which incidents count: a candidate never shows or
// counts a record its reader cannot see. A candidate's key is its rule plus its subject ("recurring_records:ci:CI000012").
import { z } from 'zod';
import type { User } from '../security/auth.js';
import { audit } from '../security/audit.js';
import { type Db, query, savepoint, tx } from '../core/db.js';
import { notFound } from '../core/errors.js';
import { logger } from '../core/log.js';
import { authorize } from '../security/policy.js';
import { capacityWarnings, changeCorrelation, flapping, risingWarnings, selfClearing, TREND_RULES } from './candidate-trends.js';
import { CONFIG_RULES, eolVersions, repeatedlyMissing, singlePointOfFailure } from './candidate-config.js';
import { plural } from '../core/text.js';

// ---- Rules ------------------------------------------------------------------------------------------------------

const days = (d: number) => z.number().int().min(1).max(365).default(d);
const count = (n: number) => z.number().int().min(2).max(1000).default(n);

export const RULES = {
  recurring_records: {
    label: 'Recurring records on a CI or service',
    description: 'At least min_records incidents or events on the same CI or service within window_days days, none of them linked to a problem.',
    // Reactive when incidents have happened; proactive when only events point at it (#31, ITIL 4).
    detection: 'reactive',
    proactive: false,
    settings: z.object({ min_records: count(5), window_days: days(7) }),
  },
  common_upstream: {
    label: 'Incidents sharing an underlying CI',
    description: 'At least min_records unlinked incidents on min_cis or more different CIs within window_days days that all depend on the same CI, up to max_depth steps down the dependency graph.',
    detection: 'reactive',
    proactive: false,
    settings: z.object({ min_records: count(3), min_cis: z.number().int().min(2).max(50).default(2), window_days: days(7), max_depth: z.number().int().min(1).max(5).default(3) }),
  },
  major_without_problem: {
    label: 'Major incident resolved without a problem',
    description: 'A major incident resolved within the last window_days days that no problem explains yet. Its underlying cause is not being managed.',
    detection: 'reactive',
    proactive: false,
    settings: z.object({ window_days: days(30) }),
  },
  recurring_resolution: {
    label: 'Same category and resolution',
    description: 'At least min_records incidents in the same category resolved with the same resolution code within window_days days, none linked to a problem. A workaround that keeps being applied is the classic sign.',
    detection: 'reactive',
    proactive: false,
    settings: z.object({ min_records: count(4), window_days: days(30) }),
  },
  reported: {
    label: 'Reported by external analysis',
    description: 'Candidates reported through REST or MCP (report_problem_candidate), for example by an agent analysing logs or a monitoring tool’s own trend analysis.',
    detection: 'proactive',
    proactive: true,
    settings: z.object({}),
  },
  // Trends before they hurt (part 2 of #31): candidate-trends.ts.
  ...TREND_RULES,
  // Configuration risk (part 3 of #31): candidate-config.ts.
  ...CONFIG_RULES,
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

/** Turns a rule on or off, or changes its thresholds (managers). Audited with before and after. */
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

/**
 * One piece of evidence. key identifies it across rules: r:<external record id>, i:<incident ref>, a:<alert id>, c:<change ref>, x:<reported id>,
 * ci:<CI ref> (configuration risk), m:<CI activity id> (a sync marking it missing).
 */
export interface EvidenceRecord {
  key: string;
  kind: 'incident' | 'event' | 'external' | 'change' | 'ci' | 'sync';
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
  change_ref?: string | null;
  /** A short fact about this record for this rule: "rolled back", "7 reopenings". */
  note?: string | null;
  /** Counts against the subject (a change that failed or was followed by an incident). */
  bad?: boolean;
}
/** A value per day, oldest first; split marks where the current window starts when two windows are compared. */
export interface Series { label: string; unit: string; points: { day: string; value: number }[]; split?: string }
export interface EvidenceCi { ref: string; name: string; role: 'subject' | 'upstream' | 'affected'; depth?: number }

export interface Raw {
  key: string;
  rule: RuleId;
  subject: { type: 'ci' | 'service' | 'incident' | 'category' | 'reported' | 'check' | 'version'; ref: string | null; name: string };
  service: string;
  ci_ref: string | null;
  ci_class: string | null;
  records: EvidenceRecord[];
  cis: EvidenceCi[];
  notes?: string;
  source?: string;
  contains_personal_data?: boolean;
  series?: Series[];
  /** A title for the problem; from Kernel text only where it may be copied (checked in draft()). */
  title: (records: EvidenceRecord[]) => string;
  /** The reason for these records, or null when they no longer meet the rule (after a dismissal took some away). */
  finish: (records: EvidenceRecord[]) => string | null;
}

/** Shown per candidate; the full list is used server side when a problem is logged from it. */
const EVIDENCE_SHOWN = 50;
const LIMIT = 200;

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
  WHERE a.problem_id IS NULL AND a.incident_id IS NULL AND NOT a.candidate_dismissed AND a.suppressed = '' AND a.source <> 'Kernel security'
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
 * does not travel: from each incident's CI to what it runs on, uses or connects to) over nodes, not paths, so a dense
 * graph costs nodes × depth rather than every path, and the depth limit ends cycles. An incident on the shared CI itself counts too. When several shared CIs explain exactly the
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
     -- Over nodes, not paths: UNION drops repeated (start, upstream, depth) rows, and the depth limit ends cycles.
     walk (start, upstream, depth) AS (
       SELECT s.ci_id, e.dependency, 1 FROM starts s JOIN edges e ON e.dependent = s.ci_id
       UNION
       SELECT w.start, e.dependency, w.depth + 1 FROM walk w JOIN edges e ON e.dependent = w.upstream
       WHERE w.depth < $3 AND e.dependency <> w.start
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
  flapping, rising_warnings: risingWarnings, capacity_warnings: capacityWarnings, self_clearing: selfClearing, change_correlation: changeCorrelation,
  repeatedly_missing: repeatedlyMissing, eol_versions: eolVersions, single_point_of_failure: singlePointOfFailure,
};

interface Decision { key: string; rule: string; decision: 'dismissed' | 'snoozed'; until: string | null; evidence: string[]; reason: string; decided_by_name: string | null; decided_at: string }

export function present(raw: Raw, records: EvidenceRecord[], reason: string, decision?: Decision) {
  // As ISO strings, whether the database gave a Date or a string, so they sort in time order.
  const times = records.map((r) => r.occurred_at).filter(Boolean).map((t) => new Date(t!).toISOString()).sort();
  return {
    key: raw.key,
    rule: raw.rule,
    rule_label: RULES[raw.rule].label,
    /** Before it hurts: a trend or an outside finding rather than incidents that already happened. */
    proactive: RULES[raw.rule].proactive,
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
    changes: records.filter((r) => r.kind === 'change').length,
    first_at: times[0] ?? null,
    last_at: times[times.length - 1] ?? null,
    evidence: {
      records: records.slice(0, EVIDENCE_SHOWN),
      total_records: records.length,
      cis: raw.cis,
      ...(raw.series ? { series: raw.series } : {}),
      ...(raw.notes ? { notes: raw.notes } : {}),
    },
    ...(decision ? { decision: { decision: decision.decision, until: decision.until, reason: decision.reason, by: decision.decided_by_name, at: decision.decided_at } } : {}),
  };
}

/** A candidate with all its records (not only those shown), for logging or linking a problem. */
export interface Resolved { raw: Raw; records: EvidenceRecord[]; reason: string; decision?: Decision; hidden: boolean }

/**
 * Runs the rules (all enabled ones, or one) as the viewer, with a statement timeout so a large graph cannot hold a
 * request (#65), and applies the decisions: a snooze hides a candidate until its time; a dismissal takes away the
 * evidence it was made on, and the candidate comes back only if the rest is enough for the rule on its own.
 */
export async function compute(db: Db, only?: RuleId, errors = new Map<RuleId, string>()): Promise<Resolved[]> {
  await db.query("SET LOCAL statement_timeout = '10s'");
  const rules = (await getRules(db)).filter((r) => r.enabled && (!only || r.rule === only));
  // One after another: they share the transaction's connection. Each under its own savepoint, so a rule that fails or
  // times out is reported as such and the others are still listed.
  const raws: Raw[] = [];
  for (const r of rules) {
    try {
      raws.push(...(await savepoint(db, 'candidate_rule', () => COMPUTE[r.rule](db, r.settings))));
    } catch (err) {
      logger.error({ err, rule: r.rule }, 'problem candidate rule failed');
      errors.set(r.rule, (err as { code?: string }).code === '57014' ? 'This rule timed out' : 'This rule could not run');
    }
  }
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
      else if (raw.finish(raw.records)) out.push({ raw, records: raw.records, reason: raw.finish(raw.records)!, decision: d, hidden: true });
      continue;
    }
    const reason = raw.finish(raw.records);
    // A rule's threshold may come from elsewhere than its evidence (rising warnings count event_daily): with no
    // evidence left that meets the rule, there is no candidate.
    if (!reason && !snoozed) continue;
    out.push({ raw, records: raw.records, reason: reason ?? '', decision: snoozed ? d : undefined, hidden: snoozed });
  }
  return out;
}
