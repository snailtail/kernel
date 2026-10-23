// Module switches, the first-run setup wizard and templates (#36). The wizard is idempotent – running it again
// changes settings, it never duplicates SLAs, calendars or sources – and every step can be skipped. Demo data is
// recorded in demo_records so it can be removed in one action, and it is refused once real data exists.
import { z } from 'zod';
import type { User } from './auth.js';
import { audit } from './audit.js';
import { createChange, logChange } from './changes.js';
import { addRelationship } from './cmdb-graph.js';
import { createCi, logCi } from './cmdb.js';
import { query, tx } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { createSource } from './event-hooks.js';
import { createIncident } from './incidents.js';
import { MODULE_DEFAULTS, moduleEnabled, MODULES, refreshModules, type Module } from './modules.js';
import { authorize } from './policy.js';
import { createProblem, logActivity, transitionProblem } from './problems.js';
import { logIncident } from './incident-log.js';

export const modulesSchema = z.object(Object.fromEntries(Object.keys(MODULES).map((m) => [m, z.boolean().optional()])) as Record<Module, z.ZodOptional<z.ZodBoolean>>);

export async function getModules() {
  const { rows } = await query("SELECT value FROM settings WHERE key = 'modules'");
  const on = rows[0]?.value ?? {};
  return Object.entries(MODULES).map(([key, m]) => ({ key, ...m, enabled: on[key] ?? MODULE_DEFAULTS[key as Module] }));
}

export async function setModules(user: User, input: z.infer<typeof modulesSchema>, reason?: string) {
  authorize(user, 'user.manage');
  await tx(async (db) => {
    const { rows } = await db.query("SELECT value FROM settings WHERE key = 'modules'");
    const before = rows[0]?.value ?? {};
    const after = { ...before, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
    await db.query("INSERT INTO settings (key, value) VALUES ('modules', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [after]);
    const changes = Object.fromEntries(Object.keys(after).filter((k) => before[k] !== after[k]).map((k) => [k, { from: before[k] ?? MODULE_DEFAULTS[k as Module], to: after[k] }]));
    if (Object.keys(changes).length) await audit(db, { entity_type: 'setting', entity_ref: 'modules', action: 'update', changes, reason });
  });
  await refreshModules();
  return getModules();
}

// ---- Setup wizard ------------------------------------------------------------------------------

export async function setupState() {
  const { rows } = await query("SELECT value FROM settings WHERE key = 'setup'");
  const real = await hasRealData();
  const { rows: demo } = await query('SELECT count(*)::int AS n FROM demo_records');
  return { completed: !!rows[0]?.value?.completed, has_real_data: real, demo_records: demo[0].n, demo_references: demo[0].n ? (await demoReferences()).map(({ id: _, ...r }) => r) : [], modules: await getModules() };
}

async function hasRealData() {
  const { rows } = await query(
    `SELECT (SELECT count(*) FROM problems p WHERE NOT EXISTS (SELECT 1 FROM demo_records d WHERE d.kind = 'problem' AND d.record_id = p.id))
          + (SELECT count(*) FROM incidents i WHERE NOT EXISTS (SELECT 1 FROM demo_records d WHERE d.kind = 'incident' AND d.record_id = i.id))
          + (SELECT count(*) FROM configuration_items c WHERE NOT EXISTS (SELECT 1 FROM demo_records d WHERE d.kind = 'ci' AND d.record_id = c.id)) AS n`,
  );
  return Number(rows[0].n) > 0;
}

export const setupSchema = z.object({
  modules: modulesSchema.optional(),
  /** Business hours for the default SLA: around the clock, or Swedish office hours. */
  support_hours: z.enum(['24/7', 'office']).optional(),
  demo_data: z.boolean().optional(),
  first_source: z.object({ kind: z.enum(['uptime_kuma', 'alertmanager', 'azure_monitor', 'op5', 'generic']), name: z.string().trim().min(1).max(100) }).optional(),
});

/** Applies the wizard's choices; each part is optional and safe to repeat. */
export async function completeSetup(user: User, input: z.infer<typeof setupSchema>) {
  authorize(user, 'user.manage');
  const result: Record<string, unknown> = {};
  if (input.modules) result.modules = await setModules(user, input.modules, 'Setup wizard');
  if (input.support_hours) {
    // Points the default SLA at the chosen calendar; never creates another SLA or calendar.
    const name = input.support_hours === '24/7' ? '24/7' : 'Office hours (Sweden)';
    const { rows } = await query('UPDATE slas SET calendar_id = (SELECT id FROM business_calendars WHERE name = $1) WHERE is_default RETURNING name', [name]);
    result.support_hours = rows[0] ? name : null;
  }
  if (input.first_source) {
    const { rows } = await query('SELECT id FROM event_sources WHERE name = $1', [input.first_source.name]);
    result.first_source = rows[0] ? { id: rows[0].id, existing: true } : await createSource(user, { ...input.first_source, ci_source_system: '', signed: false });
  }
  if (input.demo_data) result.demo = await loadDemoData(user);
  await query("INSERT INTO settings (key, value) VALUES ('setup', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [{ completed: true, completed_at: new Date().toISOString(), by: user.username }]);
  await audit(null, { entity_type: 'setting', entity_ref: 'setup', action: 'complete', changes: { ...input, first_source: input.first_source?.name ?? null } });
  return { ...(await setupState()), result };
}

// ---- Demo data ---------------------------------------------------------------------------------

async function remember(kind: 'problem' | 'incident' | 'change' | 'ci', ref: string) {
  const table = { problem: 'problems', incident: 'incidents', change: 'changes', ci: 'configuration_items' }[kind];
  await query(`INSERT INTO demo_records (kind, record_id) SELECT $1, id FROM ${table} WHERE ref = $2 ON CONFLICT DO NOTHING`, [kind, ref]);
}

/** A small, coherent example: a service on a VM and a database, an incident, a known error and a change. */
async function loadDemoData(user: User) {
  authorize(user, 'user.manage');
  if (await hasRealData()) throw conflict('Kernel already has real data; demo data is only offered on an empty installation');
  const { rows: existing } = await query('SELECT count(*)::int AS n FROM demo_records');
  if (existing[0].n > 0) return { loaded: false, reason: 'Demo data is already loaded' };
  // Only for the modules that are on.
  const refs: string[] = [];
  const cmdb = moduleEnabled('cmdb');
  let vm: { ref: string } | null = null, dbCi: { ref: string } | null = null;
  if (cmdb) {
    const svc = await createCi(user, { name: 'Webshop (demo)', ci_type: 'business_service', criticality: 1, description: 'Example service' });
    const host = await createCi(user, { name: 'shop-vm01 (demo)', ci_type: 'virtual_machine', attributes: { os: 'Ubuntu 24.04', ip: '10.0.0.10' } });
    const database = await createCi(user, { name: 'shop-db (demo)', ci_type: 'database', attributes: { engine: 'PostgreSQL', version: '17' } });
    vm = host;
    dbCi = database;
    for (const r of [svc, host, database]) {
      await remember('ci', r.ref);
      refs.push(r.ref);
    }
    await addRelationship(user, host.ref, { type: 'member_of', target: svc.ref, direction: 'outgoing' });
    await addRelationship(user, host.ref, { type: 'uses_database', target: database.ref, direction: 'outgoing' });
  }
  const p = await createProblem(user, { title: 'Checkout times out under load (demo)', description: 'Customers see timeouts at checkout during campaigns.', impact: 2, urgency: 2 });
  await remember('problem', p.ref);
  refs.push(p.ref);
  await transitionProblem(user, p.ref, { to: 'analysis' });
  await transitionProblem(user, p.ref, { to: 'known_error', root_cause: 'The database connection pool is too small for campaign traffic.', workaround: 'Restart the shop service to release connections.' });
  if (dbCi) await query('INSERT INTO problem_cis (problem_id, ci_id, added_by) SELECT p.id, c.id, $3 FROM problems p, configuration_items c WHERE p.ref = $1 AND c.ref = $2 ON CONFLICT DO NOTHING', [p.ref, dbCi.ref, user.id]);
  if (moduleEnabled('incident')) {
    const i = await createIncident(user, { title: 'Checkout is slow (demo)', impact: 2, urgency: 1, cis: vm ? [vm.ref] : [] });
    await remember('incident', i.ref);
    refs.push(i.ref);
  }
  if (moduleEnabled('change')) {
    const c = await createChange(user, { title: 'Increase the database pool (demo)', cis: dbCi ? [dbCi.ref] : [], problem: p.ref, implementation_plan: 'Raise max_connections and the pool size.', backout_plan: 'Restore the previous configuration.' });
    await remember('change', c.ref);
    refs.push(c.ref);
  }
  return { loaded: true, refs };
}

const DEMO = (kind: string, alias: string) => `EXISTS (SELECT 1 FROM demo_records d WHERE d.kind = '${kind}' AND d.record_id = ${alias})`;

/** Real records that point at demo records; removing the demo unlinks them, so they are shown first. */
async function demoReferences(db: Pick<import('pg').PoolClient, 'query'> = { query } as any) {
  const { rows } = await db.query(
    `SELECT 'incident' AS type, i.id, i.ref, p.ref AS demo_ref FROM incidents i JOIN problems p ON p.id = i.problem_id WHERE NOT ${DEMO('incident', 'i.id')} AND ${DEMO('problem', 'p.id')}
     UNION ALL SELECT 'change', c.id, c.ref, p.ref FROM changes c JOIN problems p ON p.id = c.problem_id WHERE NOT ${DEMO('change', 'c.id')} AND ${DEMO('problem', 'p.id')}
     UNION ALL SELECT 'problem', p.id, p.ref, ci.ref FROM problem_cis x JOIN problems p ON p.id = x.problem_id JOIN configuration_items ci ON ci.id = x.ci_id WHERE NOT ${DEMO('problem', 'p.id')} AND ${DEMO('ci', 'ci.id')}
     UNION ALL SELECT 'incident', i.id, i.ref, ci.ref FROM incident_cis x JOIN incidents i ON i.id = x.incident_id JOIN configuration_items ci ON ci.id = x.ci_id WHERE NOT ${DEMO('incident', 'i.id')} AND ${DEMO('ci', 'ci.id')}
     UNION ALL SELECT 'change', c.id, c.ref, ci.ref FROM change_cis x JOIN changes c ON c.id = x.change_id JOIN configuration_items ci ON ci.id = x.ci_id WHERE NOT ${DEMO('change', 'c.id')} AND ${DEMO('ci', 'ci.id')}
     UNION ALL SELECT 'ci', real.id, real.ref, demo.ref FROM ci_relationships r
       JOIN configuration_items real ON real.id IN (r.from_ci, r.to_ci) JOIN configuration_items demo ON demo.id IN (r.from_ci, r.to_ci) AND demo.id <> real.id
       WHERE NOT ${DEMO('ci', 'real.id')} AND ${DEMO('ci', 'demo.id')}
     ORDER BY 3`,
  );
  return rows as { type: 'incident' | 'change' | 'problem' | 'ci'; id: number; ref: string; demo_ref: string }[];
}

/**
 * Removes everything the demo created, in one action. When real records point at demo records, nothing happens
 * until the caller confirms; then each real record gets a history entry saying what was unlinked.
 */
export async function removeDemoData(user: User, confirm = false) {
  authorize(user, 'user.manage');
  const refs = await demoReferences();
  if (refs.length && !confirm) {
    throw conflict(`${refs.length} real record${refs.length === 1 ? '' : 's'} link to demo data; confirm to unlink them`, { references: refs.map(({ id: _, ...r }) => r) });
  }
  const removed = await tx(async (db) => {
    for (const r of refs) {
      const body = `Unlinked ${r.demo_ref}: demo data removed`;
      const data = { kind: 'demo', reference: r.demo_ref, action: 'remove' };
      if (r.type === 'problem') await logActivity(db, r.id, user.id, 'link', body, data);
      else if (r.type === 'incident') await logIncident(db, r.id, user.id, 'link', body, data);
      else if (r.type === 'change') await logChange(db, r.id, user.id, 'link', body, data);
      else await logCi(db, r.id, user.id, 'relationship', body, data);
    }
    const counts: Record<string, number> = {};
    for (const [kind, table] of [['change', 'changes'], ['incident', 'incidents'], ['problem', 'problems'], ['ci', 'configuration_items']] as const) {
      const { rowCount } = await db.query(`DELETE FROM ${table} WHERE id IN (SELECT record_id FROM demo_records WHERE kind = $1)`, [kind]);
      counts[kind] = rowCount ?? 0;
    }
    await db.query('DELETE FROM demo_records');
    await audit(db, { entity_type: 'setting', entity_ref: 'demo_data', action: 'remove', changes: { ...counts, unlinked_real_records: refs.map((r) => r.ref) } });
    return counts;
  });
  return { removed };
}

// ---- Templates ---------------------------------------------------------------------------------

export const templateSchema = z.object({
  kind: z.enum(['incident', 'problem']),
  name: z.string().trim().min(1).max(100),
  fields: z.object({
    title: z.string().max(300).optional(),
    description: z.string().max(20000).optional(),
    impact: z.number().int().min(1).max(3).optional(),
    urgency: z.number().int().min(1).max(3).optional(),
    category_id: z.number().int().nullable().optional(),
    assignment_group: z.string().max(100).optional(),
    cis: z.array(z.string().max(30)).max(20).optional(),
  }),
  active: z.boolean().default(true),
});

export async function listTemplates(user: User, kind?: string) {
  authorize(user, 'meta.read');
  const { rows } = await query(`SELECT * FROM record_templates ${kind ? 'WHERE kind = $1' : ''} ORDER BY kind, active DESC, name`, kind ? [kind] : []);
  return rows;
}

export async function saveTemplate(user: User, id: number | null, input: z.infer<typeof templateSchema>) {
  authorize(user, 'category.manage');
  try {
    const { rows } = id
      ? await query('UPDATE record_templates SET kind = $2, name = $3, fields = $4, active = $5 WHERE id = $1 RETURNING *', [id, input.kind, input.name, input.fields, input.active])
      : await query('INSERT INTO record_templates (kind, name, fields, active, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *', [input.kind, input.name, input.fields, input.active, user.id]);
    if (!rows[0]) throw notFound('Template not found');
    await audit(null, { entity_type: 'template', entity_ref: `${input.kind}:${input.name}`, action: id ? 'update' : 'create', changes: input });
    return rows[0];
  } catch (err: any) {
    if (err.code === '23505') throw badRequest('A template with that name already exists');
    throw err;
  }
}
