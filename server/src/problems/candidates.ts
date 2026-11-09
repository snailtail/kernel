// Handling problem candidates (#5, #31): listing them, decisions (dismiss or snooze, per candidate key), candidates
// reported by external analysis, and turning a candidate into a problem. Finding them is in candidate-detection.ts.
// Candidates are computed on read; only rule settings, decisions and reported candidates are stored.
import { z } from 'zod';
import { longText, title } from '../core/fields.js';
import type { User } from '../security/auth.js';
import { audit, requireReason } from '../security/audit.js';
import { audienceOf, BROADEST, copyText, mayCopyText, titleAudience, type Audience } from '../security/audience.js';
import { type Db, tx } from '../core/db.js';
import { badRequest, conflict, HttpError, notFound } from '../core/errors.js';
import { attachToProblem } from '../incidents/incidents.js';
import { linkRecord } from '../integrations/integrations.js';
import { authorize } from '../security/policy.js';
import { createProblemInTx, createProblemSchema, getProblem, loadForUpdate, logProblem, problemFields } from './problems.js';
import { redact, scan } from '../security/scanner.js';
import { compute, type EvidenceRecord, getRules, present, type Resolved, RULE_IDS, type RuleId, RULES } from './candidate-detection.js';

export const listQuerySchema = z.object({ rule: z.enum(RULE_IDS).optional(), show: z.enum(['open', 'hidden']).default('open') });

/** The candidates the viewer can see, with each rule's settings and how many are dismissed or snoozed. */
export async function listCandidates(opts: Partial<z.infer<typeof listQuerySchema>> = {}) {
  const show = opts.show ?? 'open';
  const errors = new Map<RuleId, string>();
  const all = await tx((db) => compute(db, undefined, errors));
  const rules = await getRules();
  const counts = Object.fromEntries(RULE_IDS.map((r) => [r, all.filter((c) => c.raw.rule === r && !c.hidden).length]));
  const candidates = all
    .filter((c) => (show === 'hidden' ? c.hidden : !c.hidden) && (!opts.rule || c.raw.rule === opts.rule))
    // A major incident without a problem comes first, whatever its size; then the most evidence.
    .sort((a, b) => Number(b.raw.rule === 'major_without_problem') - Number(a.raw.rule === 'major_without_problem') || b.records.length - a.records.length)
    .map((c) => present(c.raw, c.records, c.reason, c.decision));
  return {
    rules: rules.map((r) => ({ ...r, count: counts[r.rule], ...(errors.has(r.rule) ? { error: errors.get(r.rule) } : {}) })),
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
  const errors = new Map<RuleId, string>();
  const found = (await compute(db, ruleOfKey(key), errors)).find((c) => c.raw.key === key && (includeHidden || !c.hidden));
  if (errors.size) throw new HttpError(503, `${[...errors.values()][0]}; try again later`);
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
  title,
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
    notes: longText.default(''),
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

/** Audiences of the Kernel incidents and changes in the evidence; one the reader cannot see counts as the narrowest. */
async function recordAudiences(db: Db, records: EvidenceRecord[]) {
  const inc = records.filter((r) => r.incident_ref).map((r) => r.incident_ref!), chg = records.filter((r) => r.change_ref).map((r) => r.change_ref!);
  const { rows } = await db.query(
    `SELECT ref, restricted, restricted_teams, classification FROM incidents WHERE ref = ANY($1)
     UNION ALL SELECT ref, restricted, restricted_teams, classification FROM changes WHERE ref = ANY($2)`,
    [inc, chg],
  );
  const by = new Map<string, Audience>(rows.map((r) => [r.ref, { ref: r.ref, restricted: !!r.restricted, restricted_teams: r.restricted_teams ?? [], classification: r.classification ?? 'normal' }]));
  return (ref: string): Audience => by.get(ref) ?? { ref, restricted: true, restricted_teams: [], classification: 'confidential' };
}

/**
 * The problem a candidate suggests: title, a description listing the reason and the evidence, its CIs and service.
 * The new problem is read by everyone, so a Kernel incident's title is copied only where the copy rules allow (#117);
 * otherwise the line keeps just the ref. With a db that is creating the problem, withheld text is audited.
 */
async function draft(db: Db, c: Resolved, creating: boolean) {
  const audience = await recordAudiences(db, c.records);
  const titleOf = async (r: EvidenceRecord) => {
    const ref = r.incident_ref ?? r.change_ref;
    if (!ref) return r.summary;
    const from = audience(ref);
    return creating ? copyText(db, from, BROADEST, r.summary, '', 'problem candidate → new problem', 'title') : (mayCopyText(from, BROADEST, 'title') ? r.summary : '');
  };
  const lines: string[] = [];
  for (const r of c.records.slice(0, 100)) {
    const text = (await titleOf(r)).replace(/\s+/g, ' ').slice(0, 200);
    const when = r.occurred_at ? ` (${String(r.occurred_at).slice(0, 10)})` : '';
    lines.push(`- ${r.reference}${r.ci_ref ? ` on ${r.ci_ref}` : ''}${text ? `: ${text}` : ''}${r.note ? ` [${r.note}]` : ''}${when}${r.url ? ` ${r.url}` : ''}`);
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
function detectionOf(rule: RuleId, records: EvidenceRecord[]): 'reactive' | 'proactive' {
  if (rule === 'recurring_records' || rule === 'change_correlation') return records.some((r) => r.kind === 'incident') ? 'reactive' : 'proactive';
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
  /** Changes in the candidate (change correlation). */
  change_refs: z.array(z.string().max(20)).max(1000).default([]),
});
/** A candidate by key (preferred: Kernel takes its evidence), or its records by id. */
export const candidateActionSchema = candidateIdsSchema.extend({ key: keySchema.optional() })
  .refine((v) => v.key || v.record_ids.length + v.incident_refs.length + v.alert_ids.length + v.change_refs.length > 0, 'Give the candidate key, or record_ids, incident_refs, alert_ids or change_refs');
type Ids = z.infer<typeof candidateIdsSchema>;

const idsOf = (records: EvidenceRecord[]): Ids => ({
  record_ids: records.filter((r) => r.id !== null).map((r) => r.id!),
  incident_refs: records.filter((r) => r.incident_ref).map((r) => r.incident_ref!),
  alert_ids: records.filter((r) => r.alert_id !== null).map((r) => Number(r.alert_id)),
  change_refs: records.filter((r) => r.change_ref).map((r) => r.change_ref!),
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
    if (rowCount) await logProblem(db, problem.id, user.id, 'link', `Linked event ${reference}`, { kind: 'event', reference, system: a.source, alert_id: a.id, action: 'add' });
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
  // Changes: a link on the problem (with the change's title where the copy rules allow), and their CIs.
  const { rows: chgs } = await db.query('SELECT id, ref, title FROM changes WHERE ref = ANY($1) ORDER BY id', [ids.change_refs.map((r) => r.toUpperCase())]);
  const target = titleAudience(await audienceOf(db, problem.ref));
  for (const ch of chgs) {
    const note = await copyText(db, await audienceOf(db, ch.ref), target, ch.title.slice(0, 2000), '', 'problem candidate → change link note', 'title');
    const { rowCount } = await db.query(
      `INSERT INTO problem_links (problem_id, kind, reference, system, note, created_by) VALUES ($1, 'change', $2, 'Kernel', $3, $4) ON CONFLICT DO NOTHING`,
      [problem.id, ch.ref, note, user.id],
    );
    if (rowCount) await logProblem(db, problem.id, user.id, 'link', `Linked change ${ch.ref}`, { kind: 'change', reference: ch.ref, system: 'Kernel', action: 'add' });
    await db.query('INSERT INTO problem_cis (problem_id, ci_id, added_by) SELECT $1, ci_id, $2 FROM change_cis WHERE change_id = $3 ON CONFLICT DO NOTHING', [problem.id, user.id, ch.id]);
    linked++;
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
  await logProblem(db, problem.id, user.id, 'link', `From problem candidate: ${rule}`, { kind: 'candidate', reference: key, action: 'add' });
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
    const c = input.key ? await findCandidate(db, input.key) : null;
    const linked = await linkEvidence(db, user, problem, c ? idsOf(c.records) : input);
    // A candidate's CIs become the problem's affected CIs (configuration risk has nothing else to link).
    if (c?.raw.cis.length) await db.query('INSERT INTO problem_cis (problem_id, ci_id, added_by) SELECT $1, id, $2 FROM configuration_items WHERE ref = ANY($3) ON CONFLICT DO NOTHING', [problem.id, user.id, c.raw.cis.map((x) => x.ref)]);
    // By key, linking records that the problem covers the candidate even when nothing in it was linkable.
    if (!linked && !c) throw badRequest('None of the records are unlinked any more');
    await settle(db, user, input.key, problem);
  });
  return getProblem(ref);
}
