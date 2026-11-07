// Standard change templates, change freezes and the change schedule (#29), split out of changes.ts (#237).
import { z } from 'zod';
import { instant, longText } from '../core/fields.js';
import type { User } from '../security/auth.js';
import { audit } from '../security/audit.js';
import { query } from '../core/db.js';
import { badRequest, conflict, notFound } from '../core/errors.js';
import { authorize } from '../security/policy.js';
import { RISKS } from './changes.js';


// ---- Templates and freezes ---------------------------------------------------------------------

export const templateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /** The highest assessed risk the template may be used for; above it, a normal change is needed. */
  max_risk: z.enum(RISKS).default('low'),
  /** CI types the template may change; empty means any type (within max_risk). */
  ci_types: z.array(z.string().max(50)).max(30).default([]),
  description: longText.default(''),
  implementation_plan: longText.min(1),
  test_plan: longText.default(''),
  backout_plan: longText.min(1),
  active: z.boolean().default(true),
});

export async function listTemplates(user: User) {
  authorize(user, 'change.read');
  return (await query('SELECT * FROM change_templates ORDER BY active DESC, name')).rows;
}

export async function saveTemplate(user: User, id: number | null, input: z.infer<typeof templateSchema>) {
  authorize(user, 'change.manage');
  const cols = Object.keys(input) as (keyof typeof input)[];
  try {
    const { rows } = id
      ? await query(`UPDATE change_templates SET ${cols.map((k, n) => `${k} = $${n + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [id, ...cols.map((k) => input[k])])
      : await query(`INSERT INTO change_templates (${cols.join(', ')}, created_by) VALUES (${cols.map((_, n) => `$${n + 1}`).join(', ')}, $${cols.length + 1}) RETURNING *`, [...cols.map((k) => input[k]), user.id]);
    if (!rows[0]) throw notFound('Template not found');
    await audit(null, { entity_type: 'change_template', entity_ref: input.name, action: id ? 'update' : 'create', changes: input });
    return rows[0];
  } catch (err: any) {
    if (err.code === '23505') throw conflict('A template with that name already exists');
    throw err;
  }
}

export const freezeSchema = z.object({ name: z.string().trim().min(1).max(200), starts_at: instant, ends_at: instant, reason: z.string().trim().max(1000).default('') });

export async function listFreezes(user: User) {
  authorize(user, 'change.read');
  return (await query("SELECT f.*, u.display_name AS created_by_name FROM change_freezes f LEFT JOIN users u ON u.id = f.created_by WHERE f.ends_at > now() - interval '30 days' ORDER BY f.starts_at")).rows;
}

export async function addFreeze(user: User, input: z.infer<typeof freezeSchema>) {
  authorize(user, 'change.manage');
  if (new Date(input.ends_at) <= new Date(input.starts_at)) throw badRequest('The freeze must end after it starts');
  const { rows } = await query('INSERT INTO change_freezes (name, starts_at, ends_at, reason, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *', [input.name, input.starts_at, input.ends_at, input.reason, user.id]);
  await audit(null, { entity_type: 'change_freeze', entity_ref: input.name, action: 'create', changes: input });
  return rows[0];
}

export async function deleteFreeze(user: User, id: number) {
  authorize(user, 'change.manage');
  const { rows } = await query('DELETE FROM change_freezes WHERE id = $1 RETURNING name', [id]);
  if (!rows[0]) throw notFound('Freeze not found');
  await audit(null, { entity_type: 'change_freeze', entity_ref: rows[0].name, action: 'delete', changes: {} });
}

// ---- Schedule ----------------------------------------------------------------------------------

export const scheduleSchema = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() });

/** Planned changes and freezes in a period, with collisions (same CI, overlapping windows) marked. */
export async function changeSchedule(user: User, f: z.infer<typeof scheduleSchema>) {
  authorize(user, 'change.read');
  const from = f.from ?? new Date().toISOString().slice(0, 10);
  const to = f.to ?? new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
  const [changes, freezes, collisions] = await Promise.all([
    query(
      `SELECT c.ref, c.title, c.change_type, c.status, c.risk, c.planned_start, c.planned_end, c.outcome,
              (SELECT array_agg(ci.name ORDER BY ci.criticality) FROM change_cis x JOIN configuration_items ci ON ci.id = x.ci_id WHERE x.change_id = c.id) AS cis
       FROM changes c
       WHERE c.status NOT IN ('rejected', 'cancelled', 'draft') AND c.planned_start < $2::date + 1 AND c.planned_end > $1::date
       ORDER BY c.planned_start LIMIT 500`,
      [from, to],
    ),
    query('SELECT id, name, starts_at, ends_at, reason FROM change_freezes WHERE starts_at < $2::date + 1 AND ends_at > $1::date ORDER BY starts_at', [from, to]),
    query(
      `SELECT DISTINCT a.ref AS change, b.ref AS with, ci.ref AS ci, ci.name AS ci_name
       FROM changes a JOIN change_cis xa ON xa.change_id = a.id JOIN change_cis xb ON xb.ci_id = xa.ci_id JOIN changes b ON b.id = xb.change_id AND b.id <> a.id
       JOIN configuration_items ci ON ci.id = xa.ci_id
       WHERE a.status NOT IN ('rejected', 'cancelled', 'draft', 'closed') AND b.status NOT IN ('rejected', 'cancelled', 'draft', 'closed')
         AND a.planned_start < b.planned_end AND a.planned_end > b.planned_start
         AND a.planned_start < $2::date + 1 AND a.planned_end > $1::date`,
      [from, to],
    ),
  ]);
  return { from, to, changes: changes.rows, freezes: freezes.rows, collisions: collisions.rows };
}
