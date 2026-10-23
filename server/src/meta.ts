// Reference data every practice reads (#171): the web UI's /api/meta and MCP's list_reference_data share it.
import * as actions from './actions.js';
import * as analyses from './analyses.js';
import { audit } from './audit.js';
import type { User } from './auth.js';
import { config } from './config.js';
import { query } from './db.js';
import { conflict, notFound } from './errors.js';
import { modules } from './modules.js';
import * as problems from './problems.js';
import { hiddenRecordsExist } from './visibility.js';
import { CLOSURE_CODES, EC_DECISIONS, ROLES, STATUSES, TRANSITIONS, WORKAROUND_EFFECTIVENESS } from './workflow.js';

/** All categories, inactive ones too (records may still carry them). */
export const listCategories = async () => (await query('SELECT id, name, active FROM categories ORDER BY name')).rows as { id: number; name: string; active: boolean }[];

/** A category's id by its name, in any case. */
export const categoryIdByName = async (name: string): Promise<number | undefined> =>
  (await query('SELECT id FROM categories WHERE lower(name) = lower($1)', [name])).rows[0]?.id;

export async function createCategory(name: string) {
  const { rows } = await query('INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING *', [name]);
  if (!rows[0]) throw conflict('Category already exists');
  await audit(null, { entity_type: 'category', entity_ref: name, action: 'create' });
  return rows[0];
}

export async function updateCategory(id: number, input: { name?: string; active?: boolean }) {
  const { rows: before } = await query('SELECT * FROM categories WHERE id = $1', [id]);
  if (!before[0]) throw notFound();
  const { rows } = await query(
    'UPDATE categories SET name = coalesce($2, name), active = coalesce($3, active) WHERE id = $1 RETURNING *',
    [id, input.name ?? null, input.active ?? null],
  );
  await audit(null, {
    entity_type: 'category',
    entity_ref: before[0].name,
    action: 'update',
    changes: Object.fromEntries(Object.entries(input).filter(([k, v]) => v !== undefined && before[0][k] !== v).map(([k, v]) => [k, { from: before[0][k], to: v }])),
  });
  return rows[0];
}

/** People who can be assigned work: active, and neither viewers nor integration accounts. */
export const listAssignees = async () =>
  (await query("SELECT id, username, display_name, role FROM users WHERE active AND role NOT IN ('viewer', 'integration') ORDER BY display_name")).rows as { id: number; username: string; display_name: string; role: string }[];

export async function getMeta(user: User) {
  const [categories, assignees, setup] = await Promise.all([listCategories(), listAssignees(), query("SELECT value FROM settings WHERE key = 'setup'")]);
  return {
    modules: modules(),
    setup_completed: !!setup.rows[0]?.value?.completed,
    statuses: STATUSES,
    transitions: TRANSITIONS,
    closure_codes: CLOSURE_CODES,
    roles: ROLES,
    link_kinds: problems.LINK_KINDS,
    action_statuses: actions.ACTION_STATUSES,
    techniques: analyses.TECHNIQUES,
    ec_decisions: EC_DECISIONS,
    workaround_effectiveness: WORKAROUND_EFFECTIVENESS,
    mcp_url: config.mcpUrl,
    categories,
    assignees: assignees.map(({ id, display_name, role }) => ({ id, display_name, role })),
    // Managers' numbers leave out restricted records they cannot see; the UI says so (a yes/no, never a count).
    hidden_records: ['admin', 'manager'].includes(user.role) ? await hiddenRecordsExist() : false,
  };
}
