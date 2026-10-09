// CMDB (#16): configuration items and services as pointers to where they really live. Every CI keeps its source
// links (vCenter, Azure, OP5…); attributes are a small typed set per CI type. Changes are audited like any record.
import { z } from 'zod';
import type pg from 'pg';
import type { User } from './auth.js';
import { audit } from './audit.js';
import { currentContext } from './context.js';
import { query, tx } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { authorize } from './policy.js';
import { recordUrl, registerRecordType, type RecordType } from './records.js';

type Db = Pick<pg.PoolClient, 'query'>;

export const CI_STATUSES = ['planned', 'active', 'maintenance', 'retired', 'missing'] as const;
export const ENVIRONMENTS = ['prod', 'test', 'dev', 'other'] as const;
export const CI_LINK_KINDS = ['incident', 'event', 'change', 'problem', 'document'] as const;

const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => v === '' || /^https?:\/\//i.test(v), 'URL must start with http:// or https://');

const ciFields = {
  name: z.string().trim().min(1).max(200),
  ci_type: z.string().trim().min(1).max(50),
  environment: z.enum(ENVIRONMENTS),
  criticality: z.number().int().min(1).max(4),
  owner_id: z.number().int().nullable(),
  team: z.string().trim().max(100),
  description: z.string().max(20000),
  tags: z.array(z.string().trim().min(1).max(50)).max(30),
  attributes: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])),
};

export const createCiSchema = z
  .object({
    ...ciFields,
    status: z.enum(CI_STATUSES).default('active'),
    source: z.object({ system: z.string().trim().min(1).max(100), id: z.string().trim().min(1).max(300), url: httpUrl.default('') }).optional(),
  })
  .partial()
  .required({ name: true, ci_type: true });

export const updateCiSchema = z.object(ciFields).partial().extend({ base: z.object(ciFields).partial().optional() });

export const listCisSchema = z.object({
  q: z.string().trim().max(200).optional(),
  class: z.enum(['ci', 'service', 'all']).default('all'),
  type: z.string().max(50).optional(),
  status: z.union([z.enum(CI_STATUSES), z.literal('current'), z.literal('all')]).default('current'),
  environment: z.enum(ENVIRONMENTS).optional(),
  team: z.string().max(100).optional(),
  tag: z.string().max(50).optional(),
  source: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const transitionCiSchema = z.object({ to: z.enum(CI_STATUSES), comment: z.string().max(5000).optional() });

export const ciLinkSchema = z.object({
  kind: z.enum(CI_LINK_KINDS),
  reference: z.string().trim().min(1).max(200),
  system: z.string().trim().max(100).default(''),
  url: httpUrl.default(''),
  note: z.string().trim().max(2000).default(''),
});

/** Batch upsert from connectors and integrations, identified by source system + source id. */
export const upsertSchema = z.object({
  items: z
    .array(
      z.object({
        source_system: z.string().trim().min(1).max(100),
        source_id: z.string().trim().min(1).max(300),
        source_url: httpUrl.default(''),
        name: z.string().trim().min(1).max(200),
        ci_type: z.string().trim().min(1).max(50),
        environment: z.enum(ENVIRONMENTS).optional(),
        status: z.enum(CI_STATUSES).optional(),
        team: z.string().trim().max(100).optional(),
        tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
        attributes: ciFields.attributes.optional(),
      }),
    )
    .min(1)
    .max(1000),
  /** Required when a person updates records another account reported; recorded in the audit trail. */
  override_reason: z.string().trim().max(1000).optional(),
});

const SELECT_CI = `
  SELECT c.id, c.ref, c.class, c.name, c.ci_type, t.label AS type_label, c.status, c.environment, c.criticality,
         c.owner_id, o.display_name AS owner, c.team, c.description, c.tags, c.attributes, c.created_at, c.updated_at,
         (SELECT max(s.last_seen_at) FROM ci_sources s WHERE s.ci_id = c.id) AS last_seen_at,
         (SELECT array_agg(DISTINCT s.source_system) FROM ci_sources s WHERE s.ci_id = c.id) AS source_systems
  FROM configuration_items c JOIN ci_types t ON t.name = c.ci_type LEFT JOIN users o ON o.id = c.owner_id`;

// ---- Types -------------------------------------------------------------------------------------

export async function listTypes() {
  return (await query('SELECT name, label, class, attributes, active FROM ci_types ORDER BY class, label')).rows;
}

export const typeSchema = z.object({
  name: z.string().trim().min(2).max(50).regex(/^[a-z][a-z0-9_]*$/, 'Use lower case letters, digits and _'),
  label: z.string().trim().min(1).max(100),
  class: z.enum(['ci', 'service']).default('ci'),
  attributes: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]*$/), label: z.string().min(1).max(100), type: z.enum(['string', 'number']) })).max(30).default([]),
  active: z.boolean().default(true),
});

export async function saveType(user: User, input: z.infer<typeof typeSchema>) {
  authorize(user, 'ci.manage');
  await query(
    `INSERT INTO ci_types (name, label, class, attributes, active) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (name) DO UPDATE SET label = excluded.label, attributes = excluded.attributes, active = excluded.active`,
    [input.name, input.label, input.class, JSON.stringify(input.attributes), input.active],
  );
  await audit(null, { entity_type: 'ci_type', entity_ref: input.name, action: 'save', changes: input });
  return listTypes();
}

async function typeInfo(db: Db, name: string) {
  const { rows } = await db.query('SELECT name, class, attributes, active FROM ci_types WHERE name = $1', [name]);
  if (!rows[0]) throw badRequest(`Unknown CI type "${name}". See /api/ci-types.`);
  return rows[0] as { name: string; class: 'ci' | 'service'; attributes: { key: string; type: string }[]; active: boolean };
}

/** Keeps only the type's attributes, coerced to their declared types. */
function cleanAttributes(schema: { key: string; type: string }[], attrs: Record<string, unknown> | undefined) {
  const out: Record<string, unknown> = {};
  for (const a of schema) {
    const v = attrs?.[a.key];
    if (v === undefined || v === null || v === '') continue;
    if (a.type === 'number') {
      const n = Number(v);
      if (Number.isNaN(n)) throw badRequest(`Attribute ${a.key} must be a number`);
      out[a.key] = n;
    } else out[a.key] = String(v).slice(0, 500);
  }
  return out;
}

// ---- Reading -----------------------------------------------------------------------------------

export async function listCis(user: User, f: z.infer<typeof listCisSchema>) {
  authorize(user, 'ci.read');
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (f.class !== 'all') add('c.class = ?', f.class);
  if (f.type) add('c.ci_type = ?', f.type);
  if (f.status === 'current') where.push("c.status <> 'retired'");
  else if (f.status !== 'all') add('c.status = ?', f.status);
  if (f.environment) add('c.environment = ?', f.environment);
  if (f.team) add('c.team = ?', f.team);
  if (f.tag) add('? = ANY(c.tags)', f.tag);
  if (f.source) add('EXISTS (SELECT 1 FROM ci_sources s WHERE s.ci_id = c.id AND s.source_system = ?)', f.source);
  if (f.q) {
    const terms = f.q.split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}_.-]/gu, '')).filter(Boolean);
    if (terms.length) {
      params.push(terms.map((t) => `${t}:*`).join(' & '));
      const ts = params.length;
      params.push(f.q);
      // Full text on names/tags, or a match in attributes (IP, FQDN…).
      where.push(`(c.search @@ to_tsquery('simple', $${ts}) OR c.attributes::text ILIKE '%' || $${ts + 1} || '%')`);
    }
  }
  params.push(f.limit);
  const { rows } = await query(`${SELECT_CI} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.class DESC, c.criticality, lower(c.name) LIMIT $${params.length}`, params);
  return rows.map((r) => ({ ...r, type: r.class === 'service' ? 'service' : 'ci', url: urlFor(r.class, r.ref) }));
}

export async function getCi(user: User, ref: string) {
  authorize(user, 'ci.read');
  const { rows } = await query(`${SELECT_CI} WHERE c.ref = $1`, [ref.toUpperCase()]);
  if (!rows[0]) throw notFound(`${ref} not found`);
  const ci = rows[0];
  const [sources, links, activity, extra] = await Promise.all([
    query('SELECT id, source_system, source_id, source_url, first_seen_at, last_seen_at FROM ci_sources WHERE ci_id = $1 ORDER BY source_system', [ci.id]),
    query(
      `SELECT l.id, l.kind, l.reference, l.system, l.url, l.note, l.created_at, u.display_name AS created_by
       FROM ci_links l JOIN users u ON u.id = l.created_by WHERE l.ci_id = $1 ORDER BY l.kind, l.created_at`,
      [ci.id],
    ),
    query(
      `SELECT a.id, a.kind, a.body, a.data, a.channel, a.created_at, u.display_name AS user_name
       FROM ci_activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.ci_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
      [ci.id],
    ),
    ciExtras(ci.id),
  ]);
  return {
    type: ci.class === 'service' ? 'service' : 'ci',
    ...ci,
    url: urlFor(ci.class, ci.ref),
    sources: sources.rows,
    links: links.rows,
    activity: activity.rows,
    ...extra,
    next_steps: ciNextSteps(ci, sources.rows),
  };
}

/** Hook for related data added by other modules (relationships, problems…), registered at startup. */
type Extra = (ciId: number) => Promise<Record<string, unknown>>;
const extras: Extra[] = [];
export const registerCiExtra = (fn: Extra) => extras.push(fn);
async function ciExtras(ciId: number) {
  return Object.assign({}, ...(await Promise.all(extras.map((fn) => fn(ciId)))));
}

function ciNextSteps(ci: any, sources: any[]) {
  const steps = [
    { id: 'owner', label: 'Set an owner or team', hint: 'Someone accountable for the CI.', done: !!ci.owner_id || !!ci.team },
    { id: 'source', label: 'Link it to its source', hint: 'Where the CI really lives (vCenter, Azure, OP5…), so people can open it there.', done: sources.length > 0 },
    { id: 'criticality', label: 'Check the criticality', hint: '1 is business critical; used for impact and priority.', done: ci.criticality !== 3 ? true : null },
  ];
  return {
    phase: ci.class === 'service' ? 'Service record' : 'Configuration item',
    purpose: 'A pointer to something we operate, so incidents, problems and changes can say what they affect.',
    steps,
    next: ci.status === 'missing' ? 'The source no longer reports this CI: check whether it was retired.' : 'Keep owner, sources and relationships current.',
  };
}

// ---- Changing ----------------------------------------------------------------------------------

async function logCi(db: Db, ciId: number, userId: number | null, kind: string, body: string, data: object = {}) {
  await db.query('INSERT INTO ci_activity (ci_id, user_id, kind, body, data, channel) VALUES ($1, $2, $3, $4, $5, $6)', [
    ciId, userId, kind, body, JSON.stringify(data), currentContext().channel,
  ]);
  const { rows } = await db.query('SELECT ref, class FROM configuration_items WHERE id = $1', [ciId]);
  await audit(db, { entity_type: rows[0].class === 'service' ? 'service' : 'ci', entity_ref: rows[0].ref, action: kind, changes: kind === 'comment' ? { body } : (data as Record<string, unknown>) });
  await db.query('UPDATE configuration_items SET updated_at = now() WHERE id = $1', [ciId]);
}

async function loadCi(db: Db, ref: string) {
  const { rows } = await db.query('SELECT * FROM configuration_items WHERE ref = $1 FOR UPDATE', [ref.toUpperCase()]);
  if (!rows[0]) throw notFound(`${ref} not found`);
  return rows[0];
}

async function newRef(db: Db, cls: 'ci' | 'service') {
  const { rows } = await db.query(cls === 'service' ? "SELECT 'SVC' || lpad(nextval('service_ref_seq')::text, 6, '0') AS ref" : "SELECT 'CI' || lpad(nextval('ci_ref_seq')::text, 6, '0') AS ref");
  return rows[0].ref as string;
}

async function validateOwner(db: Db, ownerId: number | null | undefined) {
  if (ownerId == null) return;
  const { rows } = await db.query('SELECT 1 FROM users WHERE id = $1 AND active', [ownerId]);
  if (!rows[0]) throw badRequest('Owner must be an active user');
}

export async function createCi(user: User, input: z.infer<typeof createCiSchema>) {
  authorize(user, 'ci.manage');
  const ref = await tx(async (db) => {
    const t = await typeInfo(db, input.ci_type);
    await validateOwner(db, input.owner_id);
    const ref = await newRef(db, t.class);
    const { rows } = await db.query(
      `INSERT INTO configuration_items (ref, class, name, ci_type, status, environment, criticality, owner_id, team, description, tags, attributes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [ref, t.class, input.name, t.name, input.status ?? 'active', input.environment ?? 'prod', input.criticality ?? 3, input.owner_id ?? null,
        input.team ?? '', input.description ?? '', input.tags ?? [], JSON.stringify(cleanAttributes(t.attributes, input.attributes)), user.id],
    );
    if (input.source) {
      await db.query('INSERT INTO ci_sources (ci_id, source_system, source_id, source_url, created_by) VALUES ($1, $2, $3, $4, $5)', [
        rows[0].id, input.source.system, input.source.id, input.source.url, user.id,
      ]);
    }
    await logCi(db, rows[0].id, user.id, 'created', `${ref} ${input.name} created`, { name: input.name, ci_type: t.name });
    return ref;
  });
  return getCi(user, ref);
}

export async function updateCi(user: User, ref: string, { base, ...input }: z.infer<typeof updateCiSchema>) {
  authorize(user, 'ci.manage');
  await tx(async (db) => {
    const current = await loadCi(db, ref);
    if (base) {
      const stale = Object.keys(base).filter((k) => k in input && JSON.stringify(current[k] ?? null) !== JSON.stringify((base as any)[k] ?? null));
      if (stale.length) throw conflict(`${stale.join(', ')} changed while you were editing`, { conflicts: stale.map((f) => ({ field: f, current: current[f] })) });
    }
    const t = await typeInfo(db, input.ci_type ?? current.ci_type);
    if (input.ci_type && t.class !== current.class) throw badRequest('A CI cannot become a service or the other way round');
    await validateOwner(db, input.owner_id);
    const next: Record<string, unknown> = { ...input };
    if (input.attributes || input.ci_type) next.attributes = cleanAttributes(t.attributes, input.attributes ?? current.attributes);
    const changed = Object.entries(next).filter(([k, v]) => v !== undefined && JSON.stringify(current[k] ?? null) !== JSON.stringify(v));
    if (!changed.length) return;
    await db.query(
      `UPDATE configuration_items SET ${changed.map(([k], i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [current.id, ...changed.map(([k, v]) => (k === 'attributes' ? JSON.stringify(v) : v))],
    );
    await logCi(db, current.id, user.id, 'update', `Updated ${changed.map(([k]) => k).join(', ')}`, Object.fromEntries(changed.map(([k, v]) => [k, { from: current[k] ?? null, to: v }])));
  });
  return getCi(user, ref);
}

export async function transitionCi(user: User, ref: string, input: z.infer<typeof transitionCiSchema>) {
  authorize(user, 'ci.manage');
  await tx(async (db) => {
    const current = await loadCi(db, ref);
    if (current.status === input.to) return;
    await db.query('UPDATE configuration_items SET status = $2 WHERE id = $1', [current.id, input.to]);
    await logCi(db, current.id, user.id, 'status', input.comment ?? '', { from: current.status, to: input.to });
  });
  return getCi(user, ref);
}

export async function addCiComment(user: User, ref: string, body: string) {
  authorize(user, 'ci.annotate');
  if (!body.trim()) throw badRequest('Comment cannot be empty');
  await tx(async (db) => {
    const ci = await loadCi(db, ref);
    await logCi(db, ci.id, user.id, 'comment', body.trim());
  });
  return getCi(user, ref);
}

export async function addCiLink(user: User, ref: string, input: z.infer<typeof ciLinkSchema>) {
  authorize(user, 'ci.annotate');
  await tx(async (db) => {
    const ci = await loadCi(db, ref);
    const { rowCount } = await db.query(
      'INSERT INTO ci_links (ci_id, kind, reference, system, url, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING',
      [ci.id, input.kind, input.reference, input.system, input.url, input.note, user.id],
    );
    if (!rowCount) throw conflict(`${input.kind} ${input.reference} is already linked`);
    await logCi(db, ci.id, user.id, 'link', `Linked ${input.kind} ${input.reference}`, { ...input, action: 'add' });
  });
  return getCi(user, ref);
}

export async function removeCiLink(user: User, ref: string, linkId: number) {
  authorize(user, 'ci.annotate');
  await tx(async (db) => {
    const ci = await loadCi(db, ref);
    const { rows } = await db.query('DELETE FROM ci_links WHERE id = $1 AND ci_id = $2 RETURNING kind, reference', [linkId, ci.id]);
    if (!rows[0]) throw notFound('Link not found');
    await logCi(db, ci.id, user.id, 'link', `Unlinked ${rows[0].kind} ${rows[0].reference}`, { ...rows[0], action: 'remove' });
  });
  return getCi(user, ref);
}

/**
 * Upserts CIs from a source. A source record (system + id) is matched to its CI; new ones create a CI. An
 * integration account may only update source records it created itself, so one source cannot rewrite another.
 */
export async function upsertCis(user: User, input: z.infer<typeof upsertSchema>) {
  authorize(user, 'ci.ingest');
  // Integrations are bound to the source systems an administrator allowed, so one cannot squat another's name.
  const { rows: me } = await query('SELECT ci_source_systems FROM users WHERE id = $1', [user.id]);
  const allowed = new Set<string>(me[0]?.ci_source_systems ?? []);
  let created = 0, updated = 0, unchanged = 0;
  const errors: { source_id: string; error: string }[] = [];
  await tx(async (db) => {
    for (const item of input.items) {
      await db.query('SAVEPOINT item');
      try {
        if (user.role === 'integration' && !allowed.has(item.source_system)) {
          throw forbidden(`This account may not report CIs for source system "${item.source_system}". An administrator can allow it under Users.`);
        }
        const t = await typeInfo(db, item.ci_type);
        const attrs = cleanAttributes(t.attributes, item.attributes);
        const { rows: existing } = await db.query(
          'SELECT s.id AS source_row, s.created_by, c.* FROM ci_sources s JOIN configuration_items c ON c.id = s.ci_id WHERE s.source_system = $1 AND s.source_id = $2 FOR UPDATE OF c',
          [item.source_system, item.source_id],
        );
        if (existing[0]) {
          const c = existing[0];
          const override = c.created_by !== user.id;
          if (override && user.role === 'integration') throw forbidden('This source record belongs to another integration');
          if (override && !input.override_reason) throw forbidden('This source record was reported by another account; give override_reason to update it');
          const next: Record<string, unknown> = { name: item.name, environment: item.environment ?? c.environment, attributes: { ...c.attributes, ...attrs } };
          if (item.status) next.status = item.status;
          if (item.team !== undefined) next.team = item.team;
          if (item.tags) next.tags = item.tags;
          const changed = Object.entries(next).filter(([k, v]) => JSON.stringify(c[k] ?? null) !== JSON.stringify(v));
          await db.query('UPDATE ci_sources SET last_seen_at = now(), source_url = coalesce(nullif($2, \'\'), source_url) WHERE id = $1', [c.source_row, item.source_url]);
          if (changed.length) {
            await db.query(
              `UPDATE configuration_items SET ${changed.map(([k], i) => `${k} = $${i + 2}`).join(', ')}${c.status === 'missing' && !item.status ? ", status = 'active'" : ''} WHERE id = $1`,
              [c.id, ...changed.map(([k, v]) => (k === 'attributes' ? JSON.stringify(v) : v))],
            );
            await logCi(db, c.id, user.id, 'source', override ? `Overrode ${item.source_system} data: ${input.override_reason}` : `Updated from ${item.source_system}`, {
              ...Object.fromEntries(changed.map(([k, v]) => [k, { from: c[k] ?? null, to: v }])),
              ...(override ? { override: true, reason: input.override_reason } : {}),
            });
            updated++;
          } else unchanged++;
        } else {
          const ref = await newRef(db, t.class);
          const { rows } = await db.query(
            `INSERT INTO configuration_items (ref, class, name, ci_type, status, environment, team, tags, attributes, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
            [ref, t.class, item.name, t.name, item.status ?? 'active', item.environment ?? 'prod', item.team ?? '', item.tags ?? [], JSON.stringify(attrs), user.id],
          );
          await db.query('INSERT INTO ci_sources (ci_id, source_system, source_id, source_url, created_by) VALUES ($1, $2, $3, $4, $5)', [
            rows[0].id, item.source_system, item.source_id, item.source_url, user.id,
          ]);
          await logCi(db, rows[0].id, user.id, 'created', `Discovered by ${item.source_system}`, { source_system: item.source_system, source_id: item.source_id });
          created++;
        }
        await db.query('RELEASE SAVEPOINT item');
      } catch (err) {
        await db.query('ROLLBACK TO SAVEPOINT item');
        errors.push({ source_id: item.source_id, error: (err as Error).message });
      }
    }
  });
  return { created, updated, unchanged, errors };
}

// ---- Registry ----------------------------------------------------------------------------------

const routes = {
  list: '/api/cis',
  create: '/api/cis',
  get: '/api/cis/:ref',
  update: '/api/cis/:ref',
  transition: '/api/cis/:ref/transition',
  links: '/api/cis/:ref/links',
  comments: '/api/cis/:ref/comments',
};
const mcp = { list: 'search_cis', get: 'get_ci', create: 'create_ci', update: 'update_ci', transition: 'transition_ci' };

const search = (cls: 'ci' | 'service') => async (user: User, q: string, limit: number) =>
  (await listCis(user, listCisSchema.parse({ q, class: cls, status: 'all', limit }))).map((c) => ({
    type: cls,
    ref: c.ref,
    title: c.name,
    status: c.status,
    url: c.url,
    summary: [c.type_label, c.environment, c.team].filter(Boolean).join(' · '),
  }));

const CI_TYPE: RecordType = { type: 'ci', prefix: 'CI', readAction: 'ci.read', uiPath: (ref) => `/cis/${ref}`, get: getCi, search: search('ci'), rest: routes, mcp };
const SERVICE_TYPE: RecordType = { type: 'service', prefix: 'SVC', readAction: 'ci.read', uiPath: (ref) => `/cis/${ref}`, get: getCi, search: search('service'), rest: routes, mcp };
registerRecordType(CI_TYPE);
registerRecordType(SERVICE_TYPE);

function urlFor(cls: string, ref: string) {
  return recordUrl(cls === 'service' ? SERVICE_TYPE : CI_TYPE, ref);
}
