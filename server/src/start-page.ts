// A personal start page and default process (#171). Kernel favours no practice: each person chooses where they start
// (`home`) and what "+ New" and the n key create first (`default_new`). When they have not chosen, an administrator's
// default for their role applies, and otherwise My work and incidents. A choice whose module is switched off falls
// back the same way, so nobody lands on a page that answers 404.
import { z } from 'zod';
import { audit } from './audit.js';
import type { User } from './auth.js';
import { query, tx } from './db.js';
import { moduleEnabled, type Module } from './modules.js';
import { authorize } from './policy.js';

export const HOMES = ['my_work', 'dashboard', 'incidents', 'problems', 'changes', 'requests', 'improvements'] as const;
export type Home = (typeof HOMES)[number];
export const NEW_KINDS = ['incident', 'problem', 'change', 'article', 'improvement', 'request'] as const;
export type NewKind = (typeof NEW_KINDS)[number];
/** The roles that sign in to the web UI; integration accounts have no start page. */
export const PERSON_ROLES = ['admin', 'problem_manager', 'analyst', 'viewer'] as const;

const HOME_MODULE: Partial<Record<Home, Module>> = { incidents: 'incident', changes: 'change', requests: 'request' };
const NEW_MODULE: Partial<Record<NewKind, Module>> = { incident: 'incident', change: 'change', article: 'knowledge', request: 'request' };

const homeOn = (h: unknown): h is Home => (HOMES as readonly unknown[]).includes(h) && (!HOME_MODULE[h as Home] || moduleEnabled(HOME_MODULE[h as Home]!));
const newOn = (k: unknown): k is NewKind => (NEW_KINDS as readonly unknown[]).includes(k) && (!NEW_MODULE[k as NewKind] || moduleEnabled(NEW_MODULE[k as NewKind]!));

const choice = z.object({ home: z.enum(HOMES).nullable(), default_new: z.enum(NEW_KINDS).nullable() }).partial().strict();
export const roleDefaultsSchema = z.object(Object.fromEntries(PERSON_ROLES.map((r) => [r, choice.optional()])) as Record<(typeof PERSON_ROLES)[number], z.ZodOptional<typeof choice>>).strict();
type RoleDefaults = z.infer<typeof roleDefaultsSchema>;

export async function getRoleDefaults(): Promise<RoleDefaults> {
  const { rows } = await query("SELECT value FROM settings WHERE key = 'start_pages'");
  return rows[0]?.value ?? {};
}

/** Sets the defaults per role (administrators); a role or field set to null follows the built-in default again. */
export async function setRoleDefaults(user: User, input: RoleDefaults, reason?: string) {
  authorize(user, 'user.manage');
  await tx(async (db) => {
    const { rows } = await db.query("SELECT value FROM settings WHERE key = 'start_pages'");
    const before: RoleDefaults = rows[0]?.value ?? {};
    const after: RoleDefaults = { ...before };
    for (const [role, c] of Object.entries(input) as [keyof RoleDefaults, z.infer<typeof choice>][]) {
      const merged = Object.fromEntries(Object.entries({ ...before[role], ...c }).filter(([, v]) => v != null));
      if (Object.keys(merged).length) after[role] = merged; else delete after[role];
    }
    await db.query("INSERT INTO settings (key, value) VALUES ('start_pages', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [after]);
    const changes = Object.fromEntries(PERSON_ROLES.filter((r) => JSON.stringify(before[r] ?? {}) !== JSON.stringify(after[r] ?? {})).map((r) => [r, { from: before[r] ?? null, to: after[r] ?? null }]));
    if (Object.keys(changes).length) await audit(db, { entity_type: 'setting', entity_ref: 'start_pages', action: 'update', changes, reason });
  });
  return getRoleDefaults();
}

/** Where this person starts and what they create first: their own choice, else their role's default, else neutral. */
export async function startFor(user: Pick<User, 'role' | 'preferences'>, defaults?: RoleDefaults) {
  const role = (defaults ?? (await getRoleDefaults()))[user.role as keyof RoleDefaults] ?? {};
  const prefs = user.preferences ?? {};
  const home = [prefs.home, role.home].find(homeOn) ?? 'my_work';
  const defaultNew = [prefs.default_new, role.default_new, 'incident'].find(newOn) ?? 'problem';
  return { home, default_new: defaultNew };
}
