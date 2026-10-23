// Service reports (#54): one picture per service and period for the service review – was it available, what broke,
// what changed, what is being fixed. Everything is read through row-level security, so a report shows what its reader
// may see (managers are told when restricted records are left out).
import { z } from 'zod';
import type { User } from './auth.js';
import { businessMinutes } from './business-time.js';
import { pool, query } from './db.js';
import { loadCalendar } from './sla.js';
import { notFound } from './errors.js';
import { authorize } from './policy.js';
import { maskedRefs } from './confidential.js';
import { currentContext } from './context.js';
import { csvCell } from './reports.js';
import { hiddenRecordsExist } from './visibility.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const serviceReportSchema = z
  .object({ from: day.optional(), to: day.optional() })
  .transform((r) => {
    const to = r.to ?? new Date().toISOString().slice(0, 10);
    const from = r.from ?? new Date(Date.parse(to) - 29 * 86400000).toISOString().slice(0, 10);
    return { from, to };
  })
  .refine((r) => r.from <= r.to, 'from must be before to');

/** Intervals merged so that overlaps count once. */
function mergeIntervals(intervals: [number, number][]) {
  const out: [number, number][] = [];
  for (const [a, b] of intervals.filter(([x, y]) => y > x).sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** The parts of the intervals outside the holes (e.g. outage minus planned maintenance). */
export function subtractIntervals(intervals: [number, number][], holes: [number, number][]) {
  let rest = mergeIntervals(intervals);
  for (const [h0, h1] of mergeIntervals(holes)) {
    rest = rest.flatMap(([a, b]): [number, number][] => (h1 <= a || h0 >= b ? [[a, b]] : [...(h0 > a ? [[a, h0] as [number, number]] : []), ...(h1 < b ? [[h1, b] as [number, number]] : [])]));
  }
  return rest;
}

/** Minutes covered by a set of intervals, overlaps counted once. */
export function coveredMinutes(intervals: [number, number][]) {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let [start, end] = [-Infinity, -Infinity];
  for (const [a, b] of sorted) {
    if (a > end) {
      if (end > start) total += end - start;
      [start, end] = [a, b];
    } else end = Math.max(end, b);
  }
  if (end > start && Number.isFinite(start)) total += end - start;
  return Math.round(total / 60_000);
}

async function findService(ref: string) {
  const { rows } = await query("SELECT id, ref, name, criticality, description, owner_id FROM configuration_items WHERE ref = $1 AND class = 'service'", [ref.toUpperCase()]);
  if (!rows[0]) throw notFound(`Service ${ref} not found`);
  return rows[0];
}

// The service and its components (CIs that are part of it); $1 is the service's id, $2 and $3 the period.
const members = `(SELECT $1::int UNION SELECT r.from_ci FROM ci_relationships r WHERE r.to_ci = $1 AND r.type = 'member_of')`;

/** The records behind a service report: incidents active in the period, changes in it, problems open now. */
function serviceRecords(params: unknown[]) {
  return Promise.all([
    query(
      `SELECT DISTINCT i.id, i.ref, i.title, i.priority, i.is_major, i.status, i.created_at, i.resolved_at, i.resolution_due_at, i.resolution_breached_at, i.problem_id,
              (SELECT min(a.first_seen) FROM alerts a WHERE a.incident_id = i.id) AS alert_first_seen
       FROM incidents i JOIN incident_cis x ON x.incident_id = i.id
       WHERE x.ci_id IN ${members} AND i.created_at < $3::date + 1 AND coalesce(i.resolved_at, now()) >= $2::date
       ORDER BY i.created_at`,
      params,
    ),
    query(
      `SELECT DISTINCT c.ref, c.title, c.change_type, c.status, c.outcome, c.actual_start, c.actual_end, c.planned_start, c.created_at
       FROM changes c JOIN change_cis x ON x.change_id = c.id
       WHERE x.ci_id IN ${members} AND coalesce(c.actual_start, c.planned_start, c.created_at) BETWEEN $2::date AND $3::date + 1
       ORDER BY 1`,
      params,
    ),
    query(
      `SELECT DISTINCT p.ref, p.title, p.status, p.priority, p.workaround, p.known_error_at, p.created_at
       FROM problems p JOIN problem_cis x ON x.problem_id = p.id
       WHERE x.ci_id IN ${members} AND p.status NOT IN ('resolved', 'closed') AND $2::date IS NOT NULL AND $3::date IS NOT NULL
       ORDER BY p.priority, 1`,
      params,
    ),
  ]);
}

/**
 * `exported`: the report leaves Kernel (Markdown download, scheduled mail), so a confidential known error's workaround
 * is always masked, as for agents (#61). In the web it is masked unless this reader may read it.
 */
export async function serviceReport(user: User, ref: string, period: z.infer<typeof serviceReportSchema>, options: { exported?: boolean } = {}) {
  authorize(user, 'report.read');
  const s = await findService(ref);
  const fromTs = Date.parse(`${period.from}T00:00:00Z`);
  const toTs = Date.parse(`${period.to}T00:00:00Z`) + 86_400_000;
  const params = [s.id, period.from, period.to];
  const [[incidents, changes, problems], sla, maintenance] = await Promise.all([
    serviceRecords(params),
    query('SELECT s.name, s.availability_target, s.calendar_id FROM slas s WHERE s.id = (SELECT sla_id FROM configuration_items WHERE id = $1) OR (s.is_default AND (SELECT sla_id FROM configuration_items WHERE id = $1) IS NULL) LIMIT 1', [s.id]),
    query(`SELECT DISTINCT w.starts_at, w.ends_at, w.reason FROM maintenance_windows w WHERE w.ci_id IN ${members} AND w.starts_at < $3::date + 1 AND w.ends_at > $2::date ORDER BY 1`, params),
  ]);
  // Availability is measured in the SLA's service hours (#43): a night outage does not count against an office-hours
  // service, and the denominator is the service hours of the period. Without a calendar it is calendar time.
  const calendarId = sla.rows[0]?.calendar_id as number | undefined;
  const cal = calendarId ? await loadCalendar(pool, calendarId) : null;
  const minutesIn = (ivs: [number, number][]) => Math.round(mergeIntervals(ivs).reduce((n, [a, b]) => n + (cal ? businessMinutes(cal, a, b) : (b - a) / 60_000), 0));
  // Availability: outage = P1/P2 or major incidents, from logged to resolved, clipped to the period (overlaps once).
  const end = Math.min(toTs, Date.now());
  const clip = (a: number, b: number): [number, number] => [Math.max(a, fromTs), Math.min(b, end)];
  // An outage starts when monitoring first saw it, if that was before the incident was logged.
  const span = (i: any) => clip(Math.min(Date.parse(i.created_at), i.alert_first_seen ? Date.parse(i.alert_first_seen) : Infinity), i.resolved_at ? Date.parse(i.resolved_at) : Date.now());
  const planned = maintenance.rows.map((w): [number, number] => clip(Date.parse(w.starts_at), Date.parse(w.ends_at)));
  const outage = incidents.rows.filter((i) => i.is_major || i.priority <= 2);
  const degraded = incidents.rows.filter((i) => !(i.is_major || i.priority <= 2));
  const periodMinutes = minutesIn([[fromTs, end]]);
  // Planned maintenance is reported separately, not as unavailability.
  const outageMinutes = minutesIn(subtractIntervals(outage.map(span), planned));
  const resolved = incidents.rows.filter((i) => i.resolved_at && Date.parse(i.resolved_at) >= fromTs);
  const withTarget = resolved.filter((i) => i.resolution_due_at);
  const met = withTarget.filter((i) => !i.resolution_breached_at && Date.parse(i.resolved_at) <= Date.parse(i.resolution_due_at));
  const mttr = resolved.length ? Math.round(resolved.reduce((n, i) => n + (Date.parse(i.resolved_at) - Date.parse(i.created_at)), 0) / resolved.length / 60_000) : null;
  const done = changes.rows.filter((c) => c.outcome);
  const byPriority = [1, 2, 3, 4, 5].map((p) => ({ priority: p, count: incidents.rows.filter((i) => i.priority === p).length })).filter((x) => x.count);
  const recurring = incidents.rows.filter((i) => i.problem_id).length;
  const masked = await maskedRefs(options.exported || currentContext().channel === 'mcp' ? null : user, problems.rows.map((p) => p.ref));
  return {
    service: { ref: s.ref, name: s.name, criticality: s.criticality, sla: sla.rows[0]?.name ?? null, owner_id: s.owner_id as number | null },
    period: { from: period.from, to: period.to, minutes: periodMinutes },
    availability: {
      percent: periodMinutes > 0 ? Math.round((1 - outageMinutes / periodMinutes) * 100000) / 1000 : null,
      target: sla.rows[0]?.availability_target != null ? Number(sla.rows[0].availability_target) : null,
      outage_minutes: outageMinutes,
      degraded_minutes: minutesIn(subtractIntervals(degraded.map(span), planned)),
      maintenance_minutes: minutesIn(planned),
      basis: `Outage: P1/P2 or major incidents on the service or its components, from first alert or logging to resolution, outside planned maintenance, in ${cal ? `service hours (${cal.name})` : 'calendar time (24/7)'}.`,
    },
    incidents: {
      total: incidents.rows.length,
      by_priority: byPriority,
      resolution_sla: withTarget.length ? { met: met.length, of: withTarget.length, percent: Math.round((met.length / withTarget.length) * 1000) / 10 } : null,
      mttr_minutes: mttr,
      linked_to_problems: recurring,
      major: incidents.rows.filter((i) => i.is_major || i.priority === 1).map((i) => ({ ref: i.ref, title: i.title, created_at: i.created_at, resolved_at: i.resolved_at })),
    },
    changes: {
      total: changes.rows.length,
      completed: done.length,
      successful: done.filter((c) => c.outcome === 'successful').length,
      success_rate: done.length ? Math.round((done.filter((c) => c.outcome === 'successful').length / done.length) * 1000) / 10 : null,
      failed: done.filter((c) => c.outcome !== 'successful').map((c) => ({ ref: c.ref, title: c.title, outcome: c.outcome })),
    },
    problems: problems.rows.map((p) => ({
      ref: p.ref, title: p.title, status: p.status, priority: p.priority,
      workaround: p.status === 'known_error' && !masked.has(p.ref) ? p.workaround : null,
      ...(masked.has(p.ref) ? { workaround_masked: true } : {}),
    })),
    restricted_records_left_out: ['admin', 'manager'].includes(user.role) ? await hiddenRecordsExist() : false,
  };
}

/** A Markdown table cell: backslashes first, then pipes and line breaks. */
const cell = (v: string) => v.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

const dur = (m: number | null) => (m === null ? '–' : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`);

/** The report as Markdown, for the service review document or an email. */
export function serviceReportMarkdown(r: Awaited<ReturnType<typeof serviceReport>>) {
  const lines = [
    `# Service report: ${r.service.name}`,
    '',
    `${r.period.from} – ${r.period.to} · ${r.service.ref}${r.service.sla ? ` · SLA ${r.service.sla}` : ''}`,
    '',
    '## Availability',
    '',
    `**${r.availability.percent ?? '–'} %**${r.availability.target != null ? ` (target ${r.availability.target} %${r.availability.percent != null && r.availability.percent < r.availability.target ? ', missed' : ', met'})` : ''} · outage ${dur(r.availability.outage_minutes)} · degraded ${dur(r.availability.degraded_minutes)} · planned maintenance ${dur(r.availability.maintenance_minutes)}`,
    '',
    `_${r.availability.basis}_`,
    '',
    '## Incidents',
    '',
    `${r.incidents.total} incidents (${r.incidents.by_priority.map((p) => `P${p.priority}: ${p.count}`).join(', ') || 'none'}) · resolution SLA ${r.incidents.resolution_sla ? `${r.incidents.resolution_sla.percent} % (${r.incidents.resolution_sla.met}/${r.incidents.resolution_sla.of})` : '–'} · MTTR ${dur(r.incidents.mttr_minutes)} · ${r.incidents.linked_to_problems} linked to problems`,
    '',
    ...(r.incidents.major.length ? ['| Major or P1 | Title | Logged | Resolved |', '|---|---|---|---|', ...r.incidents.major.map((i) => `| ${i.ref} | ${cell(i.title)} | ${String(i.created_at).slice(0, 16)} | ${i.resolved_at ? String(i.resolved_at).slice(0, 16) : 'open'} |`), ''] : []),
    '## Changes',
    '',
    `${r.changes.total} changes · ${r.changes.completed} completed · success rate ${r.changes.success_rate ?? '–'} %`,
    ...r.changes.failed.map((c) => `- ${c.ref} ${c.title} (${c.outcome?.replace('_', ' ')})`),
    '',
    '## Open problems and known errors',
    '',
    ...(r.problems.length ? r.problems.map((p) => `- **${p.ref}** ${p.title} (${p.status.replace('_', ' ')}, P${p.priority})${p.workaround ? `\n  - Workaround: ${p.workaround.split('\n')[0]}` : p.workaround_masked ? '\n  - Workaround: confidential, not included' : ''}`) : ['None.']),
    '',
    ...(r.restricted_records_left_out ? ['_Some restricted records are not included._', ''] : []),
  ];
  return lines.join('\n');
}

/**
 * The report's rows as CSV (one per incident, change and problem), for a spreadsheet or BI tool. Only what the reader
 * may see; text cells are neutralised against formula injection (#69).
 */
export async function serviceReportCsv(user: User, ref: string, period: z.infer<typeof serviceReportSchema>) {
  authorize(user, 'report.read');
  const s = await findService(ref);
  const [incidents, changes, problems] = await serviceRecords([s.id, period.from, period.to]);
  const columns = ['kind', 'ref', 'title', 'status', 'priority', 'type', 'major', 'started', 'ended', 'outcome', 'resolution_target_met', 'problem'];
  const rows = [
    ...incidents.rows.map((i) => ({
      kind: 'incident', ref: i.ref, title: i.title, status: i.status, priority: i.priority, major: i.is_major, started: i.created_at, ended: i.resolved_at,
      resolution_target_met: !i.resolution_due_at || !i.resolved_at ? null : !i.resolution_breached_at && Date.parse(i.resolved_at) <= Date.parse(i.resolution_due_at),
      problem: i.problem_id ? 'yes' : 'no',
    })),
    ...changes.rows.map((c) => ({ kind: 'change', ref: c.ref, title: c.title, status: c.status, type: c.change_type, started: c.actual_start ?? c.planned_start, ended: c.actual_end, outcome: c.outcome })),
    ...problems.rows.map((p) => ({ kind: 'problem', ref: p.ref, title: p.title, status: p.status, priority: p.priority, started: p.created_at })),
  ];
  return [columns.join(','), ...rows.map((r: Record<string, unknown>) => columns.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}
