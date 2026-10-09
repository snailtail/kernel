// Service level management (#43): SLAs with response and resolution targets per priority in business time, and
// the SLA clock on incidents. The clock pauses while on hold (and between resolved and a reopen); due and breach
// times are stored for queries and recomputed on every state change; warnings and breaches fire once.
import { z } from 'zod';
import type { User } from './auth.js';
import { audit } from './audit.js';
import { addBusinessMinutes, businessMinutes, swedishHolidays, type Calendar } from './business-time.js';
import { computeImpact, impactSchema } from './cmdb-graph.js';
import { query, tx } from './db.js';
import { conflict, notFound } from './errors.js';
import { logIncident } from './incident-log.js';
import { managers, notify } from './notifications.js';
import { moduleEnabled } from './modules.js';
import { authorize } from './policy.js';
import type { Db } from './problems.js';

const MINUTE = 60_000;
type Target = 'response' | 'resolution';

// ---- Calendars ---------------------------------------------------------------------------------

const calendarCache = new Map<number, { at: number; cal: Calendar & { id: number; name: string } }>();

export async function loadCalendar(db: Db, id: number, now = Date.now()) {
  const cached = calendarCache.get(id);
  if (cached && now - cached.at < 60_000) return cached.cal;
  const { rows } = await db.query('SELECT * FROM business_calendars WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Calendar not found');
  const { rows: days } = await db.query("SELECT to_char(day, 'YYYY-MM-DD') AS day FROM calendar_holidays WHERE calendar_id = $1", [id]);
  const holidays = new Set<string>(days.map((d) => d.day));
  if (rows[0].holiday_preset === 'SE') {
    const year = new Date(now).getUTCFullYear();
    for (let y = year - 2; y <= year + 3; y++) swedishHolidays(y).filter((h) => !h.customary || rows[0].include_customary).forEach((h) => holidays.add(h.day));
  }
  const cal = { id: rows[0].id, name: rows[0].name, timezone: rows[0].timezone, always: rows[0].always, hours: rows[0].hours, holidays };
  calendarCache.set(id, { at: now, cal });
  return cal;
}

export const calendarSchema = z.object({
  name: z.string().trim().min(1).max(100),
  timezone: z.string().refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'Unknown time zone').default('Europe/Stockholm'),
  always: z.boolean().default(false),
  hours: z.partialRecord(z.enum(['1', '2', '3', '4', '5', '6', '7']), z.array(z.tuple([z.number().int().min(0).max(1440), z.number().int().min(0).max(1440)]).refine(([s, e]) => e > s, 'end after start')).max(4)).default({}),
  holiday_preset: z.enum(['SE']).nullable().default(null),
  /** Also close on customary days off (Julafton, Nyårsafton, Midsommarafton). */
  include_customary: z.boolean().default(true),
  holidays: z.array(z.object({ day: z.iso.date(), name: z.string().max(100).default('') })).max(200).default([]),
});

export async function listCalendars(user: User) {
  authorize(user, 'meta.read');
  const { rows } = await query(
    `SELECT c.*, coalesce((SELECT json_agg(json_build_object('day', to_char(h.day, 'YYYY-MM-DD'), 'name', h.name) ORDER BY h.day) FROM calendar_holidays h WHERE h.calendar_id = c.id), '[]') AS holidays
     FROM business_calendars c ORDER BY c.always DESC, c.name`,
  );
  return rows;
}

export async function saveCalendar(user: User, id: number | null, input: z.infer<typeof calendarSchema>) {
  authorize(user, 'sla.manage');
  const saved = await tx(async (db) => {
    const { holidays, ...c } = input;
    const { rows } = id
      ? await db.query('UPDATE business_calendars SET name = $2, timezone = $3, always = $4, hours = $5, holiday_preset = $6, include_customary = $7 WHERE id = $1 RETURNING id', [id, c.name, c.timezone, c.always, JSON.stringify(c.hours), c.holiday_preset, c.include_customary])
      : await db.query('INSERT INTO business_calendars (name, timezone, always, hours, holiday_preset, include_customary) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [c.name, c.timezone, c.always, JSON.stringify(c.hours), c.holiday_preset, c.include_customary]);
    if (!rows[0]) throw notFound('Calendar not found');
    await db.query('DELETE FROM calendar_holidays WHERE calendar_id = $1', [rows[0].id]);
    for (const h of holidays) await db.query('INSERT INTO calendar_holidays (calendar_id, day, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [rows[0].id, h.day, h.name]);
    await audit(db, { entity_type: 'calendar', entity_ref: c.name, action: id ? 'update' : 'create', changes: input });
    return rows[0].id as number;
  });
  calendarCache.delete(saved);
  return (await listCalendars(user)).find((c) => c.id === saved);
}

// ---- SLAs --------------------------------------------------------------------------------------

const targets = z.partialRecord(z.enum(['1', '2', '3', '4', '5']), z.number().int().min(1).max(525_600));
export const slaSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(''),
  calendar_id: z.number().int(),
  response_minutes: targets.default({}),
  resolution_minutes: targets.default({}),
  availability_target: z.number().min(0).max(100).nullable().default(null),
  is_default: z.boolean().default(false),
});

export async function listSlas(user: User) {
  authorize(user, 'meta.read');
  const { rows } = await query(
    `SELECT s.*, c.name AS calendar, (SELECT count(*)::int FROM configuration_items ci WHERE ci.sla_id = s.id) AS services
     FROM slas s JOIN business_calendars c ON c.id = s.calendar_id ORDER BY s.is_default DESC, s.name`,
  );
  return rows;
}

export async function saveSla(user: User, id: number | null, input: z.infer<typeof slaSchema>) {
  authorize(user, 'sla.manage');
  return tx(async (db) => {
    if (input.is_default) await db.query('UPDATE slas SET is_default = false WHERE is_default AND id IS DISTINCT FROM $1', [id]);
    const cols = Object.keys(input) as (keyof typeof input)[];
    const values = cols.map((k) => (k.endsWith('_minutes') ? JSON.stringify(input[k]) : input[k]));
    try {
      const { rows } = id
        ? await db.query(`UPDATE slas SET ${cols.map((k, n) => `${k} = $${n + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [id, ...values])
        : await db.query(`INSERT INTO slas (${cols.join(', ')}) VALUES (${cols.map((_, n) => `$${n + 1}`).join(', ')}) RETURNING *`, values);
      if (!rows[0]) throw notFound('SLA not found');
      await audit(db, { entity_type: 'sla', entity_ref: input.name, action: id ? 'update' : 'create', changes: input });
      return rows[0];
    } catch (err: any) {
      if (err.code === '23505') throw conflict('An SLA with that name already exists');
      throw err;
    }
  });
}

// ---- The clock ---------------------------------------------------------------------------------

/** The SLA for an incident: of its most critical service (directly or through the CMDB) that has one, else the default. */
async function chooseSla(db: Db, incidentId: number): Promise<number | null> {
  const { rows: cis } = await db.query(
    'SELECT c.ref, c.class, c.criticality, c.sla_id FROM incident_cis x JOIN configuration_items c ON c.id = x.ci_id WHERE x.incident_id = $1 ORDER BY c.criticality LIMIT 10',
    [incidentId],
  );
  const candidates: { criticality: number; sla_id: number }[] = cis.filter((c) => c.sla_id).map((c) => ({ criticality: c.criticality, sla_id: c.sla_id }));
  for (const ci of cis) {
    const up = await computeImpact(null, ci.ref, impactSchema.parse({ direction: 'up', max_depth: 10 }));
    if (!up.services.length) continue;
    const { rows } = await db.query("SELECT criticality, sla_id FROM configuration_items WHERE ref = ANY($1) AND sla_id IS NOT NULL", [up.services.map((s) => s.ref)]);
    candidates.push(...rows);
  }
  if (candidates.length) return candidates.sort((a, b) => a.criticality - b.criticality)[0].sla_id;
  const { rows } = await db.query('SELECT id FROM slas WHERE is_default');
  return rows[0]?.id ?? null;
}

/** Recomputes the SLA (when asked), due times and breach times of an incident; logs moved targets. */
export async function recomputeSla(db: Db, incidentId: number, options: { reselect?: boolean; reason?: string } = {}) {
  if (!moduleEnabled('sla')) return;
  const { rows } = await db.query('SELECT * FROM incidents WHERE id = $1', [incidentId]);
  const i = rows[0];
  const slaId = options.reselect || i.sla_id === null ? await chooseSla(db, incidentId) : i.sla_id;
  if (!slaId) {
    await db.query('UPDATE incidents SET sla_id = NULL, response_due_at = NULL, resolution_due_at = NULL WHERE id = $1', [incidentId]);
    return;
  }
  const { rows: s } = await db.query('SELECT * FROM slas WHERE id = $1', [slaId]);
  const cal = await loadCalendar(db, s[0].calendar_id);
  const created = new Date(i.created_at).getTime();
  const resp = s[0].response_minutes[String(i.priority)];
  const res = s[0].resolution_minutes[String(i.priority)];
  const responseDue = resp ? new Date(addBusinessMinutes(cal, created, resp)) : null;
  const resolutionDue = res ? new Date(addBusinessMinutes(cal, created, res + i.sla_paused_minutes)) : null;
  await db.query('UPDATE incidents SET sla_id = $2, response_due_at = $3, resolution_due_at = $4 WHERE id = $1', [incidentId, slaId, responseDue, resolutionDue]);
  const moved = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) !== (b?.getTime() ?? null);
  if (options.reason && (slaId !== i.sla_id || moved(i.resolution_due_at, resolutionDue) || moved(i.response_due_at, responseDue))) {
    const fmt = (d: Date | null) => (d ? d.toISOString() : 'none');
    await logIncident(db, incidentId, null, 'sla', `${options.reason}: resolution target moved from ${fmt(i.resolution_due_at)} to ${fmt(resolutionDue)}`, {
      sla: { from: i.sla_id, to: slaId }, resolution_due_at: { from: i.resolution_due_at, to: resolutionDue }, response_due_at: { from: i.response_due_at, to: responseDue },
    });
  }
}

/**
 * Pauses and resumes the clock on status changes: on hold and resolved pause the resolution clock; leaving them
 * adds the paused business time, so the clock resumes exactly where it stopped (a reopen keeps the response).
 */
export async function slaOnTransition(db: Db, incidentId: number, to: string, now = new Date()) {
  const { rows } = await db.query('SELECT sla_id, sla_paused_since, priority FROM incidents WHERE id = $1', [incidentId]);
  const i = rows[0];
  const pausing = to === 'on_hold' || to === 'resolved' || to === 'closed';
  if (pausing && !i.sla_paused_since) {
    await db.query('UPDATE incidents SET sla_paused_since = $2 WHERE id = $1', [incidentId, now]);
  } else if (!pausing && i.sla_paused_since) {
    let paused = 0;
    if (i.sla_id) {
      const { rows: s } = await db.query('SELECT calendar_id FROM slas WHERE id = $1', [i.sla_id]);
      if (s[0]) paused = Math.round(businessMinutes(await loadCalendar(db, s[0].calendar_id), new Date(i.sla_paused_since).getTime(), now.getTime()));
    }
    await db.query('UPDATE incidents SET sla_paused_since = NULL, sla_paused_minutes = sla_paused_minutes + $2 WHERE id = $1', [incidentId, paused]);
    await recomputeSla(db, incidentId);
  }
}

export interface ClockState { target_minutes: number | null; due_at: string | null; elapsed_minutes: number; remaining_minutes: number | null; state: 'on_track' | 'at_risk' | 'breached' | 'met' | 'paused' | 'none'; met_at?: string | null }

/** The SLA clock as shown: computed on read from the stored due times and pauses. */
export async function slaClock(db: Db, i: any, now = Date.now()) {
  if (!i.sla_id || !moduleEnabled('sla')) return null;
  const { rows: s } = await db.query('SELECT s.*, c.name AS calendar FROM slas s JOIN business_calendars c ON c.id = s.calendar_id WHERE s.id = $1', [i.sla_id]);
  if (!s[0]) return null;
  const cal = await loadCalendar(db, s[0].calendar_id, now);
  const created = new Date(i.created_at).getTime();
  const pausedNow = i.sla_paused_since ? businessMinutes(cal, new Date(i.sla_paused_since).getTime(), now) : 0;
  const clock = (target: Target): ClockState => {
    const minutes = s[0][`${target}_minutes`][String(i.priority)] ?? null;
    if (!minutes) return { target_minutes: null, due_at: null, elapsed_minutes: 0, remaining_minutes: null, state: 'none' };
    const stopAt = target === 'response' ? (i.responded_at ? new Date(i.responded_at).getTime() : null) : i.resolved_at && i.sla_paused_since ? new Date(i.resolved_at).getTime() : null;
    const end = stopAt ?? now;
    const paused = target === 'resolution' ? i.sla_paused_minutes + (stopAt ? 0 : pausedNow) : 0;
    const elapsed = Math.max(0, Math.round(businessMinutes(cal, created, end) - paused));
    const breached = target === 'response' ? i.response_breached_at : i.resolution_breached_at;
    const state: ClockState['state'] = stopAt
      ? elapsed <= minutes ? 'met' : 'breached'
      : breached || elapsed > minutes ? 'breached' : target === 'resolution' && i.sla_paused_since ? 'paused' : elapsed >= minutes * 0.75 ? 'at_risk' : 'on_track';
    return {
      target_minutes: minutes, due_at: i[`${target}_due_at`], elapsed_minutes: elapsed, remaining_minutes: stopAt ? null : minutes - elapsed, state,
      ...(stopAt ? { met_at: new Date(stopAt).toISOString() } : {}),
    };
  };
  return { id: s[0].id, name: s[0].name, calendar: s[0].calendar, response: clock('response'), resolution: clock('resolution'), paused: !!i.sla_paused_since };
}

/** Raises each 75 % warning and breach once (sla_events primary key), logs it, and records breach times. */
export async function checkSlaEvents(now = Date.now()) {
  const { rows } = await query(
    `SELECT * FROM incidents WHERE sla_id IS NOT NULL AND status NOT IN ('resolved', 'closed') AND sla_paused_since IS NULL
       AND (resolution_due_at IS NOT NULL OR (response_due_at IS NOT NULL AND responded_at IS NULL))`,
  );
  let fired = 0;
  for (const i of rows) {
    await tx(async (db) => {
      const clock = await slaClock(db, i, now);
      if (!clock) return;
      for (const target of ['response', 'resolution'] as Target[]) {
        const c = clock[target];
        if (!c.target_minutes || c.met_at || (target === 'response' && i.responded_at)) continue;
        const kinds = c.elapsed_minutes > c.target_minutes ? ['warning', 'breach'] : c.elapsed_minutes >= c.target_minutes * 0.75 ? ['warning'] : [];
        for (const kind of kinds) {
          const { rowCount } = await db.query('INSERT INTO sla_events (incident_id, target, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [i.id, target, kind]);
          if (!rowCount) continue;
          fired++;
          if (kind === 'breach') await db.query(`UPDATE incidents SET ${target}_breached_at = now() WHERE id = $1 AND ${target}_breached_at IS NULL`, [i.id]);
          await notify(db, {
            users: i.assignee_id ? [i.assignee_id] : await managers(db), event: kind === 'breach' ? 'sla_breach' : 'sla_warning', ref: i.ref, title: i.title,
            summary: `${target === 'response' ? 'Response' : 'Resolution'} target ${kind === 'breach' ? 'breached' : 'at risk (75 % used)'}.`,
            path: `/incidents/${i.ref}`, dedupe: `sla:${kind}:${i.ref}:${target}`,
          });
          await logIncident(db, i.id, null, 'sla', kind === 'breach' ? `${target === 'response' ? 'Response' : 'Resolution'} target breached` : `${target === 'response' ? 'Response' : 'Resolution'} target at risk: 75 % used`, {
            target, kind, sla: clock.name, due_at: c.due_at, elapsed_minutes: c.elapsed_minutes, target_minutes: c.target_minutes,
          });
        }
      }
    });
  }
  return fired;
}

/** Open incidents without an SLA (e.g. from before SLAs existed) get one; runs at startup. */
export async function backfillSla() {
  const { rows } = await query("SELECT id FROM incidents WHERE sla_id IS NULL AND status NOT IN ('resolved', 'closed') LIMIT 5000");
  for (const r of rows) await tx((db) => recomputeSla(db, r.id, { reselect: true }));
  return rows.length;
}

export function startSlaWorker(log: (msg: string) => void) {
  backfillSla().catch((err) => log(`SLA backfill failed: ${err.message}`));
  setInterval(() => moduleEnabled('sla') && moduleEnabled('incident') && checkSlaEvents().catch((err) => log(`SLA check failed: ${err.message}`)), 60_000).unref();
}

// ---- Catalogue and reports ---------------------------------------------------------------------

export async function serviceCatalogue(user: User) {
  authorize(user, 'ci.read');
  const { rows } = await query(
    `SELECT c.ref, c.name, c.status, c.criticality, c.team, c.user_description, c.how_to_get_help, c.in_catalogue, o.display_name AS owner,
            s.id AS sla_id, s.name AS sla, cal.name AS support_hours, s.response_minutes, s.resolution_minutes, s.availability_target,
            (SELECT count(*)::int FROM incidents i JOIN incident_cis x ON x.incident_id = i.id WHERE x.ci_id = c.id AND i.status NOT IN ('resolved', 'closed')) AS open_incidents
     FROM configuration_items c LEFT JOIN users o ON o.id = c.owner_id LEFT JOIN slas s ON s.id = c.sla_id LEFT JOIN business_calendars cal ON cal.id = s.calendar_id
     WHERE c.class = 'service' AND c.status <> 'retired' ORDER BY c.in_catalogue DESC, c.criticality, c.name`,
  );
  return rows;
}

export const complianceSchema = z.object({ from: z.iso.date(), to: z.iso.date() });

/** SLA compliance of incidents resolved in a period, by priority, service and assignment group. */
export async function slaCompliance(from: string, to: string) {
  const base = `FROM incidents i WHERE i.sla_id IS NOT NULL AND i.resolved_at >= $1::date AND i.resolved_at < $2::date + 1`;
  const metrics = `count(*)::int AS resolved,
    count(*) FILTER (WHERE i.resolution_due_at IS NOT NULL AND i.resolution_breached_at IS NULL AND i.resolved_at <= i.resolution_due_at)::int AS resolution_met,
    count(*) FILTER (WHERE i.resolution_due_at IS NOT NULL)::int AS resolution_with_target,
    count(*) FILTER (WHERE i.response_due_at IS NOT NULL AND i.response_breached_at IS NULL AND i.responded_at <= i.response_due_at)::int AS response_met,
    count(*) FILTER (WHERE i.response_due_at IS NOT NULL)::int AS response_with_target`;
  const [overall, byPriority, byGroup, byService] = await Promise.all([
    query(`SELECT ${metrics} ${base}`, [from, to]),
    query(`SELECT i.priority, ${metrics} ${base} GROUP BY i.priority ORDER BY i.priority`, [from, to]),
    query(`SELECT coalesce(nullif(i.assignment_group, ''), 'Unassigned') AS name, ${metrics} ${base} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, [from, to]),
    query(
      `SELECT svc.name, ${metrics} FROM incidents i
       JOIN LATERAL (SELECT c.name FROM incident_cis x JOIN configuration_items c ON c.id = x.ci_id WHERE x.incident_id = i.id ORDER BY c.class DESC, c.criticality LIMIT 1) svc ON true
       WHERE i.sla_id IS NOT NULL AND i.resolved_at >= $1::date AND i.resolved_at < $2::date + 1 GROUP BY svc.name ORDER BY 2 DESC LIMIT 20`,
      [from, to],
    ),
  ]);
  return { overall: overall.rows[0], by_priority: byPriority.rows, by_group: byGroup.rows, by_service: byService.rows };
}

