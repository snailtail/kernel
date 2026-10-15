// On-call (#111, decided in #42): integrate rather than reinvent. A team's paging target is PagerDuty (Events API v2),
// Opsgenie (Alerts API), Grafana OnCall (an integration webhook), a signed webhook (SMS gateways, ntfy…) or, for a
// team without a tool, a simple weekly rotation that notifies in Kernel. A rule says which incidents page the team.
//
// Pages go through an outbox (the pages table): whatever changes an incident decides what the paging tool should know
// (trigger, acknowledge, resolve, with the incident ref as the dedup key) inside its transaction, and a worker
// delivers it afterwards, so no HTTP call ever runs inside a transaction. The tool's own webhook tells Kernel who
// acknowledged, which is the incident's first response for its SLA.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { audienceOf, BROADEST, mayCopyText } from './audience.js';
import { audit } from './audit.js';
import type { User } from './auth.js';
import { businessMinutes, localDate, zonedToUtc } from './business-time.js';
import { config as appConfig } from './config.js';
import { asSystem } from './context.js';
import { query, tx } from './db.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { logIncident } from './incident-log.js';
import { notify } from './notifications.js';
import { outboundFetch, validatePrivateAllow } from './outbound.js';
import { authorize, can } from './policy.js';
import { affectedFrom } from './problem-cis.js';
import type { Db } from './problems.js';
import { decryptSecret, encryptSecret } from './secrets.js';
import { loadCalendar } from './sla.js';
import { standardSignature } from './webhooks.js';

export const KINDS = ['pagerduty', 'opsgenie', 'grafana_oncall', 'webhook', 'rotation'] as const;
type Kind = (typeof KINDS)[number];
const LABEL: Record<Kind, string> = { pagerduty: 'PagerDuty', opsgenie: 'Opsgenie', grafana_oncall: 'Grafana OnCall', webhook: 'webhook', rotation: 'the rotation' };

const https = z.string().trim().url().max(500).refine((u) => u.startsWith('https://'), 'https only');
const pem = z.string().max(20_000).regex(/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/, 'Paste a PEM certificate').optional().or(z.literal(''));

/** Non-secret settings per kind. The API URLs default to the vendors' and are only changed for a proxy (or a test). */
const CONFIG: Record<Kind, z.ZodType<Record<string, unknown>>> = {
  pagerduty: z.object({ events_url: https.default('https://events.pagerduty.com'), api_url: https.default('https://api.pagerduty.com'), escalation_policy_id: z.string().trim().max(50).default(''), ca_pem: pem }),
  opsgenie: z.object({ api_url: https.optional(), region: z.enum(['us', 'eu']).default('us'), schedule_id: z.string().trim().max(100).default(''), ca_pem: pem }),
  grafana_oncall: z.object({ ca_pem: pem }),
  webhook: z.object({ url: https, ca_pem: pem }),
  rotation: z.object({}),
};
/** Secrets per kind: encrypted, write-only. */
const SECRET: Record<Kind, z.ZodType<Record<string, string>>> = {
  // webhook_secret: the signing secret of the PagerDuty v3 webhook subscription (X-PagerDuty-Signature).
  pagerduty: z.object({ routing_key: z.string().trim().min(20).max(64), api_token: z.string().trim().max(200).optional(), webhook_secret: z.string().trim().max(200).optional() }),
  opsgenie: z.object({ api_key: z.string().trim().min(20).max(100) }),
  // The integration URL carries its own token, so it is the secret.
  grafana_oncall: z.object({ url: https }),
  webhook: z.object({ signing_secret: z.string().min(16).max(200) }),
  rotation: z.object({}),
};

export const ruleSchema = z.object({
  priorities: z.array(z.number().int().min(1).max(5)).max(5).default([1, 2]),
  /** A declared major incident pages whatever its priority. */
  major: z.boolean().default(true),
  /** Only incidents on these services (refs); empty for any. */
  services: z.array(z.string().max(30)).max(50).default([]),
  hours: z.enum(['always', 'business', 'out_of_hours']).default('always'),
  /** The calendar for business hours; the default SLA's if left out. */
  calendar_id: z.number().int().nullable().default(null),
});
export const targetSchema = z.object({
  kind: z.enum(KINDS),
  config: z.record(z.string(), z.unknown()).default({}),
  /** Write-only: leave out to keep the stored one. */
  secret: z.record(z.string(), z.string()).optional(),
  rule: ruleSchema.default({ priorities: [1, 2], major: true, services: [], hours: 'always', calendar_id: null }),
  private_allow: z.array(z.string().max(50)).max(20).default([]),
  enabled: z.boolean().default(true),
  /** Issue a new inbound token (the old one stops working). */
  new_inbound_token: z.boolean().default(false),
});
export const rotationSchema = z.object({
  members: z.array(z.number().int()).max(50),
  handover_dow: z.number().int().min(1).max(7).default(1),
  handover_minute: z.number().int().min(0).max(1439).default(540),
  timezone: z.string().refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'Unknown time zone').default('Europe/Stockholm'),
  starts_on: z.iso.date().optional(),
});
export const overrideSchema = z.object({ user_id: z.number().int(), starts_at: z.iso.datetime({ offset: true }), ends_at: z.iso.datetime({ offset: true }), reason: z.string().trim().max(500).default('') });

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const PUBLIC = 'id, team_id, kind, config, rule, private_allow, enabled, created_at, updated_at, secret IS NOT NULL AS has_secret, inbound_token_hash IS NOT NULL AS has_inbound_token';

// ---- Configuration (administrators; team leads manage their rotation) -----------------------

async function teamOf(db: Db, id: number) {
  const { rows } = await db.query('SELECT id, name FROM teams WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Team not found');
  return rows[0] as { id: number; name: string };
}

export async function getPaging(user: User, teamId: number) {
  authorize(user, 'team.read');
  const { rows } = await query(`SELECT ${PUBLIC} FROM paging_targets WHERE team_id = $1`, [teamId]);
  const { rows: rot } = await query('SELECT members, handover_dow, handover_minute, timezone, starts_on::text AS starts_on FROM rotations WHERE team_id = $1', [teamId]);
  const { rows: overrides } = await query(
    `SELECT o.id, o.user_id, u.display_name AS name, o.starts_at, o.ends_at, o.reason FROM rotation_overrides o JOIN users u ON u.id = o.user_id
     WHERE o.team_id = $1 AND o.ends_at > now() ORDER BY o.starts_at`,
    [teamId],
  );
  return { target: rows[0] ?? null, rotation: rot[0] ?? null, overrides, inbound_url: rows[0] ? inboundUrl(rows[0].id) : null };
}

const inboundUrl = (id: number) => `${(appConfig.publicUrl || '').replace(/\/$/, '')}/api/paging/${id}/inbound`;

/** Saves the team's paging target. Secrets are encrypted; the inbound token is returned once, when it is issued. */
export async function savePaging(user: User, teamId: number, input: z.infer<typeof targetSchema>) {
  authorize(user, 'team.manage');
  const cfg = CONFIG[input.kind].parse(input.config);
  const secret = input.secret && Object.keys(input.secret).length ? SECRET[input.kind].parse(input.secret) : null;
  // Addresses are checked when a page is sent (outboundFetch: https, no private addresses unless allowed, no redirects
  // with credentials), like every connector.
  const allowProblem = validatePrivateAllow(input.private_allow);
  if (allowProblem) throw badRequest(allowProblem);
  let token: string | null = null;
  const saved = await tx(async (db) => {
    const team = await teamOf(db, teamId);
    const { rows: existing } = await db.query('SELECT id, kind, secret FROM paging_targets WHERE team_id = $1 FOR UPDATE', [teamId]);
    const kindChanged = existing[0] && existing[0].kind !== input.kind;
    if (!secret && input.kind !== 'rotation' && (!existing[0]?.secret || kindChanged)) throw badRequest(`${LABEL[input.kind]} needs its credentials`);
    if (!existing[0] || input.new_inbound_token) token = `kpg_${randomBytes(24).toString('base64url')}`;
    const values = [teamId, input.kind, JSON.stringify(cfg), secret ? encryptSecret(JSON.stringify(secret)) : input.kind === 'rotation' ? null : existing[0].secret, JSON.stringify(input.rule), input.private_allow, input.enabled, user.id];
    const { rows } = await db.query(
      `INSERT INTO paging_targets (team_id, kind, config, secret, rule, private_allow, enabled, created_by, inbound_token_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (team_id) DO UPDATE SET kind = $2, config = $3, secret = $4, rule = $5, private_allow = $6, enabled = $7,
         inbound_token_hash = coalesce($9, paging_targets.inbound_token_hash), updated_at = now()
       RETURNING ${PUBLIC}`,
      [...values, token ? hash(token) : null],
    );
    // What changed, never the secret.
    await audit(db, { entity_type: 'team', entity_ref: team.name, action: 'paging', changes: { kind: input.kind, config: cfg, rule: input.rule, enabled: input.enabled, secret: secret ? '[changed]' : undefined, inbound_token: token ? '[issued]' : undefined } });
    return rows[0];
  });
  cache.delete(teamId);
  return { ...saved, inbound_url: inboundUrl(saved.id), ...(token ? { inbound_token: token } : {}) };
}

export async function deletePaging(user: User, teamId: number) {
  authorize(user, 'team.manage');
  await tx(async (db) => {
    const team = await teamOf(db, teamId);
    const { rowCount } = await db.query('DELETE FROM paging_targets WHERE team_id = $1', [teamId]);
    if (!rowCount) throw notFound('The team has no paging target');
    await audit(db, { entity_type: 'team', entity_ref: team.name, action: 'paging_removed', changes: {} });
  });
  cache.delete(teamId);
}

/** The rotation: an administrator or the team's lead. Members must be in the team. */
export async function saveRotation(user: User, teamId: number, input: z.infer<typeof rotationSchema>) {
  authorize(user, 'team.read');
  await tx(async (db) => {
    const team = await teamOf(db, teamId);
    const { rows: lead } = await db.query("SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2 AND role = 'lead'", [teamId, user.id]);
    if (!can(user.role, 'team.manage') && !lead[0]) throw forbidden('Only an administrator or the team lead can change the rotation');
    const { rows: members } = await db.query('SELECT user_id FROM team_members WHERE team_id = $1 AND user_id = ANY($2)', [teamId, input.members]);
    if (members.length !== new Set(input.members).size) throw badRequest('Everyone in the rotation must be a member of the team');
    await db.query(
      `INSERT INTO rotations (team_id, members, handover_dow, handover_minute, timezone, starts_on) VALUES ($1, $2, $3, $4, $5, coalesce($6::date, current_date))
       ON CONFLICT (team_id) DO UPDATE SET members = $2, handover_dow = $3, handover_minute = $4, timezone = $5, starts_on = coalesce($6::date, rotations.starts_on), updated_at = now()`,
      [teamId, input.members, input.handover_dow, input.handover_minute, input.timezone, input.starts_on ?? null],
    );
    await audit(db, { entity_type: 'team', entity_ref: team.name, action: 'rotation', changes: { members: input.members, handover_dow: input.handover_dow, handover_minute: input.handover_minute, timezone: input.timezone } });
  });
  cache.delete(teamId);
  return getPaging(user, teamId);
}

export async function addOverride(user: User, teamId: number, input: z.infer<typeof overrideSchema>) {
  authorize(user, 'team.read');
  await tx(async (db) => {
    const team = await teamOf(db, teamId);
    const { rows: lead } = await db.query("SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2 AND role = 'lead'", [teamId, user.id]);
    // Anyone may take a shift themselves; only a lead or an administrator puts someone else on call.
    if (input.user_id !== user.id && !can(user.role, 'team.manage') && !lead[0]) throw forbidden('Only the team lead can put someone else on call');
    const { rows: member } = await db.query('SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, input.user_id]);
    if (!member[0]) throw badRequest('Only a member of the team can be on call for it');
    if (new Date(input.ends_at) <= new Date(input.starts_at)) throw badRequest('The override must end after it starts');
    await db.query('INSERT INTO rotation_overrides (team_id, user_id, starts_at, ends_at, reason, created_by) VALUES ($1, $2, $3, $4, $5, $6)', [teamId, input.user_id, input.starts_at, input.ends_at, input.reason, user.id]);
    await audit(db, { entity_type: 'team', entity_ref: team.name, action: 'rotation_override', changes: { user_id: input.user_id, starts_at: input.starts_at, ends_at: input.ends_at } });
  });
  cache.delete(teamId);
  return getPaging(user, teamId);
}

export async function removeOverride(user: User, teamId: number, id: number) {
  authorize(user, 'team.read');
  await tx(async (db) => {
    const { rows } = await db.query('SELECT user_id FROM rotation_overrides WHERE id = $1 AND team_id = $2', [id, teamId]);
    if (!rows[0]) throw notFound('Override not found');
    const { rows: lead } = await db.query("SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2 AND role = 'lead'", [teamId, user.id]);
    if (rows[0].user_id !== user.id && !can(user.role, 'team.manage') && !lead[0]) throw forbidden('Only the team lead can remove someone else\'s shift');
    await db.query('DELETE FROM rotation_overrides WHERE id = $1', [id]);
    await audit(db, { entity_type: 'team', entity_ref: `#${teamId}`, action: 'rotation_override_removed', changes: { id } });
  });
  cache.delete(teamId);
  return getPaging(user, teamId);
}

// ---- Who is on call ---------------------------------------------------------------------------

export interface OnCall { team_id: number; team: string; source: string; people: { name: string; until: string | null }[]; unavailable?: string }
const cache = new Map<number, { at: number; value: OnCall }>();

/** The person on call in the rotation now: an override, else the member whose week it is. */
export function rotationOnCall(rot: { members: number[]; handover_dow: number; handover_minute: number; timezone: string; starts_on: string }, overrides: { user_id: number; starts_at: Date | string; ends_at: Date | string }[], now = Date.now()) {
  const active = overrides.find((o) => new Date(o.starts_at).getTime() <= now && new Date(o.ends_at).getTime() > now);
  if (active) return { user_id: active.user_id, until: new Date(active.ends_at).toISOString() };
  if (!rot.members.length) return null;
  // The first handover: the handover weekday on or before starts_on, at the handover time, in the rotation's zone.
  const [y, m, d] = rot.starts_on.split('-').map(Number);
  const startDay = new Date(Date.UTC(y, m - 1, d));
  const back = (((startDay.getUTCDay() + 6) % 7) + 1 - rot.handover_dow + 7) % 7;
  startDay.setUTCDate(startDay.getUTCDate() - back);
  const handover = (week: number) => {
    const t = new Date(startDay);
    t.setUTCDate(t.getUTCDate() + week * 7);
    return zonedToUtc(rot.timezone, t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), rot.handover_minute);
  };
  let week = Math.max(0, Math.floor((now - handover(0)) / (7 * 86400_000)));
  // Daylight saving moves the handover by an hour: correct the estimate in either direction.
  while (week > 0 && handover(week) > now) week--;
  while (handover(week + 1) <= now) week++;
  const idx = now < handover(0) ? 0 : week % rot.members.length;
  return { user_id: rot.members[idx], until: new Date(handover(now < handover(0) ? 0 : week + 1)).toISOString() };
}

async function lookupOnCall(team: { id: number; name: string }): Promise<OnCall> {
  const base = { team_id: team.id, team: team.name };
  const { rows } = await query('SELECT * FROM paging_targets WHERE team_id = $1 AND enabled', [team.id]);
  const t = rows[0];
  if (!t || t.kind === 'rotation') {
    const { rows: rot } = await query('SELECT members, handover_dow, handover_minute, timezone, starts_on::text AS starts_on FROM rotations WHERE team_id = $1', [team.id]);
    const { rows: ov } = await query('SELECT user_id, starts_at, ends_at FROM rotation_overrides WHERE team_id = $1 AND ends_at > now()', [team.id]);
    if (!rot[0] && !ov.length) return { ...base, source: t ? 'rotation' : 'none', people: [] };
    const who = rotationOnCall(rot[0] ?? { members: [], handover_dow: 1, handover_minute: 0, timezone: 'UTC', starts_on: '2000-01-03' }, ov);
    if (!who) return { ...base, source: 'rotation', people: [] };
    const { rows: u } = await query('SELECT display_name FROM users WHERE id = $1', [who.user_id]);
    return { ...base, source: 'rotation', people: [{ name: u[0]?.display_name ?? '?', until: who.until }] };
  }
  const cfg = t.config;
  const secret = t.secret ? JSON.parse(decryptSecret(t.secret)) : {};
  try {
    if (t.kind === 'pagerduty' && cfg.escalation_policy_id && secret.api_token) {
      const res = await outboundFetch(`${cfg.api_url}/oncalls?escalation_policy_ids[]=${encodeURIComponent(cfg.escalation_policy_id)}&earliest=true`, {
        headers: { Authorization: `Token token=${secret.api_token}`, Accept: 'application/vnd.pagerduty+json;version=2' }, privateAllow: t.private_allow, ca: cfg.ca_pem || undefined, timeoutMs: 5000,
      });
      if (!res.ok) throw new Error(`PagerDuty answered ${res.status}`);
      const oncalls = (JSON.parse(res.body).oncalls ?? []).filter((o: any) => o.escalation_level === 1 || o.escalation_level === undefined);
      return { ...base, source: 'PagerDuty', people: oncalls.map((o: any) => ({ name: String(o.user?.summary ?? '?').slice(0, 100), until: o.end ?? null })) };
    }
    if (t.kind === 'opsgenie' && cfg.schedule_id) {
      const api = cfg.api_url ?? (cfg.region === 'eu' ? 'https://api.eu.opsgenie.com' : 'https://api.opsgenie.com');
      const res = await outboundFetch(`${api}/v2/schedules/${encodeURIComponent(cfg.schedule_id)}/on-calls?scheduleIdentifierType=id&flat=true`, {
        headers: { Authorization: `GenieKey ${secret.api_key}` }, privateAllow: t.private_allow, ca: cfg.ca_pem || undefined, timeoutMs: 5000,
      });
      if (!res.ok) throw new Error(`Opsgenie answered ${res.status}`);
      return { ...base, source: 'Opsgenie', people: (JSON.parse(res.body).data?.onCallRecipients ?? []).map((n: string) => ({ name: String(n).slice(0, 100), until: null })) };
    }
    return { ...base, source: LABEL[t.kind as Kind], people: [], unavailable: `${LABEL[t.kind as Kind]} does not tell Kernel who is on call${t.kind === 'pagerduty' ? ' (add an escalation policy and an API token)' : t.kind === 'opsgenie' ? ' (add a schedule)' : ''}` };
  } catch (err) {
    // Never stale names: say that the tool could not be reached.
    return { ...base, source: LABEL[t.kind as Kind], people: [], unavailable: `${LABEL[t.kind as Kind]} could not be reached (${(err as Error).message.slice(0, 100)})` };
  }
}

/** Who is on call per team, cached for a minute. */
export async function onCall(user: User, teamIds?: number[]) {
  authorize(user, 'team.read');
  const { rows: teams } = await query('SELECT id, name FROM teams WHERE active' + (teamIds ? ' AND id = ANY($1)' : '') + ' ORDER BY name', teamIds ? [teamIds] : []);
  return Promise.all(teams.map(async (team) => {
    const hit = cache.get(team.id);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const value = await lookupOnCall(team);
    // A failed lookup is not cached: the next request tries again, and nobody sees names from before the outage.
    if (!/could not be reached/.test(value.unavailable ?? '')) cache.set(team.id, { at: Date.now(), value });
    return value;
  }));
}

// ---- Deciding what to page (inside the incident's transaction) -------------------------------

async function inHours(db: Db, rule: z.infer<typeof ruleSchema>) {
  if (rule.hours === 'always') return true;
  const { rows } = await db.query('SELECT coalesce($1::int, (SELECT calendar_id FROM slas WHERE is_default ORDER BY id LIMIT 1)) AS id', [rule.calendar_id]);
  if (!rows[0]?.id) return true;
  const open = businessMinutes(await loadCalendar(db, rows[0].id), Date.now(), Date.now() + 60_000) > 0;
  return rule.hours === 'business' ? open : !open;
}

async function matches(db: Db, i: any, rule: z.infer<typeof ruleSchema>) {
  if (!(rule.priorities.includes(i.priority) || (rule.major && i.is_major))) return false;
  if (rule.services.length) {
    const { rows: cis } = await db.query('SELECT c.id, c.ref, c.name, c.class, c.criticality FROM incident_cis x JOIN configuration_items c ON c.id = x.ci_id WHERE x.incident_id = $1', [i.id]);
    const { affected_services } = await affectedFrom(cis, i.impact);
    const refs = new Set([...cis.map((c) => c.ref), ...affected_services.map((s: { ref: string }) => s.ref)]);
    if (!rule.services.some((s) => refs.has(s.toUpperCase()))) return false;
  }
  return inHours(db, rule);
}

/**
 * Brings the paging tool in line with the incident: trigger when it starts to match its team's rule, acknowledge when
 * someone responds in Kernel, resolve when it is resolved. Queued in the caller's transaction; delivered afterwards.
 */
export async function syncPaging(db: Db, incidentId: number, actorId: number | null) {
  const { rows } = await db.query('SELECT id, ref, priority, impact, is_major, status, team_id, responded_at FROM incidents WHERE id = $1', [incidentId]);
  const i = rows[0];
  if (!i) return;
  // Moved to another team (or to none): a page still open in the previous team's tool is resolved, so it stops
  // escalating there.
  const { rows: stale } = await db.query(
    `SELECT DISTINCT ON (p.target_id) p.target_id, p.team_id, p.kind, p.action FROM pages p
     WHERE p.incident_id = $1 AND p.status <> 'failed' AND p.team_id IS DISTINCT FROM $2 ORDER BY p.target_id, p.id DESC`,
    [i.id, i.team_id],
  );
  const { rows: now } = i.team_id ? await db.query('SELECT name FROM teams WHERE id = $1', [i.team_id]) : { rows: [] as any[] };
  for (const s of stale.filter((x) => x.action !== 'resolve' && x.target_id)) {
    await db.query('INSERT INTO pages (incident_id, team_id, target_id, kind, action, reason, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [i.id, s.team_id, s.target_id, s.kind, 'resolve', now[0] ? `moved to ${now[0].name}` : 'no longer with the team', actorId]);
  }
  if (!i.team_id) return kick();
  const { rows: targets } = await db.query('SELECT id, kind, rule FROM paging_targets WHERE team_id = $1 AND enabled', [i.team_id]);
  const t = targets[0];
  if (!t) return kick();
  const { rows: history } = await db.query("SELECT action FROM pages WHERE incident_id = $1 AND target_id = $2 AND status <> 'failed' ORDER BY id", [i.id, t.id]);
  const last = history.at(-1)?.action as string | undefined;
  const open = !['resolved', 'closed'].includes(i.status);
  const queue = (action: string, reason: string) =>
    db.query('INSERT INTO pages (incident_id, team_id, target_id, kind, action, reason, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)', [i.id, i.team_id, t.id, t.kind, action, reason, actorId]);
  if (open && (!last || last === 'resolve') && (await matches(db, i, ruleSchema.parse(t.rule)))) {
    await queue('trigger', i.is_major && !ruleSchema.parse(t.rule).priorities.includes(i.priority) ? 'major incident' : `P${i.priority}`);
  } else if (open && last === 'trigger' && i.responded_at) {
    await queue('acknowledge', 'responded in Kernel');
  } else if (!open && last && last !== 'resolve') {
    await queue('resolve', i.status);
  }
  kick();
}

// ---- Delivery (the worker) -------------------------------------------------------------------

let kickTimer: NodeJS.Timeout | null = null;
/** Deliver soon after the change commits, instead of waiting for the next tick. */
function kick() {
  if (kickTimer || process.env.NODE_ENV === 'test') return;
  kickTimer = setTimeout(() => { kickTimer = null; deliverPages().catch(() => {}); }, 500);
  kickTimer.unref();
}

const SEVERITY: Record<number, string> = { 1: 'critical', 2: 'error', 3: 'warning', 4: 'info', 5: 'info' };

async function send(page: any, target: any, i: any): Promise<{ status: number; skipped?: boolean; pagedUser?: number }> {
  const cfg = target.config;
  const secret = target.secret ? JSON.parse(decryptSecret(target.secret)) : {};
  const url = `${(appConfig.publicUrl || '').replace(/\/$/, '')}/incidents/${i.ref}`;
  // The paging tool is read by everyone on call there: a restricted incident leaves Kernel as its ref (#117).
  const title = mayCopyText(await audienceOf(null, i.ref), BROADEST, 'title') ? `${i.ref}: ${i.title}` : `${i.ref} (restricted incident)`;
  const opts = { privateAllow: target.private_allow, ca: cfg.ca_pem || undefined, timeoutMs: 10_000 };
  const post = (u: string, body: unknown, headers: Record<string, string> = {}) =>
    outboundFetch(u, { ...opts, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  switch (target.kind as Kind) {
    case 'pagerduty': {
      const res = await post(`${cfg.events_url}/v2/enqueue`, {
        routing_key: secret.routing_key, event_action: page.action, dedup_key: i.ref,
        ...(page.action === 'trigger' ? { payload: { summary: title.slice(0, 1024), source: 'Kernel', severity: SEVERITY[i.priority] ?? 'error', custom_details: { priority: `P${i.priority}`, major: i.is_major } }, links: [{ href: url, text: `Open ${i.ref} in Kernel` }] } : {}),
      });
      return { status: res.status };
    }
    case 'opsgenie': {
      const api = cfg.api_url ?? (cfg.region === 'eu' ? 'https://api.eu.opsgenie.com' : 'https://api.opsgenie.com');
      const auth = { Authorization: `GenieKey ${secret.api_key}` };
      const res = page.action === 'trigger'
        ? await post(`${api}/v2/alerts`, { message: title.slice(0, 130), alias: i.ref, description: `Open ${i.ref} in Kernel: ${url}`, priority: `P${Math.min(i.priority, 5)}`, source: 'Kernel', details: { url } }, auth)
        : await post(`${api}/v2/alerts/${encodeURIComponent(i.ref)}/${page.action === 'acknowledge' ? 'acknowledge' : 'close'}?identifierType=alias`, { source: 'Kernel', note: page.reason }, auth);
      return { status: res.status };
    }
    case 'grafana_oncall': {
      // The formatted webhook knows firing and resolved; an acknowledgement is made in Grafana OnCall itself.
      if (page.action === 'acknowledge') return { status: 0, skipped: true };
      const res = await post(secret.url, { alert_uid: i.ref, title, state: page.action === 'resolve' ? 'ok' : 'alerting', message: `Open ${i.ref} in Kernel`, link_to_upstream_details: url });
      return { status: res.status };
    }
    case 'webhook': {
      const id = `page_${page.id}`;
      const ts = Math.floor(Date.now() / 1000);
      const body = JSON.stringify({ type: `page.${page.action}`, incident: { ref: i.ref, title, priority: i.priority, major: i.is_major, url }, reason: page.reason });
      const res = await outboundFetch(cfg.url, { ...opts, method: 'POST', headers: { 'Content-Type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': standardSignature(secret.signing_secret, id, ts, body) }, body });
      return { status: res.status };
    }
    case 'rotation': {
      if (page.action !== 'trigger') return { status: 0, skipped: true };
      const { rows: rot } = await query('SELECT members, handover_dow, handover_minute, timezone, starts_on::text AS starts_on FROM rotations WHERE team_id = $1', [page.team_id]);
      const { rows: ov } = await query('SELECT user_id, starts_at, ends_at FROM rotation_overrides WHERE team_id = $1 AND ends_at > now()', [page.team_id]);
      const who = rotationOnCall(rot[0] ?? { members: [], handover_dow: 1, handover_minute: 0, timezone: 'UTC', starts_on: '2000-01-03' }, ov);
      if (!who) throw new Error('Nobody is in the rotation');
      return { status: 200, pagedUser: who.user_id };
    }
  }
}

/** Sends due pages, oldest first per incident; a failure is retried with backoff, five times. */
export async function deliverPages() {
  const { rows } = await query(
    `UPDATE pages SET lease_until = now() + interval '1 minute', attempts = attempts + 1
     WHERE id IN (SELECT p.id FROM pages p WHERE p.status = 'queued' AND p.next_attempt_at <= now() AND (p.lease_until IS NULL OR p.lease_until < now())
                    AND NOT EXISTS (SELECT 1 FROM pages e WHERE e.incident_id = p.incident_id AND e.target_id = p.target_id AND e.id < p.id AND e.status = 'queued')
                  ORDER BY p.id LIMIT 20 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
  );
  for (const page of rows) {
    const { rows: tr } = await query('SELECT * FROM paging_targets WHERE id = $1', [page.target_id]);
    const { rows: inc } = await query('SELECT id, ref, title, priority, is_major FROM incidents WHERE id = $1', [page.incident_id]);
    const { rows: team } = await query('SELECT name FROM teams WHERE id = $1', [page.team_id]);
    if (!tr[0] || !inc[0]) { await query("UPDATE pages SET status = 'skipped', error = 'target or incident gone' WHERE id = $1", [page.id]); continue; }
    let result: Awaited<ReturnType<typeof send>> | null = null;
    let error = '';
    try {
      result = await send(page, tr[0], inc[0]);
      if (!result.skipped && (result.status < 200 || result.status >= 300)) error = `HTTP ${result.status}`;
    } catch (err) {
      error = (err as Error).message.slice(0, 300);
    }
    const via = LABEL[tr[0].kind as Kind];
    await tx(async (db) => {
      if (!error) {
        await db.query("UPDATE pages SET status = $2, sent_at = now(), response_code = $3, error = '', lease_until = NULL, paged_user_id = $4 WHERE id = $1", [page.id, result!.skipped ? 'skipped' : 'sent', result!.status || null, result!.pagedUser ?? null]);
        if (result!.skipped) return;
        const what = { trigger: `Paged ${team[0]?.name ?? 'the team'} via ${via}`, acknowledge: `Acknowledged the page in ${via}`, resolve: `Resolved the page in ${via}` }[page.action as 'trigger'];
        await logIncident(db, page.incident_id, null, 'update', `${what}${page.reason && page.action === 'trigger' ? ` (${page.reason})` : ''}`, { paging: { action: page.action, via: tr[0].kind, page_id: Number(page.id) } });
        if (result!.pagedUser) {
          await notify(db, { users: [result!.pagedUser], event: 'paged', ref: inc[0].ref, title: inc[0].title, summary: `You are on call for ${team[0]?.name ?? 'your team'}: ${page.reason || 'a page'}.`, path: `/incidents/${inc[0].ref}`, dedupe: `paged:${page.id}`, actorId: null });
        }
      } else if (page.attempts >= 5) {
        await db.query("UPDATE pages SET status = 'failed', error = $2, response_code = $3, lease_until = NULL WHERE id = $1", [page.id, error, result?.status ?? null]);
        await logIncident(db, page.incident_id, null, 'update', `Paging ${team[0]?.name ?? 'the team'} via ${via} failed: ${error}`, { paging: { action: page.action, via: tr[0].kind, failed: true, page_id: Number(page.id) } });
        // Somebody must know that nobody was woken.
        const { rows: leads } = await db.query("SELECT user_id FROM team_members WHERE team_id = $1 AND role = 'lead'", [page.team_id]);
        await notify(db, { users: leads.map((l) => l.user_id), event: 'paged', ref: inc[0].ref, title: inc[0].title, summary: `Paging via ${via} failed: ${error}. Call the on-call person directly.`, path: `/incidents/${inc[0].ref}`, dedupe: `page-failed:${page.id}`, actorId: null });
      } else {
        await db.query("UPDATE pages SET error = $2, response_code = $3, lease_until = NULL, next_attempt_at = now() + (power(2, attempts) * interval '30 seconds') WHERE id = $1", [page.id, error, result?.status ?? null]);
      }
      await audit(db, { entity_type: 'incident', entity_ref: inc[0].ref, action: 'page', changes: { page_id: Number(page.id), action: page.action, via: tr[0].kind, status: error ? (page.attempts >= 5 ? 'failed' : 'retrying') : result!.skipped ? 'skipped' : 'sent', response_code: result?.status ?? null, error: error || undefined } });
    });
  }
  return rows.length;
}

/** After a change committed elsewhere (REST and MCP paths that do not hold the incident's transaction). */
export async function syncPagingByRef(ref: string, actorId: number | null) {
  await tx(async (db) => {
    const { rows } = await db.query('SELECT id FROM incidents WHERE ref = $1', [ref.toUpperCase()]);
    if (rows[0]) await syncPaging(db, rows[0].id, actorId);
  });
}

export function startPagingWorker(log: (msg: string) => void, enabled: () => boolean) {
  setInterval(() => enabled() && deliverPages().catch((err) => log(`paging failed: ${err.message}`)), 5_000).unref();
}

/** The pages of an incident, for its page and agents. */
export async function pagesFor(incidentId: number) {
  const { rows } = await query(
    `SELECT p.id, p.action, p.kind, p.reason, p.status, p.attempts, p.response_code, p.error, p.created_at, p.sent_at, t.name AS team, u.display_name AS paged_user
     FROM pages p LEFT JOIN teams t ON t.id = p.team_id LEFT JOIN users u ON u.id = p.paged_user_id WHERE p.incident_id = $1 ORDER BY p.id`,
    [incidentId],
  );
  return rows;
}

// ---- Inbound: the tool says who acknowledged -----------------------------------------------------

const REF = /\bINC\d{6}\b/gi;
const ACK = new Set(['incident.acknowledged', 'acknowledge', 'acknowledged', 'ack']);
const RESOLVE = new Set(['incident.resolved', 'resolve', 'resolved', 'close', 'closed', 'ok']);

/**
 * What a paging tool's webhook says, in the formats Kernel receives (PagerDuty v3, Opsgenie, Grafana OnCall, the
 * generic form): the candidate incident refs (explicit fields first), the action and who. The action is matched
 * against each tool's known values only.
 */
export function parseInbound(body: any): { refs: string[]; action: 'acknowledge' | 'resolve'; by: string } | null {
  const explicit = [body?.ref, body?.alert?.alias, body?.alert_uid, body?.event?.data?.incident_key].filter((x) => typeof x === 'string');
  const found = [...explicit, ...(JSON.stringify(body ?? {}).match(REF) ?? [])].map((r) => r.toUpperCase()).filter((r) => /^INC\d{6}$/.test(r));
  const refs = [...new Set(found)];
  if (!refs.length) return null;
  const kind = String(body?.event?.event_type ?? body?.action ?? body?.event_type ?? body?.state ?? '').trim().toLowerCase();
  const action = ACK.has(kind) ? 'acknowledge' : RESOLVE.has(kind) ? 'resolve' : null;
  if (!action) return null;
  const by = String(body?.by ?? body?.alert?.username ?? body?.event?.agent?.summary ?? body?.user?.username ?? body?.acknowledged_by ?? 'the on-call person').slice(0, 100);
  return { refs, action, by };
}

/** PagerDuty v3 webhooks: X-PagerDuty-Signature carries one or more "v1=<hex HMAC-SHA256 of the body>". */
export function verifyPagerDutySignature(secret: string, raw: string, header: string | undefined) {
  if (!header || !secret) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  return header.split(',').map((x) => x.trim()).filter((x) => x.startsWith('v1=')).some((x) => {
    const given = Buffer.from(x.slice(3));
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/**
 * A paging tool reports an acknowledgement (the first response, which stops the response SLA clock) or a resolution
 * (recorded only: resolving the incident stays a decision in Kernel). Authenticated with the target's inbound token in
 * a header, or for PagerDuty its webhook signature; and a target only speaks for incidents it paged itself.
 */
export async function receiveInbound(targetId: number, auth: { token?: string; pagerDutySignature?: string; raw: string }, body: unknown) {
  const { rows } = await asSystem(() => query('SELECT id, team_id, kind, secret, inbound_token_hash FROM paging_targets WHERE id = $1', [targetId]));
  const t = rows[0];
  const tokenOk = !!t?.inbound_token_hash && !!auth.token && timingSafeEqual(Buffer.from(hash(auth.token)), Buffer.from(t.inbound_token_hash));
  const pdSecret = t?.kind === 'pagerduty' && t.secret ? JSON.parse(decryptSecret(t.secret)).webhook_secret : undefined;
  const signatureOk = !!pdSecret && verifyPagerDutySignature(pdSecret, auth.raw, auth.pagerDutySignature);
  if (!tokenOk && !signatureOk) throw forbidden('Unknown paging target, token or signature');
  const msg = parseInbound(body);
  const refused = { accepted: false, reason: 'No incident this target paged, or no acknowledge/resolve in the payload' };
  if (!msg) return refused;
  // The target is the authority from here on: it may see what it paged, restricted incidents included.
  return asSystem(() => tx(async (db) => {
    const { rows: inc } = await db.query(
      `SELECT i.id, i.ref, i.responded_at FROM incidents i
       WHERE i.ref = ANY($1) AND EXISTS (SELECT 1 FROM pages p WHERE p.incident_id = i.id AND p.target_id = $2 AND p.action = 'trigger' AND p.status = 'sent')
       ORDER BY array_position($1, i.ref) LIMIT 1 FOR UPDATE OF i`,
      [msg.refs, t.id],
    );
    // Whether the incident exists at all is not told.
    if (!inc[0]) return refused;
    const via = LABEL[t.kind as Kind];
    if (msg.action === 'acknowledge') {
      await db.query('UPDATE incidents SET responded_at = coalesce(responded_at, now()) WHERE id = $1', [inc[0].id]);
      // Kernel need not acknowledge it back.
      await db.query("INSERT INTO pages (incident_id, team_id, target_id, kind, action, reason, status, sent_at) VALUES ($1, $2, $3, $4, 'acknowledge', $5, 'skipped', now())", [inc[0].id, t.team_id, t.id, t.kind, `acknowledged in ${via}`]);
    }
    await logIncident(db, inc[0].id, null, 'update', msg.action === 'acknowledge' ? `Acknowledged in ${via} by ${msg.by}` : `Resolved in ${via} by ${msg.by}; resolve the incident in Kernel when service is restored`, { paging: { inbound: msg.action, via: t.kind, by: msg.by } });
    return { accepted: true, ref: inc[0].ref, action: msg.action, first_response: msg.action === 'acknowledge' && !inc[0].responded_at };
  }));
}
