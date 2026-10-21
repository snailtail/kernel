// Teams and assignment groups (#42): who work lands with. A user can be in several teams; a lead manages their own
// team's members. Records point at team ids, and histories show the current name, so renaming never rewrites them.
import { z } from 'zod';
import type { User } from './auth.js';
import { audit } from './audit.js';
import { query, tx } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { notify } from './notifications.js';
import { authorize, can } from './policy.js';
import type { Db } from './problems.js';

/** Members who can be given work: active, and in a role that can update records (not viewers or integrations). */
const CAN_WORK = "u.active AND u.role NOT IN ('viewer', 'integration')";

export const teamSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().max(2000).default(''),
  email: z.union([z.literal(''), z.string().trim().email().max(200)]).default(''),
  auto_assign: z.enum(['none', 'round_robin']).default('none'),
  active: z.boolean().default(true),
  cis: z.array(z.string().max(30)).max(500).optional(),
});
export const membersSchema = z.object({
  members: z.array(z.object({ user_id: z.number().int(), role: z.enum(['lead', 'member']).default('member') })).max(500),
});

export async function listTeams(user: User) {
  authorize(user, 'team.read');
  const { rows } = await query(
    `SELECT t.id, t.name, t.description, t.email, t.auto_assign, t.active,
            coalesce((SELECT json_agg(json_build_object('user_id', u.id, 'name', u.display_name, 'role', m.role) ORDER BY m.role, u.display_name)
                      FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = t.id AND u.active), '[]') AS members,
            coalesce((SELECT json_agg(json_build_object('ref', c.ref, 'name', c.name) ORDER BY c.name) FROM team_cis x JOIN configuration_items c ON c.id = x.ci_id WHERE x.team_id = t.id), '[]') AS supports,
            (SELECT count(*)::int FROM incidents i WHERE i.team_id = t.id AND i.status NOT IN ('resolved', 'closed')) AS open_incidents,
            (SELECT count(*)::int FROM incidents i WHERE i.team_id = t.id AND i.assignee_id IS NULL AND i.status NOT IN ('resolved', 'closed')) AS unassigned,
            EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.user_id = $1) AS mine
     FROM teams t ORDER BY t.active DESC, lower(t.name)`,
    [user.id],
  );
  return rows;
}

async function setSupported(db: Db, teamId: number, refs: string[]) {
  const wanted = [...new Set(refs.map((r) => r.toUpperCase()))];
  const { rows } = await db.query('SELECT id FROM configuration_items WHERE ref = ANY($1)', [wanted]);
  if (rows.length !== wanted.length) throw badRequest('Every entry in cis must be an existing CI or service ref');
  await db.query('DELETE FROM team_cis WHERE team_id = $1', [teamId]);
  await db.query('INSERT INTO team_cis (team_id, ci_id) SELECT $1, unnest($2::int[])', [teamId, rows.map((r) => r.id)]);
}

export async function saveTeam(user: User, id: number | null, input: z.infer<typeof teamSchema>) {
  authorize(user, 'team.manage');
  try {
    const teamId = await tx(async (db) => {
      const { rows: before } = id ? await db.query('SELECT * FROM teams WHERE id = $1 FOR UPDATE', [id]) : { rows: [] as any[] };
      if (id && !before[0]) throw notFound('Team not found');
      if (id && before[0].active && !input.active) await refuseOpenWork(db, id, 'deactivated');
      const { rows } = id
        ? await db.query('UPDATE teams SET name = $2, description = $3, email = $4, auto_assign = $5, active = $6 WHERE id = $1 RETURNING id', [id, input.name, input.description, input.email, input.auto_assign, input.active])
        : await db.query('INSERT INTO teams (name, description, email, auto_assign, active) VALUES ($1, $2, $3, $4, $5) RETURNING id', [input.name, input.description, input.email, input.auto_assign, input.active]);
      if (input.cis) await setSupported(db, rows[0].id, input.cis);
      const { cis, ...fields } = input;
      await audit(db, { entity_type: 'team', entity_ref: `#${rows[0].id}`, action: id ? 'update' : 'create', changes: { ...fields, supports: cis?.length } });
      return rows[0].id as number;
    });
    return (await listTeams(user)).find((t) => t.id === teamId);
  } catch (err: any) {
    if (err.code === '23505') throw conflict('A team with that name already exists');
    throw err;
  }
}

async function refuseOpenWork(db: Db, teamId: number, what: string) {
  const { rows } = await db.query(
    `SELECT (SELECT count(*) FROM incidents WHERE team_id = $1 AND status NOT IN ('resolved', 'closed'))
          + (SELECT count(*) FROM problems WHERE team_id = $1 AND status NOT IN ('resolved', 'closed'))
          + (SELECT count(*) FROM changes WHERE team_id = $1 AND status NOT IN ('closed', 'rejected', 'cancelled'))
          + (SELECT count(*) FROM request_tasks WHERE team_id = $1 AND status IN ('open', 'pending')) AS n`,
    [teamId],
  );
  if (Number(rows[0].n) > 0) throw conflict(`The team has ${rows[0].n} open records; reassign them before it is ${what}`);
}

export async function deleteTeam(user: User, id: number) {
  authorize(user, 'team.manage');
  await tx(async (db) => {
    await refuseOpenWork(db, id, 'removed');
    const { rowCount } = await db.query('DELETE FROM teams WHERE id = $1', [id]);
    if (!rowCount) throw notFound('Team not found');
    await audit(db, { entity_type: 'team', entity_ref: `#${id}`, action: 'delete' });
  });
  return { ok: true };
}

/** Members: administrators for any team, a lead for their own team. */
export async function setMembers(user: User, id: number, input: z.infer<typeof membersSchema>) {
  authorize(user, 'team.read');
  await tx(async (db) => {
    const { rows } = await db.query('SELECT id FROM teams WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw notFound('Team not found');
    const lead = await db.query("SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2 AND role = 'lead'", [id, user.id]);
    if (!can(user.role, 'team.manage') && !lead.rows[0]) throw forbidden('Only an administrator or the team lead can change the members');
    const ids = input.members.map((m) => m.user_id);
    const { rows: valid } = await db.query("SELECT id FROM users WHERE id = ANY($1) AND active AND role NOT IN ('viewer', 'integration')", [ids]);
    if (valid.length !== new Set(ids).size) throw badRequest('Members must be active users who can work on records');
    // A lead cannot remove the last lead (themselves included) unless an administrator does it.
    if (!can(user.role, 'team.manage') && !input.members.some((m) => m.role === 'lead')) throw badRequest('Keep at least one lead in the team');
    const { rows: before } = await db.query('SELECT user_id, role FROM team_members WHERE team_id = $1', [id]);
    await db.query('DELETE FROM team_members WHERE team_id = $1', [id]);
    for (const m of input.members) await db.query('INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, m.user_id, m.role]);
    const key = (m: { user_id: number; role: string }) => `${m.user_id}:${m.role}`;
    const was = new Set(before.map(key));
    const now = new Set(input.members.map(key));
    await audit(db, {
      entity_type: 'team', entity_ref: `#${id}`, action: 'members',
      changes: { added: [...now].filter((k) => !was.has(k)), removed: [...was].filter((k) => !now.has(k)) },
    });
  });
  return (await listTeams(user)).find((t) => t.id === id);
}

/** A team's queue: unassigned, assigned to me, and at risk of breaching. */
export async function teamQueue(user: User, id: number) {
  authorize(user, 'team.read');
  authorize(user, 'incident.read');
  const { rows: team } = await query('SELECT id, name FROM teams WHERE id = $1', [id]);
  if (!team[0]) throw notFound('Team not found');
  const { rows } = await query(
    `SELECT i.ref, i.title, i.status, i.priority, i.assignee_id, u.display_name AS assignee, i.created_at, i.resolution_due_at,
            (i.resolution_breached_at IS NOT NULL OR (i.resolution_due_at IS NOT NULL AND i.resolution_due_at < now() + interval '2 hours')) AS at_risk
     FROM incidents i LEFT JOIN users u ON u.id = i.assignee_id
     WHERE i.team_id = $1 AND i.status NOT IN ('resolved', 'closed')
     ORDER BY i.priority, i.created_at`,
    [id],
  );
  return {
    team: team[0],
    unassigned: rows.filter((r) => !r.assignee_id),
    mine: rows.filter((r) => r.assignee_id === user.id),
    at_risk: rows.filter((r) => r.at_risk),
    all: rows,
    // Service request tasks (#44) wait in the same queue when the module is on.
    request_tasks: can(user.role, 'request.read') ? await (await import('./requests.js')).teamRequestTasks([id]) : [],
  };
}

/** The team that supports a CI, directly or through the service it belongs to. */
export async function defaultTeamFor(db: Db, ciIds: number[]) {
  if (!ciIds.length) return null;
  const { rows } = await db.query(
    `SELECT t.id FROM team_cis x JOIN teams t ON t.id = x.team_id AND t.active
     WHERE x.ci_id = ANY($1)
        OR x.ci_id IN (SELECT r.to_ci FROM ci_relationships r WHERE r.from_ci = ANY($1) AND r.type = 'member_of')
     ORDER BY (x.ci_id = ANY($1)) DESC, t.id LIMIT 1`,
    [ciIds],
  );
  return (rows[0]?.id as number | undefined) ?? null;
}

/** Round robin: the member with the least open work, then the one who got work longest ago. */
export async function pickAssignee(db: Db, teamId: number) {
  const { rows: team } = await db.query('SELECT auto_assign FROM teams WHERE id = $1', [teamId]);
  if (team[0]?.auto_assign !== 'round_robin') return null;
  const { rows } = await db.query(
    `SELECT u.id FROM team_members m JOIN users u ON u.id = m.user_id AND ${CAN_WORK}
     WHERE m.team_id = $1
     ORDER BY (SELECT count(*) FROM incidents i WHERE i.assignee_id = u.id AND i.status NOT IN ('resolved', 'closed')),
              (SELECT max(i.created_at) FROM incidents i WHERE i.assignee_id = u.id) NULLS FIRST, u.id
     LIMIT 1`,
    [teamId],
  );
  return (rows[0]?.id as number | undefined) ?? null;
}

/** An assignee must belong to the record's team (when the team has members). */
export async function checkAssigneeInTeam(db: Db, teamId: number | null | undefined, assigneeId: number | null | undefined) {
  if (!teamId || !assigneeId) return;
  const { rows } = await db.query(
    `SELECT count(*)::int AS members, bool_or(m.user_id = $2 AND ${CAN_WORK}) AS member
     FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = $1`,
    [teamId, assigneeId],
  );
  if (rows[0].members > 0 && !rows[0].member) throw badRequest('The assignee is not a member of the assigned team who can work on records. Choose a member, or reassign the team first.');
}

export async function validTeam(db: Db, teamId: number | null | undefined) {
  if (!teamId) return;
  const { rows } = await db.query('SELECT 1 FROM teams WHERE id = $1 AND active', [teamId]);
  if (!rows[0]) throw badRequest('Unknown or inactive team');
}

export async function teamMembers(db: Db, teamId: number, role?: 'lead') {
  const { rows } = await db.query(`SELECT m.user_id FROM team_members m JOIN users u ON u.id = m.user_id AND ${CAN_WORK} WHERE m.team_id = $1${role ? " AND m.role = 'lead'" : ''}`, [teamId]);
  return rows.map((r) => r.user_id as number);
}

/** New work in a team's queue without a person: the members hear about it (each by their own settings). */
export async function notifyTeamQueue(db: Db, teamId: number, rec: { ref: string; title: string; path: string }, actorId: number | null) {
  const users = await teamMembers(db, teamId);
  if (!users.length) return;
  const { rows } = await db.query('SELECT name FROM teams WHERE id = $1', [teamId]);
  await notify(db, { users, event: 'team_queue', ref: rec.ref, title: rec.title, summary: `New in the ${rows[0]?.name ?? 'team'} queue.`, path: rec.path, dedupe: `team_queue:${rec.ref}:${teamId}`, actorId });
}

export async function myTeams(userId: number) {
  const { rows } = await query(
    `SELECT t.id, t.name, m.role,
            (SELECT count(*)::int FROM incidents i WHERE i.team_id = t.id AND i.assignee_id IS NULL AND i.status NOT IN ('resolved', 'closed')) AS unassigned
     FROM team_members m JOIN teams t ON t.id = m.team_id AND t.active WHERE m.user_id = $1 ORDER BY t.name`,
    [userId],
  );
  return rows;
}

/** Histories store "team #3"; the current name is filled in when shown, so renaming a team never rewrites them. */
export async function nameTeams<T extends { body: string }>(rows: T[]): Promise<T[]> {
  const ids = [...new Set(rows.flatMap((r) => [...r.body.matchAll(/team #(\d+)/g)].map((m) => Number(m[1]))))];
  if (!ids.length) return rows;
  const { rows: found } = await query('SELECT id, name FROM teams WHERE id = ANY($1)', [ids]);
  const names = new Map(found.map((t) => [t.id, t.name as string]));
  return rows.map((r) => ({ ...r, body: r.body.replace(/team #(\d+)/g, (m, id) => (names.has(Number(id)) ? `team ${names.get(Number(id))}` : m)) }));
}
