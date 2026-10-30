// Mirrored backlogs (#168, epic #164): a team keeps its backlog in Azure DevOps, GitHub or GitLab and Kernel mirrors
// it, so the team's bugs and stories can be linked to problems, incidents and changes (#167) like native ones. The
// source owns the title, type, status, iteration, points, assignee and parent (read-only here, see work-items.ts); the
// description is not copied, the item links to the source instead (#33: pointers, not copies). The source's webhook
// (#32) keeps items current, and a periodic reconciliation catches what a delivery missed. An item deleted in the
// source is marked removed, never deleted. Back to the source goes only a comment that an item was linked to a Kernel
// record, once per link, through an outbox; never a status change.
import { z } from 'zod';
import type { User } from '../security/auth.js';
import { audit } from '../security/audit.js';
import { asIntegration } from '../core/context.js';
import { type Db, query, tx } from '../core/db.js';
import { backoffMinutes, GiveUp, processOutbox, SkipDelivery } from '../core/outbox.js';
import { badRequest, conflict, notFound } from '../core/errors.js';
import { logger } from '../core/log.js';
import { moduleEnabled } from '../core/modules.js';
import { authorize, can } from '../security/policy.js';
import { decryptSecret } from '../security/secrets.js';
import { logActivity } from '../records/activity.js';
import { validTeam } from '../people/teams.js';
import { azureDevOps, azureMirror } from '../integrations/dev-azure.js';
import { github, githubMirror } from '../integrations/dev-github.js';
import { gitlab, gitlabMirror } from '../integrations/dev-gitlab.js';
import { callJsonVia, PLATFORM_LABELS, type Adapter, type MirroredItem, type Mirroring, type MirrorPlace, type Platform } from '../integrations/dev-platform.js';
import { bottomRank, leaveSprint, lockBacklog, WORK_ITEM_PARENT_TYPES, WORK_ITEM_STATUSES, WORK_ITEM_TYPES, type WorkItemStatus, type WorkItemType } from './work-items.js';

const PLATFORMS: Record<Platform, { adapter: Adapter; mirror: Mirroring }> = {
  azure_devops: { adapter: azureDevOps, mirror: azureMirror }, github: { adapter: github, mirror: githubMirror }, gitlab: { adapter: gitlab, mirror: gitlabMirror },
};
const sourceLabel = (platform: string) => PLATFORM_LABELS[platform as Platform] ?? platform;

export const mirrorSchema = z.object({
  /** The dev source (#32) whose token, network settings and webhook the mirror uses. */
  source_id: z.number().int(),
  /** One of the source's repositories: organisation/project on Azure DevOps, owner/repo on GitHub, group/project on GitLab. */
  scope: z.string().trim().min(3).max(200),
  /** An Azure DevOps area path (the items under it), or a GitHub or GitLab label (the issues with it). Empty is all of the scope. */
  area: z.string().trim().max(400).default(''),
  /** Adjustments to the default mapping, by the source's type and state names; a type mapped to "" is not mirrored. */
  type_map: z.record(z.string().trim().min(1).max(100), z.enum([...WORK_ITEM_TYPES, ''])).default({}),
  status_map: z.record(z.string().trim().min(1).max(100), z.enum(WORK_ITEM_STATUSES)).default({}),
  schedule_minutes: z.number().int().min(5).max(1440).default(60),
  enabled: z.boolean().default(true),
  /** A comment on the item in the source when it is linked to a Kernel record ("Linked to PRB000123 in Kernel"). */
  comment_links: z.boolean().default(true),
});

interface MirrorRow {
  id: number;
  team_id: number;
  source_id: number;
  scope: string;
  area: string;
  type_map: Record<string, string>;
  status_map: Record<string, string>;
  comment_links: boolean;
  platform: Platform;
  base_url: string;
}
const MIRROR = 'SELECT m.*, s.platform, s.base_url FROM work_item_mirrors m JOIN dev_sources s ON s.id = m.source_id';

const place = (m: MirrorRow): MirrorPlace => ({ base: m.base_url, scope: m.scope, area: m.area });
const lower = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
/** The source's name through the mirror's adjustments, then the platform's defaults; undefined when neither knows it. */
const mapped = (own: Record<string, string>, defaults: Record<string, string>, name: string) => {
  const k = name.toLowerCase();
  return k in lower(own) ? lower(own)[k] : defaults[k];
};
/** Story points on Kernel's scale: the next step up, 13 at most; nothing for none or zero. */
const SCALE = [1, 2, 3, 5, 8, 13];
const pointsOf = (p: number | null) => (p === null || p <= 0 ? null : (SCALE.find((s) => s >= p) ?? 13));
/** The last segment of an iteration path ("Shop\\Sprint 12" → "Sprint 12"): the name of the team's sprint. */
const sprintName = (iteration: string) => iteration.split('\\').at(-1)?.trim() ?? '';
const LEVEL: Record<string, number> = { epic: 0, story: 1, bug: 1, task: 2 };

// ---- Settings -----------------------------------------------------------------------------------

export async function getMirror(user: User, teamId: number) {
  authorize(user, 'work.read');
  const { rows: team } = await query('SELECT id, name FROM teams WHERE id = $1', [teamId]);
  if (!team[0]) throw notFound('Team not found');
  const { rows } = await query(
    `SELECT m.id, m.source_id, s.name AS source, s.platform, m.scope, m.area, m.type_map, m.status_map, m.schedule_minutes, m.enabled, m.comment_links, m.last_run, m.next_run_at, m.created_at,
            (SELECT count(*)::int FROM work_items w WHERE w.mirror_id = m.id) AS items
     FROM work_item_mirrors m JOIN dev_sources s ON s.id = m.source_id WHERE m.team_id = $1`,
    [teamId],
  );
  const m = rows[0];
  // What each platform calls a mirror's area, and its default mapping: for the settings, before and after a mirror exists.
  const platforms = Object.fromEntries(Object.entries(PLATFORMS).map(([k, p]) => [k, { label: p.adapter.label, scope_example: p.adapter.scopeExample, area_name: p.mirror.areaName, default_types: p.mirror.types, default_statuses: p.mirror.states }]));
  const may_manage = can(user.role, 'work.manage');
  if (!m) return { team_id: teamId, team: team[0].name, mirrored: false as const, platforms, may_manage };
  const p = PLATFORMS[m.platform as Platform];
  return { team_id: teamId, team: team[0].name, mirrored: true as const, ...m, source_label: p.adapter.label, area_name: p.mirror.areaName, default_types: p.mirror.types, default_statuses: p.mirror.states, platforms, may_manage };
}

export async function saveMirror(user: User, teamId: number, input: z.infer<typeof mirrorSchema>) {
  authorize(user, 'work.manage');
  const { rows: src } = await query('SELECT id, name, platform, repositories, enabled FROM dev_sources WHERE id = $1', [input.source_id]);
  const source = src[0];
  if (!source) throw badRequest('Dev source not found');
  const p = PLATFORMS[source.platform as Platform];
  if (!p.adapter.inScope(source.repositories, input.scope)) throw badRequest(`${input.scope} is not one of ${source.name}'s ${p.adapter.scopeExample} entries`);
  const before = await tx(async (db) => {
    await validTeam(db, teamId);
    const { rows: old } = await db.query('SELECT source_id, scope, area, type_map, status_map, enabled, comment_links FROM work_item_mirrors WHERE team_id = $1', [teamId]);
    await db.query(
      `INSERT INTO work_item_mirrors (team_id, source_id, scope, area, type_map, status_map, schedule_minutes, enabled, comment_links, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (team_id) DO UPDATE SET source_id = $2, scope = $3, area = $4, type_map = $5, status_map = $6, schedule_minutes = $7, enabled = $8, comment_links = $9, next_run_at = now()`,
      [teamId, input.source_id, input.scope, input.area, JSON.stringify(input.type_map), JSON.stringify(input.status_map), input.schedule_minutes, input.enabled, input.comment_links, user.id],
    );
    return old[0] ?? null;
  });
  await audit(null, { entity_type: 'team', entity_ref: `#${teamId}`, action: before ? 'mirror_update' : 'mirror_create', changes: { from: before, to: { ...input, source: source.name } } });
  return getMirror(user, teamId);
}

/** The team's backlog is native again: its mirrored items stay, with their link to the source, and become editable. */
export async function deleteMirror(user: User, teamId: number) {
  authorize(user, 'work.manage');
  const { rows } = await query('DELETE FROM work_item_mirrors WHERE team_id = $1 RETURNING source_id, scope, area', [teamId]);
  if (!rows[0]) throw notFound('The team has no mirror');
  await audit(null, { entity_type: 'team', entity_ref: `#${teamId}`, action: 'mirror_delete', changes: rows[0] });
  return getMirror(user, teamId);
}

export async function syncMirror(user: User, teamId: number) {
  authorize(user, 'work.manage');
  const { rows } = await query('SELECT id FROM work_item_mirrors WHERE team_id = $1', [teamId]);
  if (!rows[0]) throw notFound('The team has no mirror');
  return reconcileMirror(rows[0].id, 'manual');
}

// ---- One item ---------------------------------------------------------------------------------

/**
 * The mirror an item belongs to: of those on its source and scope that cover where it is, the most specific one (the
 * longest area), so a team mirroring a sub-area keeps its items when another mirrors the area above it.
 */
function ownerOf(mirrors: MirrorRow[], item: MirroredItem) {
  if (item.confidential) return undefined;
  const covering = mirrors.filter((m) => PLATFORMS[m.platform].mirror.covers(place(m), item.area));
  return covering.sort((a, b) => b.area.length - a.area.length)[0];
}

type Outcome = 'created' | 'updated' | 'unchanged' | 'skipped';

/**
 * Creates or updates the item from the source, in the mirror's team. The source's status is taken as it is (the
 * transitions Kernel enforces are for native items); a state the mapping does not know leaves the status as it was.
 */
async function apply(db: Db, m: MirrorRow, item: MirroredItem): Promise<Outcome> {
  const p = PLATFORMS[m.platform];
  const type = mapped(m.type_map, p.mirror.types, item.type) as WorkItemType | '' | undefined;
  if (!type) return 'skipped';
  const label = p.adapter.label;
  await lockBacklog(db, m.team_id);
  const { rows: found } = await db.query('SELECT * FROM work_items WHERE source = $1 AND external_id = $2 FOR UPDATE', [m.platform, item.external_id]);
  const w = found[0];
  const status = (mapped(m.status_map, p.mirror.states, item.state) as WorkItemStatus | undefined) ?? w?.status ?? 'new';
  const { rows: parents } = item.parent_external_id
    ? await db.query('SELECT id, type FROM work_items WHERE source = $1 AND external_id = $2', [m.platform, item.parent_external_id])
    : { rows: [] };
  const parentId = parents[0] && WORK_ITEM_PARENT_TYPES[type].includes(parents[0].type) ? (parents[0].id as number) : null;
  // The assignee by e-mail: an active user who can work on items, and a member of the team when it has members.
  const { rows: people } = item.assignee_email
    ? await db.query(
        `SELECT u.id FROM users u WHERE lower(u.email) = $1 AND u.active AND u.role NOT IN ('viewer', 'integration')
           AND (NOT EXISTS (SELECT 1 FROM team_members t WHERE t.team_id = $2) OR EXISTS (SELECT 1 FROM team_members t WHERE t.team_id = $2 AND t.user_id = u.id))`,
        [item.assignee_email, m.team_id],
      )
    : { rows: [] };
  const next = {
    type, title: (item.title.trim() || '(untitled)').slice(0, 300), status, points: pointsOf(item.points), team_id: m.team_id, assignee_id: people.length === 1 ? (people[0].id as number) : null,
    parent_id: parentId, external_url: /^https:\/\//i.test(item.url) ? item.url : '', external_iteration: item.iteration === undefined ? (w?.external_iteration ?? '') : item.iteration.slice(0, 500), mirror_id: m.id,
  };
  const reason = status === 'removed' ? `Removed in ${label}` : '';
  let id: number;
  let outcome: Outcome;
  if (!w) {
    const { rows } = await db.query(
      `INSERT INTO work_items (type, title, status, rank, points, team_id, assignee_id, parent_id, remove_reason, source, external_id, external_url, external_iteration, mirror_id,
                               started_at, done_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               CASE WHEN $3 IN ('in_progress', 'in_review', 'done') THEN now() END, CASE WHEN $3 = 'done' THEN now() END) RETURNING id`,
      [next.type, next.title, next.status, await bottomRank(db, m.team_id), next.points, next.team_id, next.assignee_id, next.parent_id, reason, m.platform, item.external_id, next.external_url, next.external_iteration, m.id],
    );
    id = rows[0].id;
    await logActivity(db, 'work_item', id, null, 'created', `Mirrored from ${label}`, { type, source: m.platform, external_id: item.external_id, url: next.external_url });
    outcome = 'created';
  } else {
    id = w.id;
    const changed = Object.entries(next).filter(([k, v]) => (w[k] ?? null) !== v);
    if (!changed.length) return 'unchanged';
    const set = changed.map(([k]) => k);
    const values = changed.map(([, v]) => v);
    if (set.includes('team_id')) {
      // Another team's mirror took it over: it goes to the bottom of that backlog, and leaves the old team's sprint.
      await leaveSprint(db, w.id, w.sprint_id);
      set.push('rank', 'sprint_id');
      values.push(await bottomRank(db, m.team_id), null);
    }
    if (set.includes('status')) {
      set.push('remove_reason', 'started_at', 'done_at');
      values.push(status === 'removed' ? reason : w.remove_reason, ['in_progress', 'in_review', 'done'].includes(status) ? (w.started_at ?? new Date()) : w.started_at, status === 'done' ? new Date() : null);
    }
    await db.query(`UPDATE work_items SET ${set.map((k, n) => `${k} = $${n + 2}`).join(', ')} WHERE id = $1`, [w.id, ...values]);
    const statusChange = changed.find(([k]) => k === 'status');
    if (statusChange) await logActivity(db, 'work_item', id, null, 'status', `${statusChange[1] === 'removed' ? reason : `${label}: ${String(statusChange[1]).replace('_', ' ')}`}`, { status: { from: w.status, to: status }, source: m.platform });
    const rest = changed.filter(([k]) => !['status', 'mirror_id', 'external_url'].includes(k));
    if (rest.length) {
      const data = Object.fromEntries(rest.map(([k, v]) => [k, { from: w[k] ?? null, to: v }]));
      await logActivity(db, 'work_item', id, null, 'update', `Updated in ${label}: ${rest.map(([k]) => k.replace('_id', '').replace('external_', '').replace('_', ' ')).join(', ')}`, data);
    }
    outcome = 'updated';
  }
  await placeInSprint(db, id, m, label);
  return outcome;
}

/**
 * The source's iteration puts the item in the team's planned or active sprint of that name, and takes it out of one
 * it no longer names. An epic, and a removed item, is in no sprint.
 */
async function placeInSprint(db: Db, id: number, m: MirrorRow, label: string) {
  const { rows } = await db.query('SELECT id, type, status, sprint_id, external_iteration FROM work_items WHERE id = $1', [id]);
  const w = rows[0];
  const { rows: sprints } = await db.query("SELECT id, name, status FROM sprints WHERE team_id = $1 AND status IN ('planned', 'active') AND lower(name) = lower($2) ORDER BY id LIMIT 1", [m.team_id, sprintName(w.external_iteration)]);
  const target = w.type !== 'epic' && w.status !== 'removed' && w.external_iteration ? sprints[0] : undefined;
  if (w.sprint_id === (target?.id ?? null)) return;
  if (w.sprint_id && (await leaveSprint(db, w.id, w.sprint_id))) await logActivity(db, 'work_item', w.id, null, 'sprint', `Left its sprint: the iteration changed in ${label}`, { action: 'remove', sprint_id: w.sprint_id });
  // A done item stays where it was finished; it is not planned into a new sprint.
  if (!target || w.status === 'done') return;
  const { rows: still } = await db.query("SELECT 1 FROM work_items wi JOIN sprints s ON s.id = wi.sprint_id WHERE wi.id = $1 AND s.status <> 'completed'", [w.id]);
  if (still[0]) return;
  await db.query('INSERT INTO sprint_items (sprint_id, work_item_id, unplanned) VALUES ($1, $2, $3)', [target.id, w.id, target.status === 'active']);
  await db.query('UPDATE work_items SET sprint_id = $2 WHERE id = $1', [w.id, target.id]);
  await logActivity(db, 'work_item', w.id, null, 'sprint', `In ${target.name}: its iteration in ${label}`, { sprint: { id: target.id, name: target.name }, action: 'add', unplanned: target.status === 'active' });
}

/** Marks a mirrored item removed with the reason, unless it already is. Never deleted: its links and history stay. */
async function markRemoved(db: Db, id: number, reason: string) {
  const { rows } = await db.query("UPDATE work_items SET status = 'removed', remove_reason = $2, done_at = NULL WHERE id = $1 AND status <> 'removed' RETURNING sprint_id", [id, reason]);
  if (!rows[0]) return false;
  await leaveSprint(db, id, rows[0].sprint_id);
  await logActivity(db, 'work_item', id, null, 'status', reason, { status: { to: 'removed' }, reason });
  return true;
}

// ---- From a webhook delivery ------------------------------------------------------------------

/**
 * A delivery about a work item (dev.ts calls this inside the delivery's transaction): mirrored when a team mirrors
 * where it is; marked removed when it was deleted, or moved out of every mirror that had it.
 */
export async function mirrorDelivered(db: Db, sourceId: number, scope: string, item: MirroredItem | { external_id: string; deleted: true }) {
  if (!moduleEnabled('development')) return;
  const { rows: mirrors } = await db.query<MirrorRow>(`${MIRROR} WHERE m.source_id = $1 AND lower(m.scope) = lower($2) AND m.enabled AND s.enabled`, [sourceId, scope]);
  if (!mirrors.length) return;
  const platform = mirrors[0].platform;
  const label = sourceLabel(platform);
  const { rows: had } = await db.query('SELECT id FROM work_items WHERE source = $1 AND external_id = $2 AND mirror_id = ANY($3)', [platform, item.external_id, mirrors.map((m) => m.id)]);
  if ('deleted' in item) {
    if (had[0]) await markRemoved(db, had[0].id, `Deleted in ${label}`);
    return;
  }
  const owner = ownerOf(mirrors, item);
  if (owner) await apply(db, owner, item);
  else if (had[0]) await markRemoved(db, had[0].id, goneReason(item, label));
}

/** Why an item the source still has left the mirror. */
const goneReason = (item: MirroredItem, label: string) => (item.confidential ? `Made confidential in ${label}` : `Moved out of the mirrored area in ${label}`);

// ---- Reconciliation ----------------------------------------------------------------------------

/** Below this many items, a list that shrank a lot is still believed (a small backlog may really have been emptied). */
const SHRINK_MIN = 10;
const SHRINK_MAX_PERCENT = 50;

/**
 * Reads the mirror's whole place in the source and brings the team's items in line: new and changed ones are
 * applied, ones no longer listed are looked up and marked removed (deleted, or moved out). Idempotent. A list that
 * failed never removes anything, and one that shrank by more than half is not trusted for removals. A lease on the
 * mirror keeps runs from overlapping, also across replicas.
 */
async function reconcileMirror(id: number, trigger: 'schedule' | 'manual') {
  const { rows } = await query(
    `UPDATE work_item_mirrors SET running_until = now() + interval '30 minutes', next_run_at = now() + schedule_minutes * interval '1 minute'
     WHERE id = $1 AND (running_until IS NULL OR running_until < now()) AND ($2 = 'manual' OR (enabled AND next_run_at <= now())) RETURNING running_until::text AS lease`,
    [id, trigger],
  );
  if (!rows[0]) throw conflict(trigger === 'manual' ? 'The mirror is already syncing' : 'The mirror is syncing or no longer due');
  const lease = rows[0].lease as string;
  const { rows: ms } = await query<MirrorRow & { source_name: string; api_token: string | null; private_allow: string[]; ca_pem: string | null; source_enabled: boolean }>(
    'SELECT m.*, s.platform, s.base_url, s.name AS source_name, s.api_token, s.private_allow, s.ca_pem, s.enabled AS source_enabled FROM work_item_mirrors m JOIN dev_sources s ON s.id = m.source_id WHERE m.id = $1',
    [id],
  );
  const m = ms[0];
  const label = sourceLabel(m.platform);
  const counts = { created: 0, updated: 0, unchanged: 0, skipped: 0, removed: 0 };
  const finish = (status: string, message: string) =>
    query('UPDATE work_item_mirrors SET last_run = $2, running_until = NULL WHERE id = $1 AND running_until = $3::timestamptz', [id, JSON.stringify({ status, counts, message: message.slice(0, 1000), at: new Date().toISOString(), trigger }), lease]);
  if (!m.source_enabled) {
    const message = `${m.source_name} is disabled`;
    await finish('failed', message);
    return { status: 'failed', counts, message };
  }
  return asIntegration({ name: m.source_name, channel: m.platform, requestId: `mirror:${id}` }, async () => {
    try {
      const p = PLATFORMS[m.platform];
      const token = m.api_token ? decryptSecret(m.api_token) : null;
      const http = callJsonVia(m.private_allow, m.ca_pem);
      const listed = await p.mirror.list(place(m), token, http);
      const { rows: all } = await query<MirrorRow>(`${MIRROR} WHERE m.source_id = $1 AND lower(m.scope) = lower($2) AND m.enabled`, [m.source_id, m.scope]);
      // Parents first, so a story finds its epic in the same run.
      const mine = listed
        .filter((i) => ownerOf(all, i)?.id === m.id)
        .sort((a, b) => (LEVEL[mapped(m.type_map, p.mirror.types, a.type) ?? ''] ?? 9) - (LEVEL[mapped(m.type_map, p.mirror.types, b.type) ?? ''] ?? 9));
      for (const item of mine) counts[await tx((db) => apply(db, m, item))]++;
      // What the team has from this mirror that the source no longer lists here.
      const seen = new Set(listed.filter((i) => !i.confidential).map((i) => i.external_id));
      const { rows: kept } = await query("SELECT id, external_id FROM work_items WHERE mirror_id = $1 AND status <> 'removed'", [m.id]);
      const gone = kept.filter((k) => !seen.has(k.external_id));
      let message = `${mine.length} items read from ${label}`;
      if (gone.length && kept.length >= SHRINK_MIN && gone.length > kept.length * (SHRINK_MAX_PERCENT / 100)) {
        message += `; ${gone.length} of ${kept.length} items are no longer listed (more than ${SHRINK_MAX_PERCENT} %), so none was marked removed`;
        await audit(null, { entity_type: 'team', entity_ref: `#${m.team_id}`, action: 'mirror_shrink_refused', changes: { listed: mine.length, kept: kept.length, gone: gone.length } });
        await finish('refused', message);
        return { status: 'refused', counts, message };
      }
      // Moved out of the area (still there) or deleted (missing from the answer).
      const still = new Map((gone.length ? await p.mirror.lookup(place(m), gone.map((g) => g.external_id), token, http) : []).map((i) => [i.external_id, i]));
      for (const g of gone) {
        const now = still.get(g.external_id);
        const other = now && ownerOf(all, now);
        if (other) counts[await tx((db) => apply(db, other, now))]++;
        else if (await tx((db) => markRemoved(db, g.id, now ? goneReason(now, label) : `Deleted in ${label}`))) counts.removed++;
      }
      await finish('succeeded', message);
      return { status: 'succeeded', counts, message };
    } catch (err) {
      const message = runError(err, m.platform, m.base_url);
      logger.warn({ event: { dataset: 'kernel.dev' }, mirror: id, err: message }, 'work item mirror failed');
      await finish('failed', message);
      return { status: 'failed', counts, message };
    }
  });
}

/**
 * What a failed run says, in the log and on the mirror (which everyone with work.read sees). The error only picks one
 * of these texts; nothing of its own is shown, since it could carry what the request held (the token).
 */
function runError(err: unknown, platform: Platform, base: string) {
  const host = new URL(base).host;
  const { label, scopeExample } = PLATFORMS[platform].adapter;
  const status = (err as { status?: unknown }).status;
  const kind = (err as { kind?: unknown }).kind;
  if (status === 401 || status === 403) return `${host} rejected the token`;
  if (status === 404) return `${host} answered not found: check the ${scopeExample}`;
  if (typeof status === 'number') return `${host} answered with an HTTP error`;
  if (kind === 'not_json') return `The answer from ${host} is not JSON`;
  if (kind === 'not_a_list') return `${label} did not return a list of work items`;
  if (kind === 'too_many') return `${label} lists more than 10000 items here: narrow the mirror with ${PLATFORMS[platform].mirror.areaName === 'label' ? 'a label' : 'an area path'}`;
  return `${label} could not be read: a network, TLS or credential problem`;
}

/** Every due mirror, one at a time (each holds its own lease, so replicas share the work). */
export async function reconcileDueMirrors() {
  const { rows } = await query("SELECT m.id FROM work_item_mirrors m JOIN dev_sources s ON s.id = m.source_id WHERE m.enabled AND s.enabled AND m.next_run_at <= now() AND (m.running_until IS NULL OR m.running_until < now()) ORDER BY m.next_run_at");
  for (const r of rows) await reconcileMirror(r.id, 'schedule').catch(() => undefined);
}

// ---- Back to the source --------------------------------------------------------------------------

interface CommentRow { id: number; attempts: number; work_item_id: number; reference: string }

/**
 * Posts the queued link comments (work-items.ts queues one when a mirrored item is linked to a Kernel record). Only
 * the reference goes out, never the record's title. A mirror that was stopped, turned off or no longer comments skips
 * its rows; errors are classified as a run's are, never the error's own text.
 */
export async function sendSourceComments(limit = 20) {
  const { sent } = await processOutbox<CommentRow>({
    table: 'work_item_source_comments', leaseSeconds: 120, limit, retryIn: backoffMinutes(1, 5, 30, 120),
    send: async (row) => {
      const { rows } = await query(
        `SELECT w.external_id, w.source, m.scope, m.area, m.comment_links, m.enabled, s.platform, s.base_url, s.api_token, s.private_allow, s.ca_pem, s.enabled AS source_enabled
         FROM work_items w JOIN work_item_mirrors m ON m.id = w.mirror_id JOIN dev_sources s ON s.id = m.source_id WHERE w.id = $1`,
        [row.work_item_id],
      );
      const c = rows[0];
      if (!c) throw new SkipDelivery('The item is no longer mirrored');
      if (!c.comment_links || !c.enabled || !c.source_enabled) throw new SkipDelivery('The mirror does not comment now');
      if (!c.api_token) throw new SkipDelivery('The source has no API token');
      const platform = c.platform as Platform;
      try {
        await PLATFORMS[platform].mirror.comment({ base: c.base_url, scope: c.scope, area: c.area }, c.external_id, `Linked to ${row.reference} in Kernel`, decryptSecret(c.api_token), callJsonVia(c.private_allow, c.ca_pem));
      } catch (err) {
        const message = runError(err, platform, c.base_url);
        const status = (err as { status?: unknown }).status;
        throw status === 401 || status === 403 || status === 404 ? new GiveUp(message) : new Error(message);
      }
    },
  });
  return sent;
}
