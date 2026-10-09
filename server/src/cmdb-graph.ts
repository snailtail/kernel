// CMDB relationships, groups and impact analysis (#17). Relationships are stored once in their defined direction;
// the type says which way an outage propagates. Connectors own the relationships they discover (source_system) and
// only they replace them; manual relationships survive every sync.
import { z } from 'zod';
import type { User } from './auth.js';
import { audit } from './audit.js';
import { getCi, loadCi, logCi, registerCiExtra, type Db } from './cmdb.js';
import { currentContext } from './context.js';
import { query, tx } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { authorize } from './policy.js';

export const MAX_DEPTH = 10;
export const MAX_NODES = 500;

interface RelType { name: string; label: string; inverse_label: string; propagation: 'forward' | 'reverse' }

export async function relationshipTypes(): Promise<RelType[]> {
  return (await query('SELECT name, label, inverse_label, propagation FROM ci_relationship_types ORDER BY name')).rows;
}

// ---- Relationships -----------------------------------------------------------------------------

export const relationshipSchema = z.object({
  type: z.string().min(1).max(50),
  /** The other CI or service. */
  target: z.string().trim().min(1).max(30),
  /** 'outgoing': this CI <type> target (e.g. this VM runs_on target). 'incoming': target <type> this CI. */
  direction: z.enum(['outgoing', 'incoming']).default('outgoing'),
});

async function relType(db: Db, name: string) {
  const { rows } = await db.query('SELECT * FROM ci_relationship_types WHERE name = $1', [name]);
  if (!rows[0]) throw badRequest(`Unknown relationship type "${name}". See /api/ci-relationship-types.`);
  return rows[0] as RelType;
}

async function checkPair(db: Db, type: string, fromId: number, toId: number) {
  if (fromId === toId) throw badRequest('A CI cannot have a relationship with itself');
  if (type === 'member_of') {
    const { rows } = await db.query('SELECT class FROM configuration_items WHERE id = $1', [toId]);
    if (rows[0]?.class !== 'service') throw badRequest('member_of must point to a service');
  }
}

export async function addRelationship(user: User, ref: string, input: z.infer<typeof relationshipSchema>) {
  authorize(user, 'ci.manage');
  await tx(async (db) => {
    const self = await loadCi(db, ref);
    const other = await loadCi(db, input.target);
    const t = await relType(db, input.type);
    const [from, to] = input.direction === 'outgoing' ? [self, other] : [other, self];
    await checkPair(db, t.name, from.id, to.id);
    const { rowCount } = await db.query(
      'INSERT INTO ci_relationships (from_ci, to_ci, type, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [from.id, to.id, t.name, user.id],
    );
    if (!rowCount) throw conflict(`${from.ref} ${t.label} ${to.ref} already exists`);
    const data = { action: 'add', from: from.ref, type: t.name, to: to.ref };
    await logCi(db, from.id, user.id, 'relationship', `${from.ref} ${t.label} ${to.ref}`, data);
    await logCi(db, to.id, user.id, 'relationship', `${to.ref} ${t.inverse_label} ${from.ref}`, data);
  });
  return getCi(user, ref);
}

export async function removeRelationship(user: User, ref: string, id: number) {
  authorize(user, 'ci.manage');
  await tx(async (db) => {
    const self = await loadCi(db, ref);
    const { rows } = await db.query(
      `SELECT r.*, f.ref AS from_ref, t.ref AS to_ref, ty.label FROM ci_relationships r
       JOIN configuration_items f ON f.id = r.from_ci JOIN configuration_items t ON t.id = r.to_ci JOIN ci_relationship_types ty ON ty.name = r.type
       WHERE r.id = $1 AND $2 IN (r.from_ci, r.to_ci)`,
      [id, self.id],
    );
    const r = rows[0];
    if (!r) throw notFound('Relationship not found');
    if (r.source_system) throw forbidden(`Discovered by ${r.source_system}: it is removed when ${r.source_system} stops reporting it`);
    await db.query('DELETE FROM ci_relationships WHERE id = $1', [id]);
    const data = { action: 'remove', from: r.from_ref, type: r.type, to: r.to_ref };
    await logCi(db, r.from_ci, user.id, 'relationship', `Removed: ${r.from_ref} ${r.label} ${r.to_ref}`, data);
    await logCi(db, r.to_ci, user.id, 'relationship', `Removed: ${r.from_ref} ${r.label} ${r.to_ref}`, data);
  });
  return getCi(user, ref);
}

/** Relationships reported by a source system, identified by that system's ids. */
export const syncSchema = z.object({
  source_system: z.string().trim().min(1).max(100),
  relationships: z.array(z.object({ from_id: z.string().min(1).max(300), type: z.string().min(1).max(50), to_id: z.string().min(1).max(300) })).max(5000),
  /** Full sync: relationships this source reported before but not now are removed. Manual ones are never touched. */
  full: z.boolean().default(false),
});

export async function syncRelationships(user: User, input: z.infer<typeof syncSchema>) {
  authorize(user, 'ci.ingest');
  if (user.role === 'integration') {
    const { rows } = await query('SELECT ci_source_systems FROM users WHERE id = $1', [user.id]);
    if (!(rows[0]?.ci_source_systems ?? []).includes(input.source_system)) {
      throw forbidden(`This account may not report for source system "${input.source_system}"`);
    }
  }
  let created = 0, seen = 0, removed = 0;
  const errors: { from_id: string; to_id: string; error: string }[] = [];
  await tx(async (db) => {
    const types = new Map((await relationshipTypes()).map((t) => [t.name, t]));
    const ids = [...new Set(input.relationships.flatMap((r) => [r.from_id, r.to_id]))];
    const { rows: map } = await db.query(
      'SELECT s.source_id, c.id, c.ref FROM ci_sources s JOIN configuration_items c ON c.id = s.ci_id WHERE s.source_system = $1 AND s.source_id = ANY($2)',
      [input.source_system, ids],
    );
    const bySource = new Map(map.map((m) => [m.source_id as string, m as { id: number; ref: string }]));
    // Resolve and validate first, then write in batches: a connector may report thousands of relationships.
    const wanted = new Map<string, { from: { id: number; ref: string }; to: { id: number; ref: string }; type: string }>();
    for (const r of input.relationships) {
      const from = bySource.get(r.from_id), to = bySource.get(r.to_id), t = types.get(r.type);
      const fail = (error: string) => errors.push({ from_id: r.from_id, to_id: r.to_id, error });
      if (!t) { fail(`Unknown relationship type ${r.type}`); continue; }
      if (!from || !to) { fail(`Unknown ${input.source_system} id ${!from ? r.from_id : r.to_id}; report the CI first`); continue; }
      if (from.id === to.id) { fail('A CI cannot have a relationship with itself'); continue; }
      wanted.set(`${from.id}:${to.id}:${t.name}`, { from, to, type: t.name });
    }
    const list = [...wanted.values()];
    // Never take over a manual relationship or another source's: only refresh our own.
    const { rows: written } = await db.query(
      `INSERT INTO ci_relationships (from_ci, to_ci, type, source_system, created_by)
       SELECT f, t, ty, $4, $5 FROM unnest($1::int[], $2::int[], $3::text[]) AS x(f, t, ty)
       ON CONFLICT (from_ci, to_ci, type) DO UPDATE SET last_seen_at = now() WHERE ci_relationships.source_system = excluded.source_system
       RETURNING id, from_ci, to_ci, type, (xmax = 0) AS inserted`,
      [list.map((r) => r.from.id), list.map((r) => r.to.id), list.map((r) => r.type), input.source_system, user.id],
    );
    const refOf = new Map(list.flatMap((r) => [[r.from.id, r.from.ref], [r.to.id, r.to.ref]] as [number, string][]));
    const added = written.filter((w) => w.inserted).map((w) => ({ ci: w.from_ci as number, from: refOf.get(w.from_ci)!, type: w.type as string, to: refOf.get(w.to_ci)! }));
    created = added.length;
    seen = list.length - created;
    let gone: { ci: number; from: string; type: string; to: string }[] = [];
    if (input.full) {
      const { rows } = await db.query(
        `DELETE FROM ci_relationships r USING configuration_items f, configuration_items t
         WHERE r.source_system = $1 AND NOT (r.id = ANY($2)) AND f.id = r.from_ci AND t.id = r.to_ci
         RETURNING r.from_ci AS ci, f.ref AS from, r.type, t.ref AS to`,
        [input.source_system, written.map((w) => w.id)],
      );
      gone = rows;
      removed = gone.length;
    }
    // History on each CI, and one audit entry for the sync that lists what changed.
    const changes = [
      ...added.map((a) => ({ ...a, action: 'add', body: `${a.from} ${a.type} ${a.to} (discovered by ${input.source_system})` })),
      ...gone.map((g) => ({ ...g, action: 'remove', body: `Removed: ${g.from} ${g.type} ${g.to} (no longer reported by ${input.source_system})` })),
    ];
    if (changes.length) {
      await db.query(
        `INSERT INTO ci_activity (ci_id, user_id, kind, body, data, channel)
         SELECT ci, $3, 'relationship', body, data, $4 FROM unnest($1::int[], $2::text[], $5::jsonb[]) AS x(ci, body, data)`,
        [changes.map((c) => c.ci), changes.map((c) => c.body), user.id, currentContext().channel,
          changes.map((c) => JSON.stringify({ action: c.action, from: c.from, type: c.type, to: c.to, source_system: input.source_system }))],
      );
      await db.query('UPDATE configuration_items SET updated_at = now() WHERE id = ANY($1)', [[...new Set(changes.map((c) => c.ci))]]);
    }
    await audit(db, { entity_type: 'ci_relationships', entity_ref: input.source_system, action: 'sync', changes: { created, seen, removed, errors: errors.length, full: input.full, added: added.slice(0, 1000).map(({ ci: _, ...e }) => e), removed_relationships: gone.slice(0, 1000).map(({ ci: _, ...e }) => e) } });
  });
  return { created, seen, removed, errors };
}

// ---- Impact analysis ---------------------------------------------------------------------------

export const impactSchema = z.object({
  direction: z.enum(['up', 'down']).default('up'),
  max_depth: z.coerce.number().int().min(1).max(MAX_DEPTH).default(MAX_DEPTH),
});

/**
 * Which CIs may this user see? Everyone with ci.read sees all today; scoping (#53) plugs in here so impact
 * results never reveal CIs the caller cannot read.
 */
async function visible(_user: User | null, ids: number[]) {
  return new Set(ids);
}

/**
 * Walks the dependency graph breadth first: 'up' finds what is affected if the CI is down (dependents, up to
 * services), 'down' finds what it depends on. A visited set makes cycles and diamonds safe; the walk stops at
 * max_depth levels and MAX_NODES nodes and says so instead of returning an unbounded result.
 */
export async function impact(user: User, ref: string, opts: z.infer<typeof impactSchema>) {
  authorize(user, 'ci.read');
  return computeImpact(user, ref, opts);
}

/** The walk itself, also used for a problem's affected services (user null: the problem reader's view). */
export async function computeImpact(user: User | null, ref: string, opts: z.infer<typeof impactSchema>) {
  const { rows: roots } = await query('SELECT id, ref, name, class FROM configuration_items WHERE ref = $1', [ref.toUpperCase()]);
  const root = roots[0];
  if (!root) throw notFound(`${ref} not found`);
  const up = opts.direction === 'up';
  // next = the node reached from the frontier; for 'up' that is the dependent, for 'down' the dependency.
  const sql = `
    SELECT r.id AS rel_id, r.type, r.from_ci, r.to_ci, t.propagation,
           CASE WHEN (t.propagation = 'forward') = $2 THEN r.from_ci ELSE r.to_ci END AS next,
           CASE WHEN (t.propagation = 'forward') = $2 THEN r.to_ci ELSE r.from_ci END AS prev
    FROM ci_relationships r JOIN ci_relationship_types t ON t.name = r.type
    WHERE CASE WHEN (t.propagation = 'forward') = $2 THEN r.to_ci ELSE r.from_ci END = ANY($1)
    ORDER BY r.id`;
  const reached = new Map<number, { depth: number; via: number; rel: { type: string; from: number; to: number } }>();
  let frontier = [root.id as number];
  let truncated = false, depthLimitReached = false;
  for (let depth = 1; frontier.length; depth++) {
    const { rows } = await query(sql, [frontier, up]);
    if (depth > opts.max_depth) {
      depthLimitReached = rows.some((r) => r.next !== root.id && !reached.has(r.next));
      break;
    }
    const next: number[] = [];
    for (const r of rows) {
      if (r.next === root.id || reached.has(r.next)) continue;
      if (reached.size >= MAX_NODES) { truncated = true; break; }
      reached.set(r.next, { depth, via: r.prev, rel: { type: r.type, from: r.from_ci, to: r.to_ci } });
      next.push(r.next);
    }
    if (truncated) break;
    frontier = next;
  }
  const allowed = await visible(user, [...reached.keys()]);
  const ids = [root.id, ...reached.keys()];
  const { rows: info } = await query(
    `SELECT c.id, c.ref, c.name, c.class, c.ci_type, ty.label AS type_label, c.status, c.environment, c.criticality, c.team
     FROM configuration_items c JOIN ci_types ty ON ty.name = c.ci_type WHERE c.id = ANY($1)`,
    [ids],
  );
  const byId = new Map(info.map((c) => [c.id as number, c]));
  const labels = new Map((await relationshipTypes()).map((t) => [t.name, t.label]));
  const nodes = [...reached.entries()]
    .filter(([id]) => allowed.has(id))
    .map(([id, n]) => {
      const c = byId.get(id)!;
      return {
        ref: c.ref, name: c.name, type: c.class === 'service' ? 'service' : 'ci', ci_type: c.ci_type, type_label: c.type_label,
        status: c.status, environment: c.environment, criticality: c.criticality, team: c.team, depth: n.depth,
        via: allowed.has(n.via) || n.via === root.id ? byId.get(n.via)?.ref : null,
        relationship: { from: byId.get(n.rel.from)?.ref, type: n.rel.type, label: labels.get(n.rel.type), to: byId.get(n.rel.to)?.ref },
      };
    })
    .sort((a, b) => a.depth - b.depth || a.criticality - b.criticality || a.name.localeCompare(b.name));
  return {
    root: { ref: root.ref, name: root.name, type: root.class === 'service' ? 'service' : 'ci' },
    direction: opts.direction,
    meaning: up ? `What is affected if ${root.ref} is down` : `What ${root.ref} depends on`,
    max_depth: opts.max_depth,
    max_nodes: MAX_NODES,
    truncated,
    depth_limit_reached: depthLimitReached,
    count: nodes.length,
    services: nodes.filter((n) => n.type === 'service').map((n) => ({ ref: n.ref, name: n.name, criticality: n.criticality, status: n.status })),
    nodes,
  };
}

// ---- Groups ------------------------------------------------------------------------------------

/** The only fields and operators a rule may use; values are always bound parameters, never SQL or regex. */
const CONDITION = z.object({
  field: z.enum(['tag', 'ci_type', 'environment', 'status', 'team', 'name', 'criticality', 'attribute', 'source_system']),
  key: z.string().regex(/^[a-z][a-z0-9_]*$/).max(50).optional(),
  op: z.enum(['eq', 'neq', 'contains', 'starts_with', 'lte', 'gte']),
  value: z.string().max(200),
});
export const rulesSchema = z.object({ match: z.enum(['all', 'any']).default('all'), conditions: z.array(CONDITION).max(20).default([]) });
export const groupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  purpose: z.enum(['service', 'flow', 'billing', 'monitoring', 'maintenance', 'other']).default('other'),
  description: z.string().max(5000).default(''),
  rules: rulesSchema.default({ match: 'all', conditions: [] }),
});

const likeEscape = (v: string) => v.replace(/[\\%_]/g, (m) => '\\' + m);

/** Builds a WHERE fragment for the rules, appending values to params. Returns null when there are no conditions. */
export function ruleSql(rules: z.infer<typeof rulesSchema>, params: unknown[]): string | null {
  if (!rules.conditions.length) return null;
  const parts = rules.conditions.map((c) => {
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (c.field === 'tag') {
      if (c.op === 'eq') return `${p(c.value)} = ANY(c.tags)`;
      if (c.op === 'neq') return `NOT (${p(c.value)} = ANY(c.tags))`;
      if (c.op === 'starts_with') return `EXISTS (SELECT 1 FROM unnest(c.tags) t WHERE t LIKE ${p(likeEscape(c.value) + '%')})`;
      if (c.op === 'contains') return `EXISTS (SELECT 1 FROM unnest(c.tags) t WHERE t ILIKE ${p('%' + likeEscape(c.value) + '%')})`;
      throw badRequest('Tags support eq, neq, contains and starts_with');
    }
    if (c.field === 'source_system') {
      if (c.op !== 'eq' && c.op !== 'neq') throw badRequest('source_system supports eq and neq');
      return `${c.op === 'neq' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM ci_sources s WHERE s.ci_id = c.id AND s.source_system = ${p(c.value)})`;
    }
    if (c.field === 'criticality') {
      const n = Number(c.value);
      if (!Number.isInteger(n)) throw badRequest('Criticality is a number 1–4');
      const op = { eq: '=', neq: '<>', lte: '<=', gte: '>=' }[c.op as 'eq'];
      if (!op) throw badRequest('Criticality supports eq, neq, lte and gte');
      return `c.criticality ${op} ${p(n)}`;
    }
    let col: string;
    if (c.field === 'attribute') {
      if (!c.key) throw badRequest('Attribute rules need a key');
      col = `coalesce(c.attributes ->> ${p(c.key)}, '')`;
    } else col = `c.${c.field}`;
    if (c.op === 'eq') return `${col} = ${p(c.value)}`;
    if (c.op === 'neq') return `${col} <> ${p(c.value)}`;
    if (c.op === 'contains') return `${col} ILIKE ${p('%' + likeEscape(c.value) + '%')}`;
    if (c.op === 'starts_with') return `${col} LIKE ${p(likeEscape(c.value) + '%')}`;
    throw badRequest(`${c.field} supports eq, neq, contains and starts_with`);
  });
  return `(${parts.join(rules.match === 'all' ? ' AND ' : ' OR ')})`;
}

export async function listGroups(user: User) {
  authorize(user, 'ci.read');
  const { rows } = await query(
    `SELECT g.id, g.name, g.purpose, g.description, g.rules, g.updated_at, (SELECT count(*)::int FROM ci_group_members m WHERE m.group_id = g.id) AS manual_members
     FROM ci_groups g ORDER BY lower(g.name)`,
  );
  return rows;
}

const MAX_MEMBERS = 1000;

export async function getGroup(user: User, id: number) {
  authorize(user, 'ci.read');
  const { rows } = await query('SELECT g.*, u.display_name AS created_by_name FROM ci_groups g LEFT JOIN users u ON u.id = g.created_by WHERE g.id = $1', [id]);
  const g = rows[0];
  if (!g) throw notFound('Group not found');
  const params: unknown[] = [id];
  const rule = ruleSql(g.rules, params);
  params.push(MAX_MEMBERS + 1);
  const { rows: members } = await query(
    `SELECT c.ref, c.name, c.class, c.ci_type, c.status, c.environment, c.criticality, c.team,
            EXISTS (SELECT 1 FROM ci_group_members m WHERE m.group_id = $1 AND m.ci_id = c.id) AS manual,
            ${rule ?? 'false'} AS by_rule
     FROM configuration_items c
     WHERE EXISTS (SELECT 1 FROM ci_group_members m WHERE m.group_id = $1 AND m.ci_id = c.id) ${rule ? `OR ${rule}` : ''}
     ORDER BY c.class DESC, c.criticality, lower(c.name) LIMIT $${params.length}`,
    params,
  );
  return {
    ...g,
    truncated: members.length > MAX_MEMBERS,
    members: members.slice(0, MAX_MEMBERS).map((m) => ({ ...m, type: m.class === 'service' ? 'service' : 'ci' })),
  };
}

export async function saveGroup(user: User, id: number | null, input: z.infer<typeof groupSchema>) {
  authorize(user, 'ci.manage');
  ruleSql(input.rules, []); // validates operator/field combinations
  try {
    const { rows } = id
      ? await query('UPDATE ci_groups SET name = $2, purpose = $3, description = $4, rules = $5, updated_at = now() WHERE id = $1 RETURNING id', [id, input.name, input.purpose, input.description, JSON.stringify(input.rules)])
      : await query('INSERT INTO ci_groups (name, purpose, description, rules, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id', [input.name, input.purpose, input.description, JSON.stringify(input.rules), user.id]);
    if (!rows[0]) throw notFound('Group not found');
    await audit(null, { entity_type: 'ci_group', entity_ref: input.name, action: id ? 'update' : 'create', changes: input });
    return getGroup(user, rows[0].id);
  } catch (err: any) {
    if (err.code === '23505') throw conflict('A group with that name already exists');
    throw err;
  }
}

export async function deleteGroup(user: User, id: number) {
  authorize(user, 'ci.manage');
  const { rows } = await query('DELETE FROM ci_groups WHERE id = $1 RETURNING name', [id]);
  if (!rows[0]) throw notFound('Group not found');
  await audit(null, { entity_type: 'ci_group', entity_ref: rows[0].name, action: 'delete', changes: {} });
}

export async function setMember(user: User, id: number, ref: string, member: boolean) {
  authorize(user, 'ci.manage');
  await tx(async (db) => {
    const ci = await loadCi(db, ref);
    const { rows: g } = await db.query('SELECT name FROM ci_groups WHERE id = $1', [id]);
    if (!g[0]) throw notFound('Group not found');
    const { rowCount } = member
      ? await db.query('INSERT INTO ci_group_members (group_id, ci_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, ci.id, user.id])
      : await db.query('DELETE FROM ci_group_members WHERE group_id = $1 AND ci_id = $2', [id, ci.id]);
    if (rowCount) await logCi(db, ci.id, user.id, 'update', `${member ? 'Added to' : 'Removed from'} group ${g[0].name}`, { group: g[0].name, member });
  });
  return getGroup(user, id);
}

// ---- On the CI page ----------------------------------------------------------------------------

registerCiExtra(async (ciId) => {
  const [rels, groups] = await Promise.all([
    query(
      `SELECT r.id, r.type, r.source_system, r.last_seen_at, ty.label, ty.inverse_label,
              r.from_ci = $1 AS outgoing, o.ref, o.name, o.class, o.status
       FROM ci_relationships r JOIN ci_relationship_types ty ON ty.name = r.type
       JOIN configuration_items o ON o.id = CASE WHEN r.from_ci = $1 THEN r.to_ci ELSE r.from_ci END
       WHERE $1 IN (r.from_ci, r.to_ci) ORDER BY r.type, o.name LIMIT 500`,
      [ciId],
    ),
    groupsOf(ciId),
  ]);
  return {
    relationships: rels.rows.map((r) => ({
      id: r.id, type: r.type, direction: r.outgoing ? 'outgoing' : 'incoming', label: r.outgoing ? r.label : r.inverse_label,
      ref: r.ref, name: r.name, other_type: r.class === 'service' ? 'service' : 'ci', status: r.status,
      discovered_by: r.source_system, last_seen_at: r.last_seen_at,
    })),
    groups,
  };
});

async function groupsOf(ciId: number) {
  const { rows: groups } = await query('SELECT id, name, purpose, rules, EXISTS (SELECT 1 FROM ci_group_members m WHERE m.group_id = g.id AND m.ci_id = $1) AS manual FROM ci_groups g LIMIT 200', [ciId]);
  const out: { id: number; name: string; purpose: string; membership: 'manual' | 'rule' }[] = [];
  for (const g of groups) {
    if (g.manual) { out.push({ id: g.id, name: g.name, purpose: g.purpose, membership: 'manual' }); continue; }
    const params: unknown[] = [ciId];
    const rule = ruleSql(g.rules, params);
    if (!rule) continue;
    const { rows } = await query(`SELECT 1 FROM configuration_items c WHERE c.id = $1 AND ${rule}`, params);
    if (rows[0]) out.push({ id: g.id, name: g.name, purpose: g.purpose, membership: 'rule' });
  }
  return out;
}
