// External systems (link URL templates) and inbound incident/event records. Problem candidates are in candidates.ts.
import { z } from 'zod';
import type { User } from './auth.js';
import { linkRecordCis } from './problem-cis.js';
import { audit } from './audit.js';
import { authorize } from './policy.js';
import { type Db, query, savepoint, tx } from './db.js';
import { conflict, notFound } from './errors.js';
import { LINK_KINDS, loadForUpdate, logProblem } from './problems.js';

// ---- External systems ------------------------------------------------------------------------

const template = z.string().trim().max(1000).refine((v) => v === '' || (/^https?:\/\//i.test(v) && v.includes('{ref}')), 'Template must be an http(s) URL containing {ref}');
export const systemSchema = z.object({
  name: z.string().trim().min(1).max(100),
  url_templates: z.object(Object.fromEntries(LINK_KINDS.map((k) => [k, template.optional()]))).default({}),
  active: z.boolean().default(true),
});

export async function listSystems() {
  return (await query('SELECT id, name, url_templates, active FROM external_systems ORDER BY name')).rows;
}

export async function saveSystem(user: User, id: number | null, input: z.infer<typeof systemSchema>) {
  authorize(user, 'system.manage');
  const templates = Object.fromEntries(Object.entries(input.url_templates).filter(([, v]) => v));
  try {
    const { rows } = id
      ? await query('UPDATE external_systems SET name = $2, url_templates = $3, active = $4 WHERE id = $1 RETURNING *', [id, input.name, templates, input.active])
      : await query('INSERT INTO external_systems (name, url_templates, active) VALUES ($1, $2, $3) RETURNING *', [input.name, templates, input.active]);
    if (!rows[0]) throw notFound();
    await audit(null, { entity_type: 'external_system', entity_ref: input.name, action: id ? 'update' : 'create', changes: { url_templates: templates, active: input.active } });
    return rows[0];
  } catch (err: any) {
    if (err.code === '23505') throw conflict('A system with that name already exists');
    throw err;
  }
}

/** Fills in link URLs from the system's template when the link has no URL of its own. */
export async function resolveLinkUrls<T extends { kind: string; reference: string; system: string; url: string }>(links: T[]) {
  if (!links.some((l) => !l.url && l.system)) return links;
  const systems = new Map((await listSystems()).filter((s) => s.active).map((s) => [s.name.toLowerCase(), s.url_templates]));
  return links.map((l) => {
    const tpl = !l.url && systems.get(l.system.toLowerCase())?.[l.kind];
    return tpl ? { ...l, url: tpl.replaceAll('{ref}', encodeURIComponent(l.reference)) } : l;
  });
}

// ---- Inbound records ------------------------------------------------------------------------

export const recordSchema = z.object({
  system: z.string().trim().min(1).max(100),
  kind: z.enum(['incident', 'event']),
  reference: z.string().trim().min(1).max(200),
  service: z.string().trim().max(200).default(''),
  category: z.string().trim().max(100).default(''),
  summary: z.string().trim().max(2000).default(''),
  occurred_at: z.iso.datetime({ offset: true }).optional(),
  problem_ref: z.string().trim().max(20).optional().describe('Link the record to this problem'),
  ci: z.string().trim().max(30).optional().describe('The CI or service the record concerns (CI000012/SVC000003)'),
  ci_source_system: z.string().trim().max(100).optional().describe('Or identify the CI by its source system and id'),
  ci_source_id: z.string().trim().max(300).optional(),
});
export const ingestSchema = z.object({ records: z.array(recordSchema).min(1).max(500) });


export async function linkRecord(db: Db, user: User, problem: { id: number; ref: string }, r: { kind: string; reference: string; system: string; summary?: string }) {
  const { rowCount } = await db.query(
    `INSERT INTO problem_links (problem_id, kind, reference, system, note, created_by) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [problem.id, r.kind, r.reference, r.system, r.summary ?? '', user.id],
  );
  if (rowCount) {
    await logProblem(db, problem.id, user.id, 'link', `Linked ${r.kind} ${r.reference}`, { kind: r.kind, reference: r.reference, system: r.system, action: 'add' });
    await db.query('UPDATE problems SET updated_at = now() WHERE id = $1', [problem.id]);
  }
  await db.query('UPDATE external_records SET problem_id = $1 WHERE system = $2 AND kind = $3 AND reference = $4', [problem.id, r.system, r.kind, r.reference]);
  await linkRecordCis(db, user.id, problem, r);
  return rowCount === 1;
}

/** Upserts reported records; records with problem_ref are linked to that problem (idempotent). */
export async function ingestRecords(user: User, input: z.infer<typeof ingestSchema>) {
  authorize(user, 'record.ingest');
  // One multi-row upsert for the whole batch; duplicates within the batch collapse (last one wins).
  const unique = [...new Map(input.records.map((r) => [`${r.system}\u0000${r.kind}\u0000${r.reference}`, r])).values()];
  const col = <K extends keyof (typeof unique)[number]>(k: K) => unique.map((r) => r[k] ?? null);
  let linked = 0;
  const errors: { reference: string; error: string }[] = [];
  await tx(async (db) => {
    // The CI a record concerns: by ref, by source system + id, or else by a service name that names exactly one CI.
    const { rows: byRef } = await db.query('SELECT id, ref FROM configuration_items WHERE ref = ANY($1)', [unique.map((r) => r.ci?.toUpperCase() ?? '')]);
    const refIds = new Map(byRef.map((c) => [c.ref as string, c.id as number]));
    const { rows: bySource } = await db.query(
      `SELECT s.source_system, s.source_id, s.ci_id FROM unnest($1::text[], $2::text[]) AS x(sys, sid)
       JOIN ci_sources s ON s.source_system = x.sys AND s.source_id = x.sid`,
      [unique.map((r) => r.ci_source_system ?? ''), unique.map((r) => r.ci_source_id ?? '')],
    );
    const sourceIds = new Map(bySource.map((s) => [`${s.source_system}\u0000${s.source_id}`, s.ci_id as number]));
    const ciIds = unique.map((r) => {
      // Only people get told a ref is unknown: an ingest-only token must not be able to probe which CIs exist.
      if (r.ci && !refIds.has(r.ci.toUpperCase()) && user.role !== 'integration') errors.push({ reference: r.reference, error: `Unknown CI ${r.ci}; stored without it` });
      return (r.ci && refIds.get(r.ci.toUpperCase())) || (r.ci_source_system && sourceIds.get(`${r.ci_source_system}\u0000${r.ci_source_id}`)) || null;
    });
    await db.query(
      `INSERT INTO external_records (system, kind, reference, service, category, summary, occurred_at, ci_id)
       SELECT system, kind, reference, service, category, summary, coalesce(occurred_at, now()), ci_id
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::timestamptz[], $8::int[])
         AS r(system, kind, reference, service, category, summary, occurred_at, ci_id)
       ON CONFLICT (system, kind, reference) DO UPDATE SET
         service = coalesce(nullif(excluded.service, ''), external_records.service),
         category = coalesce(nullif(excluded.category, ''), external_records.category),
         summary = coalesce(nullif(excluded.summary, ''), external_records.summary),
         ci_id = coalesce(excluded.ci_id, external_records.ci_id)`,
      [col('system'), col('kind'), col('reference'), col('service'), col('category'), col('summary'), col('occurred_at'), ciIds],
    );
    await db.query(
      `WITH unique_names AS (
         SELECT lower(name) AS name, min(id) AS id FROM configuration_items WHERE status <> 'retired' GROUP BY lower(name) HAVING count(*) = 1)
       UPDATE external_records r SET ci_id = u.id FROM unique_names u, unnest($1::text[], $2::text[], $3::text[]) AS x(system, kind, reference)
       WHERE r.ci_id IS NULL AND r.service <> '' AND u.name = lower(trim(r.service))
         AND r.system = x.system AND r.kind = x.kind AND r.reference = x.reference`,
      [col('system'), col('kind'), col('reference')],
    );
    for (const r of unique.filter((r) => r.problem_ref)) {
      // A savepoint per link, so one bad problem_ref does not undo the batch.
      try {
        const ok = await savepoint(db, 'link', async () => linkRecord(db, user, await loadForUpdate(db, r.problem_ref!), r));
        if (ok) linked++;
      } catch (err) {
        errors.push({ reference: r.reference, error: (err as Error).message });
      }
    }
  });
  return { stored: unique.length, linked, errors };
}
