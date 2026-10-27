// Who may see which records (#53, ADR 0002). The rule itself lives in the database (row-level security,
// 119_visibility.sql); this module tells the database who is asking: the viewer string set on every statement.
import { z } from 'zod';
import type { User } from './auth.js';
import { audit } from './audit.js';
import { query, tx } from '../core/db.js';
import { contextStore, currentContext } from '../core/context.js';
import { badRequest, notFound } from '../core/errors.js';
import { managers, notify } from '../notifications/notifications.js';
import { authorize } from './policy.js';
import { refRegex, textKinds, textKindOfRef, typeForRef } from '../records/records.js';
import { addEntry } from '../records/activity.js';
import type { Role } from '../problems/workflow.js';

interface VisibilitySettings { team_scoped: Record<string, boolean>; restricted_categories: number[]; aiRestricted: boolean }
let state: VisibilitySettings = { team_scoped: {}, restricted_categories: [], aiRestricted: false };
let loadedAt = 0;

/** Reloads the visibility settings (on start, after a change, and at most 30 s old, like the module switches). */
export async function refreshVisibility() {
  const [{ rows: v }, { rows: ai }] = await Promise.all([
    query("SELECT value FROM settings WHERE key = 'visibility'"),
    query("SELECT value FROM settings WHERE key = 'ai_data'"),
  ]);
  state = {
    team_scoped: v[0]?.value?.team_scoped ?? {},
    restricted_categories: v[0]?.value?.restricted_categories ?? [],
    aiRestricted: ai[0]?.value?.restricted_records === true,
  };
  loadedAt = Date.now();
  return state;
}

const visibilitySettings = async () => (Date.now() - loadedAt > 30_000 ? refreshVisibility() : state);

/** Whether a practice's records are team-scoped now (records.ts kinds: 'incident', 'work_item'…). */
export const teamScoped = async (kind: string) => (await visibilitySettings()).team_scoped[kind] === true;

/**
 * The viewer string for a signed-in user: id, role, team ids (read per request, so removing someone from a team
 * takes effect on their next request), the practices that are team-scoped, and "noai" for agents when restricted
 * records may not go to the AI provider (or, with unrestrictedOnly, for anything that leaves Kernel).
 */
export async function viewerFor(user: { id: number; role: Role }, channel: string, options: { unrestrictedOnly?: boolean } = {}) {
  const s = await visibilitySettings();
  const { rows } = await query('SELECT array_agg(team_id ORDER BY team_id) AS teams FROM team_members WHERE user_id = $1', [user.id]);
  // Managers are never team-scoped, so their viewer carries no scoped practices (and their rows take the cheap path).
  const scoped = ['admin', 'manager'].includes(user.role) ? [] : Object.entries(s.team_scoped).filter(([, on]) => on).map(([k]) => k);
  // "noai" leaves every restricted record out; also used for what leaves Kernel by mail (scheduled reports, #54).
  const flags = options.unrestrictedOnly || (channel === 'mcp' && !s.aiRestricted) ? 'noai' : '';
  return `u:${user.id}:${user.role}:${(rows[0]?.teams ?? []).join(',')}:${scoped.join(',')}:${flags}`;
}

// ---- Restricting records, break-glass ----------------------------------------------------------------------------

// The kinds that can be restricted are the record types that hold people's text (records.ts: textKinds).

export const visibilitySchema = z.object({
  restricted: z.boolean(),
  teams: z.array(z.number().int()).max(50).default([]),
  reason: z.string().trim().max(1000).optional(),
});

/** Restrict a record to its assignee, creator and the named teams, or open it again. Needs a reason; audited. */
export async function setVisibility(user: User, ref: string, input: z.infer<typeof visibilitySchema>, reason: string) {
  authorize(user, 'record.restrict');
  typeForRef(ref);
  const t = textKindOfRef(ref);
  if (!t) throw badRequest('Only problems, incidents, changes, improvements, requests and work items can be restricted');
  const { type, table } = t;
  await tx(async (db) => {
    // The caller must see the record (row-level security), so no one restricts or opens what they cannot see.
    const { rows } = await db.query(`SELECT id, ref, restricted, restricted_teams FROM ${table} WHERE ref = $1 FOR UPDATE`, [ref.toUpperCase()]);
    const r = rows[0];
    if (!r) throw notFound(`${ref} not found`);
    if (input.teams.length) {
      const { rows: t } = await db.query('SELECT count(*)::int AS n FROM teams WHERE id = ANY($1)', [input.teams]);
      if (t[0].n !== new Set(input.teams).size) throw badRequest('Unknown team');
    }
    const teams = input.restricted ? [...new Set(input.teams)].sort((a, b) => a - b) : [];
    await db.query(`UPDATE ${table} SET restricted = $2, restricted_teams = $3 WHERE id = $1`, [r.id, input.restricted, teams]);
    await addEntry(db, type, r.id, {
      userId: user.id, kind: 'update', body: input.restricted ? `Restricted to its assignee, creator${teams.length ? ` and team${teams.length > 1 ? 's' : ''} ${teams.map((n) => `#${n}`).join(', ')}` : ''}` : 'Visible to everyone again',
      data: { restricted: { from: r.restricted, to: input.restricted }, teams },
    });
    await audit(db, { entity_type: type, entity_ref: r.ref, action: 'visibility', changes: { restricted: { from: r.restricted, to: input.restricted }, teams: { from: r.restricted_teams, to: teams } }, reason });
  });
  return { ref: ref.toUpperCase(), restricted: input.restricted, teams: input.restricted ? input.teams : [] };
}

/** An administrator opens a restricted record for an hour: reason, audit, and the people on the record are told. */
export async function breakGlass(user: User, ref: string, reason: string) {
  authorize(user, 'record.break_glass');
  return tx(async (db) => {
    const { rows } = await db.query('SELECT * FROM kernel_record_lookup($1)', [ref.toUpperCase()]);
    const r = rows[0];
    if (!r?.kind) throw notFound(`${ref} not found`);
    if (!r.is_restricted) throw badRequest(`${ref} is not restricted`);
    const { rows: g } = await db.query(
      "INSERT INTO visibility_breakglass (user_id, record_type, record_id, reason, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour') RETURNING expires_at",
      [user.id, r.kind, r.id, reason],
    );
    await audit(db, { entity_type: r.kind, entity_ref: ref.toUpperCase(), action: 'break_glass', reason });
    // The people on the record hear about it: assignee, creator, and the leads of its team and of the allowed teams.
    const { rows: leads } = await db.query("SELECT user_id FROM team_members WHERE role = 'lead' AND (team_id = $1 OR team_id = ANY($2))", [r.team_id, r.allowed_teams ?? []]);
    const told = [r.assignee_id, r.created_by, ...leads.map((l) => l.user_id)].filter(Boolean);
    await notify(db, {
      users: told.length ? told : await managers(db, [user.id]), event: 'watched_update', ref: ref.toUpperCase(), title: 'Restricted record opened',
      summary: `${user.display_name} opened it with break-glass for an hour.`, path: '', dedupe: `breakglass:${ref}:${Date.now()}`, actorId: user.id,
    });
    return { ref: ref.toUpperCase(), type: r.kind, expires_at: g[0].expires_at };
  });
}

export async function activeBreakGlass() {
  const { rows } = await query(
    `SELECT b.record_type, b.record_id, u.display_name AS user_name, b.reason, b.created_at, b.expires_at
     FROM visibility_breakglass b JOIN users u ON u.id = b.user_id WHERE b.expires_at > now() ORDER BY b.created_at DESC`,
  );
  return rows;
}

/** For managers: some records exist that their numbers leave out (a yes/no, never a count). */
export async function hiddenRecordsExist() {
  return (await query('SELECT kernel_hidden_records_exist() AS hidden')).rows[0].hidden as boolean;
}

/** New records in these categories start restricted (e.g. security incidents). */
export async function restrictedByCategory(categoryId: number | null | undefined) {
  if (!categoryId) return false;
  return (await visibilitySettings()).restricted_categories.includes(categoryId);
}

export async function saveVisibilitySettings(actor: User, value: { team_scoped: Record<string, boolean>; restricted_categories: number[] }, reason: string) {
  await query("INSERT INTO settings (key, value) VALUES ('visibility', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [JSON.stringify(value)]);
  await audit(null, { entity_type: 'setting', entity_ref: 'visibility', action: 'update', changes: value, reason });
  void actor;
  const s = await refreshVisibility();
  return { team_scoped: s.team_scoped, restricted_categories: s.restricted_categories };
}

/** A record derived from a restricted one (a problem from an incident, a change from a problem) is restricted too. */

/**
 * Runs `fn` with every row visible (row-level security off for this call). Only for reads that must count rows the
 * caller cannot see (a backlog's ranks) or show that something is there without showing it (the trace, #167), after
 * the caller's own access was checked. What comes out must be filtered by the caller's visibility again.
 */
export const seeingAll = <T>(fn: () => Promise<T>) => contextStore.run({ ...currentContext(), viewer: 'system' }, fn);

/** A Kernel ref the caller may not see answers exactly like one that does not exist (no existence oracle). */
export async function assertVisibleRef(ref: string) {
  const { rows } = await query('SELECT (SELECT kind FROM kernel_record_lookup($1)) AS kind, kernel_ref_hidden($1) AS hidden', [ref.toUpperCase()]);
  if (rows[0].hidden || (refRegex(textKinds()).test(ref) && !rows[0].kind)) throw notFound(`${ref.toUpperCase()} not found`);
  if (/^PIR\d{6}$/i.test(ref) && !(await query('SELECT 1 FROM incident_reviews WHERE ref = $1', [ref.toUpperCase()])).rows[0]) throw notFound(`${ref.toUpperCase()} not found`);
}
