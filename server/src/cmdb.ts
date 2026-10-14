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

export type Db = Pick<pg.PoolClient, 'query'>;

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
  // Service catalogue (#43), for services.
  sla_id: z.number().int().nullable(),
  user_description: z.string().max(5000),
  how_to_get_help: z.string().max(5000),
  in_catalogue: z.boolean(),
  // People (#39): who owns the service, and whether it has end users who can be affected.
  has_end_users: z.boolean(),
  business_owner_id: z.number().int().nullable(),
  technical_contact_id: z.number().int().nullable(),
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
        /** Explicit mapping to an existing CI (e.g. from a mapping table), used before automatic matching. */
        ci: z.string().trim().max(30).optional(),
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

export const SELECT_CI = `
  SELECT c.id, c.ref, c.class, c.name, c.ci_type, t.label AS type_label, c.status, c.environment, c.criticality,
         c.owner_id, o.display_name AS owner, c.team, c.description, c.tags, c.attributes, c.created_at, c.updated_at,
         c.sla_id, c.user_description, c.how_to_get_help, c.in_catalogue, c.has_end_users,
         c.business_owner_id, (SELECT name FROM people WHERE id = c.business_owner_id) AS business_owner,
         c.technical_contact_id, (SELECT name FROM people WHERE id = c.technical_contact_id) AS technical_contact,
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
  // Cross-source identity (cloud resource id, BIOS UUID) is kept for every type: reconciliation matches on it.
  for (const key of ['resource_id', 'bios_uuid']) {
    const v = attrs?.[key];
    if (v !== undefined && v !== null && v !== '') out[key] = String(v).slice(0, 500);
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

export async function logCi(db: Db, ciId: number, userId: number | null, kind: string, body: string, data: object = {}) {
  await db.query('INSERT INTO ci_activity (ci_id, user_id, kind, body, data, channel) VALUES ($1, $2, $3, $4, $5, $6)', [
    ciId, userId, kind, body, JSON.stringify(data), currentContext().channel,
  ]);
  const { rows } = await db.query('SELECT ref, class FROM configuration_items WHERE id = $1', [ciId]);
  await audit(db, { entity_type: rows[0].class === 'service' ? 'service' : 'ci', entity_ref: rows[0].ref, action: kind, changes: kind === 'comment' ? { body } : (data as Record<string, unknown>) });
  await db.query('UPDATE configuration_items SET updated_at = now() WHERE id = $1', [ciId]);
}

export async function loadCi(db: Db, ref: string) {
  const { rows } = await db.query('SELECT * FROM configuration_items WHERE ref = $1 FOR UPDATE', [ref.toUpperCase()]);
  if (!rows[0]) throw notFound(`${ref} not found`);
  return rows[0];
}

async function newRef(db: Db, cls: 'ci' | 'service') {
  const { rows } = await db.query(cls === 'service' ? "SELECT 'SVC' || lpad(nextval('service_ref_seq')::text, 6, '0') AS ref" : "SELECT 'CI' || lpad(nextval('ci_ref_seq')::text, 6, '0') AS ref");
  return rows[0].ref as string;
}

async function validateSla(db: Db, slaId: number | null | undefined) {
  if (slaId == null) return;
  const { rows } = await db.query('SELECT 1 FROM slas WHERE id = $1', [slaId]);
  if (!rows[0]) throw badRequest('Unknown SLA');
}

async function validatePeople(db: Db, input: { business_owner_id?: number | null; technical_contact_id?: number | null }) {
  const ids = [input.business_owner_id, input.technical_contact_id].filter((v): v is number => v != null);
  if (!ids.length) return;
  const { rows } = await db.query('SELECT count(DISTINCT id)::int AS n FROM people WHERE id = ANY($1) AND erased_at IS NULL', [ids]);
  if (rows[0].n !== new Set(ids).size) throw badRequest('Business owner and technical contact must be existing contacts');
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
    await validateSla(db, input.sla_id);
    await validatePeople(db, input);
    const ref = await newRef(db, t.class);
    const { rows } = await db.query(
      `INSERT INTO configuration_items (ref, class, name, ci_type, status, environment, criticality, owner_id, team, description, tags, attributes, created_by,
                                        sla_id, user_description, how_to_get_help, in_catalogue, has_end_users, business_owner_id, technical_contact_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING id`,
      [ref, t.class, input.name, t.name, input.status ?? 'active', input.environment ?? 'prod', input.criticality ?? 3, input.owner_id ?? null,
        input.team ?? '', input.description ?? '', input.tags ?? [], JSON.stringify(cleanAttributes(t.attributes, input.attributes)), user.id,
        input.sla_id ?? null, input.user_description ?? '', input.how_to_get_help ?? '', input.in_catalogue ?? false,
        input.has_end_users ?? false, input.business_owner_id ?? null, input.technical_contact_id ?? null],
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
    await validateSla(db, input.sla_id);
    await validatePeople(db, input);
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
  if (input.kind === 'problem') throw badRequest('Problems are linked as affected CIs: POST /api/problems/:ref/cis (or link_ci_to_problem)');
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
  // Source systems owned by a pull connector are written by that connector only.
  const { rows: owned } = await query('SELECT source_system FROM connectors');
  const connectorOwned = new Set<string>(owned.map((r) => r.source_system));
  const errors: { source_id: string; error: string }[] = [];
  const { rows: typeRows } = await query('SELECT name, class, attributes FROM ci_types');
  const types = new Map(typeRows.map((t) => [t.name as string, t as { name: string; class: 'ci' | 'service'; attributes: { key: string; type: string }[] }]));

  // Validate everything up front, then write in a few set-based statements: connectors report thousands of CIs.
  type Item = z.infer<typeof upsertSchema>['items'][number] & { cls: 'ci' | 'service'; attrs: Record<string, unknown> };
  const items = new Map<string, Item>();
  for (const item of input.items) {
    try {
      if (user.role === 'integration' && connectorOwned.has(item.source_system)) {
        throw forbidden(`"${item.source_system}" is synced by a Kernel connector; push to another source system name`);
      }
      if (user.role === 'integration' && !allowed.has(item.source_system)) {
        throw forbidden(`This account may not report CIs for source system "${item.source_system}". An administrator can allow it under Users.`);
      }
      const t = types.get(item.ci_type);
      if (!t) throw badRequest(`Unknown CI type "${item.ci_type}". See /api/ci-types.`);
      items.set(`${item.source_system}\u0000${item.source_id}`, { ...item, cls: t.class, attrs: cleanAttributes(t.attributes, item.attributes) });
    } catch (err) {
      errors.push({ source_id: item.source_id, error: (err as Error).message });
    }
  }
  const list = [...items.values()];
  let created = 0, updated = 0, unchanged = 0, matched = 0;
  const { rows: rec } = await query("SELECT value FROM settings WHERE key = 'cmdb_reconciliation'");
  const precedence: Record<string, string[]> = rec[0]?.value?.attribute_precedence ?? {};
  /** Per-attribute source precedence: a source may not overwrite a value owned by a source listed before it. */
  const mayWrite = (attr: string, owner: string | undefined, source: string) => {
    const order = precedence[attr];
    if (!owner || owner === source || !order) return true;
    const o = order.indexOf(owner), s = order.indexOf(source);
    return o === -1 || (s !== -1 && s < o);
  };
  const writable = (attrs: Record<string, unknown>, owners: Record<string, string>, source: string) =>
    Object.fromEntries(Object.entries(attrs).filter(([a]) => mayWrite(a, owners[a], source)));
  const own = (attrs: Record<string, unknown>, source: string) => Object.fromEntries(Object.keys(attrs).map((a) => [a, source]));
  try {
    await tx(async (db) => {
      const { rows: existing } = await db.query(
        `SELECT s.source_system, s.source_id, s.id AS source_row, s.created_by AS source_owner, c.*
         FROM unnest($1::text[], $2::text[]) AS x(sys, sid)
         JOIN ci_sources s ON s.source_system = x.sys AND s.source_id = x.sid
         JOIN configuration_items c ON c.id = s.ci_id
         FOR UPDATE OF c`,
        [list.map((i) => i.source_system), list.map((i) => i.source_id)],
      );
      const found = new Map(existing.map((c) => [`${c.source_system}\u0000${c.source_id}`, c]));
      const seenRows: { id: number; url: string }[] = [];
      const updates: { id: number; name: string; environment: string; status: string; team: string; tags: string[]; attributes: string; attribute_sources: string }[] = [];
      const activity: { ci: number; body: string; data: string }[] = [];
      const fresh: Item[] = [];
      for (const item of list) {
        const c = found.get(`${item.source_system}\u0000${item.source_id}`);
        if (!c) { fresh.push(item); continue; }
        const override = c.source_owner !== user.id;
        if (override && user.role === 'integration') { errors.push({ source_id: item.source_id, error: 'This source record belongs to another integration' }); continue; }
        if (override && !input.override_reason) { errors.push({ source_id: item.source_id, error: 'This source record was reported by another account; give override_reason to update it' }); continue; }
        seenRows.push({ id: c.source_row, url: item.source_url });
        const next: Record<string, unknown> = {
          name: item.name,
          environment: item.environment ?? c.environment,
          status: item.status ?? (c.status === 'missing' ? 'active' : c.status),
          team: item.team ?? c.team,
          tags: item.tags ?? c.tags,
          attributes: { ...c.attributes, ...writable(item.attrs, c.attribute_sources ?? {}, item.source_system) },
        };
        const changed = Object.entries(next).filter(([k, v]) => JSON.stringify(c[k] ?? null) !== JSON.stringify(v));
        if (!changed.length) { unchanged++; continue; }
        updated++;
        updates.push({ id: c.id, ...(next as any), attributes: JSON.stringify(next.attributes), attribute_sources: JSON.stringify({ ...(c.attribute_sources ?? {}), ...own(writable(item.attrs, c.attribute_sources ?? {}, item.source_system), item.source_system) }) });
        const data = {
          ...Object.fromEntries(changed.map(([k, v]) => [k, { from: c[k] ?? null, to: v }])),
          ...(override ? { override: true, reason: input.override_reason } : {}),
        };
        activity.push({ ci: c.id, body: override ? `Overrode ${item.source_system} data: ${input.override_reason}` : `Updated from ${item.source_system}`, data: JSON.stringify(data) });
        // Overrides are rare and deliberate: each gets its own audit entry on the CI.
        if (override) await audit(db, { entity_type: c.class === 'service' ? 'service' : 'ci', entity_ref: c.ref, action: 'source_override', changes: data, reason: input.override_reason });
      }
      if (seenRows.length) {
        await db.query(
          `UPDATE ci_sources s SET last_seen_at = now(), missed_syncs = 0, source_url = coalesce(nullif(x.url, ''), s.source_url)
           FROM unnest($1::int[], $2::text[]) AS x(id, url) WHERE s.id = x.id`,
          [seenRows.map((r) => r.id), seenRows.map((r) => r.url)],
        );
      }
      if (updates.length) {
        await db.query(
          `UPDATE configuration_items c SET name = x.name, environment = x.environment, status = x.status, team = x.team,
                  tags = ARRAY(SELECT jsonb_array_elements_text(x.tags)), attributes = x.attributes, attribute_sources = x.owners, updated_at = now()
           FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::jsonb[], $7::jsonb[], $8::jsonb[]) AS x(id, name, environment, status, team, tags, attributes, owners)
           WHERE c.id = x.id`,
          [updates.map((u) => u.id), updates.map((u) => u.name), updates.map((u) => u.environment), updates.map((u) => u.status),
            updates.map((u) => u.team), updates.map((u) => JSON.stringify(u.tags)), updates.map((u) => u.attributes), updates.map((u) => u.attribute_sources)],
        );
      }
      // Reconciliation: a new source id that clearly identifies an existing CI joins it instead of duplicating it.
      const remaining: Item[] = [];
      for (const item of fresh) {
        const match = await findMatch(db, item);
        if (!match) { remaining.push(item); continue; }
        const attrs = writable(item.attrs, match.attribute_sources ?? {}, item.source_system);
        await db.query('INSERT INTO ci_sources (ci_id, source_system, source_id, source_url, created_by) VALUES ($1, $2, $3, $4, $5)', [match.id, item.source_system, item.source_id, item.source_url, user.id]);
        await db.query('UPDATE configuration_items SET attributes = attributes || $2, attribute_sources = attribute_sources || $3, updated_at = now() WHERE id = $1', [match.id, JSON.stringify(attrs), JSON.stringify(own(attrs, item.source_system))]);
        activity.push({ ci: match.id, body: `Matched ${item.source_system} ${item.source_id} by ${match.rule}`, data: JSON.stringify({ source_system: item.source_system, source_id: item.source_id, rule: match.rule }) });
        matched++;
      }
      const added: { ref: string; name: string }[] = [];
      for (const cls of ['ci', 'service'] as const) {
        const batch = remaining.filter((i) => i.cls === cls);
        if (!batch.length) continue;
        // Allocate refs first so every new row is matched to its source by ref, not by row order.
        const { rows: refRows } = await db.query(
          `SELECT $1 || lpad(nextval($2::regclass)::text, 6, '0') AS ref FROM generate_series(1, $3)`,
          [cls === 'service' ? 'SVC' : 'CI', cls === 'service' ? 'service_ref_seq' : 'ci_ref_seq', batch.length],
        );
        const refs = refRows.map((r) => r.ref as string);
        const { rows: made } = await db.query(
          `INSERT INTO configuration_items (ref, class, name, ci_type, status, environment, team, tags, attributes, attribute_sources, created_by)
           SELECT x.ref, $1, x.name, x.ci_type, x.status, x.environment, x.team, ARRAY(SELECT jsonb_array_elements_text(x.tags)), x.attributes, x.owners, $2
           FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::jsonb[], $10::jsonb[], $11::jsonb[])
                AS x(ref, name, ci_type, status, environment, team, tags, attributes, owners)
           RETURNING id, ref, name`,
          [cls, user.id, refs, batch.map((i) => i.name), batch.map((i) => i.ci_type), batch.map((i) => i.status ?? 'active'), batch.map((i) => i.environment ?? 'prod'),
            batch.map((i) => i.team ?? ''), batch.map((i) => JSON.stringify(i.tags ?? [])), batch.map((i) => JSON.stringify(i.attrs)), batch.map((i) => JSON.stringify(own(i.attrs, i.source_system)))],
        );
        const idByRef = new Map(made.map((m) => [m.ref as string, m.id as number]));
        const ids = refs.map((r) => idByRef.get(r)!);
        await db.query(
          `INSERT INTO ci_sources (ci_id, source_system, source_id, source_url, created_by)
           SELECT *, $5 FROM unnest($1::int[], $2::text[], $3::text[], $4::text[])`,
          [ids, batch.map((i) => i.source_system), batch.map((i) => i.source_id), batch.map((i) => i.source_url), user.id],
        );
        batch.forEach((item, n) => activity.push({ ci: ids[n], body: `Discovered by ${item.source_system}`, data: JSON.stringify({ source_system: item.source_system, source_id: item.source_id }) }));
        added.push(...made.map((m) => ({ ref: m.ref, name: m.name })));
        created += made.length;
      }
      if (activity.length) {
        await db.query(
          `INSERT INTO ci_activity (ci_id, user_id, kind, body, data, channel)
           SELECT x.ci, $4, CASE WHEN x.body LIKE 'Discovered by %' THEN 'created' ELSE 'source' END, x.body, x.data, $5
           FROM unnest($1::int[], $2::text[], $3::jsonb[]) AS x(ci, body, data)`,
          [activity.map((a) => a.ci), activity.map((a) => a.body), activity.map((a) => a.data), user.id, currentContext().channel],
        );
      }
      // One audit entry per upsert, naming what was created and changed.
      await audit(db, {
        entity_type: 'ci_upsert',
        entity_ref: [...new Set(list.map((i) => i.source_system))].join(', ').slice(0, 200),
        action: 'upsert',
        changes: { created, updated, unchanged, matched, errors: errors.length, created_refs: added.slice(0, 1000), updated_refs: updates.slice(0, 1000).map((u) => u.id) },
        reason: input.override_reason,
      });
    });
  } catch (err: any) {
    if (err.code === '23505') throw conflict('Another sync reported the same records at the same time; retry');
    throw err;
  }
  return { created, updated, unchanged, matched, errors };
}

/**
 * Finds the one existing CI a new source record describes, in order: explicit mapping, cloud resource id or BIOS
 * UUID, FQDN, then name plus IP. Only CIs without a record from the same source system, and only unique matches.
 */
async function findMatch(db: Db, item: { ci?: string; source_system: string; name: string; attributes?: Record<string, unknown> }) {
  const a = item.attributes ?? {};
  const free = 'NOT EXISTS (SELECT 1 FROM ci_sources s WHERE s.ci_id = c.id AND s.source_system = $1)';
  const rules: [string, string, unknown[]][] = [];
  if (item.ci) rules.push(['explicit mapping', 'c.ref = $2', [item.ci.toUpperCase()]]);
  for (const key of ['resource_id', 'bios_uuid']) if (a[key]) rules.push([key, `lower(c.attributes->>'${key}') = lower($2)`, [String(a[key])]]);
  if (a.fqdn) rules.push(['FQDN', "lower(c.attributes->>'fqdn') = lower($2)", [String(a.fqdn)]]);
  if (a.ip) rules.push(['name and IP', "lower(c.name) = lower($2) AND c.attributes->>'ip' = $3", [item.name, String(a.ip)]]);
  for (const [rule, where, params] of rules) {
    const { rows } = await db.query(`SELECT c.id, c.attribute_sources FROM configuration_items c WHERE c.status <> 'retired' AND ${free} AND ${where} LIMIT 2`, [item.source_system, ...params]);
    if (rows.length === 1) return { ...rows[0], rule };
    if (rows.length > 1) return null; // ambiguous: create a new CI rather than guess
  }
  return null;
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
