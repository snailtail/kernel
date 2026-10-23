// User accounts: administration (create, change, erase) and each person's own preferences and password.
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { audit, requireReason } from './audit.js';
import { hashPassword, type User } from './auth.js';
import { query, USER_COLUMNS } from './db.js';
import { badRequest, conflict, HttpError, notFound } from './errors.js';
import { SECURITY_SOURCE } from './events.js';
import { TILES } from './kpis.js';
import { checkSecondFactor, forgetDevices } from './mfa.js';
import { checkPassword } from './passwords.js';
import { HOMES, NEW_KINDS } from './start-page.js';
import { legacyRole, ROLES } from './workflow.js';

const userFields = {
  username: z.string().trim().min(2).max(50).regex(/^[a-zA-Z0-9._-]+$/, 'Use letters, digits, dot, dash or underscore'),
  display_name: z.string().trim().min(1).max(100),
  email: z.string().trim().max(200),
  role: z.preprocess(legacyRole, z.enum(ROLES)),
  active: z.boolean(),
  /** Source systems an integration account may report CIs for (exact names, e.g. vCenter). */
  ci_source_systems: z.array(z.string().trim().min(1).max(100)).max(20),
  /** Standard change templates a pipeline (integration) account may register changes from. */
  change_templates: z.array(z.number().int()).max(50),
};
const password = z.string();
export const createUserSchema = z.object({ ...userFields, email: userFields.email.default(''), active: userFields.active.default(true), ci_source_systems: userFields.ci_source_systems.default([]), change_templates: userFields.change_templates.default([]), password });
export const updateUserSchema = z.object({ ...userFields, password, reason: z.string().max(1000).optional() }).partial().omit({ username: true });
const ADMIN_COLUMNS = 'id, username, display_name, email, role, active, ci_source_systems, change_templates, created_at, mfa_enabled_at IS NOT NULL AS mfa_enabled';

export const listUsers = async () => (await query(`SELECT ${ADMIN_COLUMNS} FROM users ORDER BY username`)).rows;

export async function createUser(input: z.infer<typeof createUserSchema>) {
  await checkPassword(input.password, input);
  try {
    const { rows } = await query(
      `INSERT INTO users (username, display_name, email, role, active, ci_source_systems, change_templates, password_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${ADMIN_COLUMNS}`,
      [input.username, input.display_name, input.email, input.role, input.active, input.ci_source_systems, input.change_templates, await hashPassword(input.password)],
    );
    await audit(null, { entity_type: 'user', entity_ref: input.username, action: 'create', changes: { display_name: input.display_name, email: input.email, role: input.role, active: input.active, ci_source_systems: input.ci_source_systems } });
    return rows[0];
  } catch (err: any) {
    if (err.code === '23505') throw conflict('Username is already taken');
    throw err;
  }
}

export async function updateUser(admin: User, id: number, input: z.infer<typeof updateUserSchema>) {
  if (id === admin.id && (input.active === false || (input.role && input.role !== 'admin'))) {
    throw badRequest('You cannot deactivate or demote yourself');
  }
  const { password: newPassword, reason, ...fields } = input;
  const { rows: before } = await query(`SELECT ${ADMIN_COLUMNS} FROM users WHERE id = $1`, [id]);
  if (!before[0]) throw notFound();
  // Changing someone's role, status or password is sensitive: a reason is required and recorded.
  const sourcesChanged = (fields.ci_source_systems !== undefined && JSON.stringify(fields.ci_source_systems) !== JSON.stringify(before[0].ci_source_systems))
    || (fields.change_templates !== undefined && JSON.stringify(fields.change_templates) !== JSON.stringify(before[0].change_templates));
  const sensitive = id !== admin.id && (newPassword || sourcesChanged || (fields.role && fields.role !== before[0].role) || (fields.active !== undefined && fields.active !== before[0].active));
  const why = sensitive ? requireReason(reason) : reason;
  if (newPassword) await checkPassword(newPassword, { username: before[0].username, ...fields });
  const sets = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (newPassword) sets.push(['password_hash', await hashPassword(newPassword)]);
  if (!sets.length) throw badRequest('Nothing to update');
  const { rows } = await query(
    `UPDATE users SET ${sets.map(([k], i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING ${ADMIN_COLUMNS}`,
    [id, ...sets.map(([, v]) => v)],
  );
  if (!rows[0]) throw notFound();
  const changes: Record<string, unknown> = Object.fromEntries(
    Object.entries(fields).filter(([k, v]) => v !== undefined && JSON.stringify(before[0][k]) !== JSON.stringify(v)).map(([k, v]) => [k, { from: before[0][k], to: v }]),
  );
  if (newPassword) changes.password = '[changed]';
  await audit(null, { entity_type: 'user', entity_ref: before[0].username, action: 'update', changes, reason: why });
  // Changing role, status or password signs the user out everywhere.
  await query('DELETE FROM sessions WHERE user_id = $1 AND user_id <> $2', [id, admin.id]);
  return rows[0];
}

// Erasure (GDPR): the account is anonymised, sessions and tokens end. Records keep the user's id, so the audit
// trail stays intact and shows "deleted user #id". What remains, under legitimate interest (ADR 0001), is the
// network context – IP address and user agent – in audit_context and security_events, until their retention
// (privacy.audit_context_days and security_event_days) removes it.
export async function eraseUser(admin: User, id: number, reason: string) {
  if (id === admin.id) throw badRequest('You cannot erase your own account');
  const { rows: old } = await query('SELECT username FROM users WHERE id = $1', [id]);
  const { rows } = await query(
    `UPDATE users SET username = 'deleted-' || id, display_name = 'Deleted user #' || id, email = '', active = false, erased_at = now(),
            password_hash = $2, mfa_secret = NULL, mfa_enabled_at = NULL, preferences = '{}', ci_source_systems = '{}', change_templates = '{}'
     WHERE id = $1 AND erased_at IS NULL RETURNING id`,
    [id, await hashPassword(randomBytes(32).toString('base64url'))],
  );
  if (!rows[0]) throw notFound('No such user, or already erased');
  await query('DELETE FROM sessions WHERE user_id = $1', [id]);
  await query('UPDATE api_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE user_id = $1', [id]);
  await query('DELETE FROM notification_settings WHERE user_id = $1', [id]);
  await query('DELETE FROM known_devices WHERE user_id = $1', [id]).catch(() => {});
  // Security alerts name the account they are about (#64): the name goes, the alert stays.
  const name = `(?<![\\w.@-])${old[0].username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.@-])`;
  await query(
    `UPDATE alerts SET check_key = regexp_replace(check_key, $2, $3, 'g'), message = regexp_replace(message, $2, $3, 'g') WHERE source = $1 AND (check_key ~ $2 OR message ~ $2)`,
    [SECURITY_SOURCE, name, `deleted user #${id}`],
  );
  await query("UPDATE events SET message = regexp_replace(message, $2, $3, 'g') WHERE source = $1 AND message ~ $2", [SECURITY_SOURCE, name, `deleted user #${id}`]);
  await audit(null, { entity_type: 'user', entity_ref: `#${id}`, action: 'erase', reason });
}

// ---- The signed-in person's own account ------------------------------------------------------

/** The account as the web UI gets it after signing in. */
export const signedInUser = async (id: number) => (await query(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1`, [id])).rows[0];

export const usernameOf = async (id: number): Promise<string> => (await query('SELECT username FROM users WHERE id = $1', [id])).rows[0].username;

export const preferencesSchema = z
  .object({
    theme: z.enum(['system', 'light', 'dark']).optional(),
    guided: z.boolean().optional(),
    intro_seen: z.boolean().optional(),
    live_presence: z.boolean().optional(),
    nav_collapsed: z.array(z.enum(['respond', 'improve', 'learn', 'directory'])).max(4).optional(),
    // Unknown tile ids are dropped (a tile may go when a module is switched off), and each tile counts once.
    home: z.enum(HOMES).nullable().optional(),
    default_new: z.enum(NEW_KINDS).nullable().optional(),
    start_seen: z.boolean().optional(),
    dashboard_tiles: z.array(z.string().max(40)).max(20).transform((t) => [...new Set(t)].filter((id): id is (typeof TILES)[number] => (TILES as readonly string[]).includes(id))).optional(),
  })
  .strict();

export async function savePreferences(user: User, preferences: z.infer<typeof preferencesSchema>) {
  const { rows } = await query('UPDATE users SET preferences = preferences || $2 WHERE id = $1 RETURNING preferences', [user.id, preferences]);
  return rows[0].preferences;
}

export const passwordChangeSchema = z.object({ current: z.string(), password: z.string(), revoke_tokens: z.boolean().optional(), code: z.string().max(40).optional() });

/**
 * A new password, checked against the current one (and the second factor, when the account has one). Other sessions
 * end, and so do the API tokens when asked; `keep` is the current session and device, which stay signed in.
 */
export async function changePassword(user: User, input: z.infer<typeof passwordChangeSchema>, keep: { session: string; device?: string }) {
  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
  if (!(await bcrypt.compare(input.current, rows[0].password_hash))) throw badRequest('Current password is incorrect');
  if (input.password === input.current) throw badRequest('Choose a new password');
  if (user.mfa_enabled && !(input.code && (await checkSecondFactor(user.id, input.code)))) {
    throw new HttpError(400, 'Enter a code from your authenticator app to change the password', { code_required: true });
  }
  await checkPassword(input.password, user);
  await query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [user.id, await hashPassword(input.password)]);
  await query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [user.id, keep.session]);
  if (input.revoke_tokens) await query('DELETE FROM api_tokens WHERE user_id = $1', [user.id]);
  await forgetDevices(user.id, keep.device);
  await audit(null, { entity_type: 'user', entity_ref: user.username, action: 'password_change', changes: { password: '[changed]', revoked_tokens: !!input.revoke_tokens } });
}
