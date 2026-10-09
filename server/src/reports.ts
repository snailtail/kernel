// Problem management KPIs and trends for a period, used by the Reports page, CSV export and MCP.
import { z } from 'zod';
import { query } from './db.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const reportSchema = z
  .object({
    from: day.optional(),
    to: day.optional(),
    bucket: z.enum(['week', 'month']).optional(),
  })
  .transform((r) => {
    const to = r.to ?? new Date().toISOString().slice(0, 10);
    const from = r.from ?? new Date(Date.parse(to) - 89 * 86400000).toISOString().slice(0, 10);
    const days = (Date.parse(to) - Date.parse(from)) / 86400000;
    return { from, to, bucket: r.bucket ?? (days > 120 ? 'month' : 'week') };
  })
  .refine((r) => r.from <= r.to, 'from must be before to');

export type ReportParams = z.infer<typeof reportSchema>;

const hours = (col: string) => `extract(epoch FROM ${col}) / 3600`;

export async function report({ from, to, bucket }: ReportParams) {
  // [from, to] inclusive, as timestamps
  const range = [from, to];
  const inRange = (col: string) => `${col} >= $1::date AND ${col} < $2::date + 1`;

  const [flow, backlog, leadTimes, closures, reopened, detection, services, categories, knownErrors, actionStats, totals, cis, ciTypes, incidentStats, incidentCis] = await Promise.all([
    query(
      `WITH buckets AS (
         SELECT generate_series(date_trunc('${bucket}', $1::date), date_trunc('${bucket}', $2::date), '1 ${bucket}') AS start
       ),
       transitions AS (
         SELECT date_trunc('${bucket}', created_at) AS b, data->>'to' AS to_status
         FROM problem_activity WHERE kind = 'status' AND ${inRange('created_at')}
       )
       SELECT b.start::date::text AS bucket,
         (SELECT count(*) FROM problems p WHERE date_trunc('${bucket}', p.created_at) = b.start AND ${inRange('p.created_at')})::int AS opened,
         (SELECT count(*) FROM transitions t WHERE t.b = b.start AND t.to_status = 'known_error')::int AS known_errors,
         (SELECT count(*) FROM transitions t WHERE t.b = b.start AND t.to_status = 'resolved')::int AS resolved,
         (SELECT count(*) FROM transitions t WHERE t.b = b.start AND t.to_status = 'closed')::int AS closed
       FROM buckets b ORDER BY b.start`,
      range,
    ),
    // Open problems at the end of each bucket: logged before, and not yet resolved/closed at that time.
    query(
      `SELECT end_at::date::text AS at, (
         SELECT count(*) FROM problems p
         WHERE p.created_at <= end_at
           AND coalesce(least(p.resolved_at, p.closed_at), 'infinity') > end_at
       )::int AS open
       FROM (
         SELECT least(gs + '1 ${bucket}'::interval - interval '1 second', $2::date + 1 - interval '1 second') AS end_at
         FROM generate_series(date_trunc('${bucket}', $1::date), date_trunc('${bucket}', $2::date), '1 ${bucket}') gs
       ) e ORDER BY end_at`,
      range,
    ),
    query(
      `SELECT priority,
         count(*) FILTER (WHERE ${inRange('known_error_at')})::int AS known_error_count,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY ${hours('known_error_at - created_at')}) FILTER (WHERE ${inRange('known_error_at')}) AS known_error_median_h,
         percentile_cont(0.9) WITHIN GROUP (ORDER BY ${hours('known_error_at - created_at')}) FILTER (WHERE ${inRange('known_error_at')}) AS known_error_p90_h,
         count(*) FILTER (WHERE ${inRange('resolved_at')})::int AS resolved_count,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY ${hours('resolved_at - created_at')}) FILTER (WHERE ${inRange('resolved_at')}) AS resolved_median_h,
         percentile_cont(0.9) WITHIN GROUP (ORDER BY ${hours('resolved_at - created_at')}) FILTER (WHERE ${inRange('resolved_at')}) AS resolved_p90_h
       FROM problems GROUP BY priority ORDER BY priority`,
      range,
    ),
    query(
      `SELECT data->>'closure_code' AS closure_code, count(*)::int AS count
       FROM problem_activity WHERE kind = 'status' AND data->>'to' = 'closed' AND ${inRange('created_at')}
       GROUP BY 1 ORDER BY 2 DESC`,
      range,
    ),
    query(
      `SELECT count(*)::int AS count FROM problem_activity
       WHERE kind = 'status' AND data->>'to' = 'analysis' AND data->>'from' IN ('resolved', 'closed') AND ${inRange('created_at')}`,
      range,
    ),
    query(`SELECT detection, count(*)::int AS count FROM problems WHERE ${inRange('created_at')} GROUP BY detection`, range),
    query(
      `SELECT coalesce(nullif(p.affected_service, ''), 'Unspecified') AS name,
         count(DISTINCT l.id) FILTER (WHERE l.kind = 'incident' AND ${inRange('l.created_at')})::int AS incidents,
         count(DISTINCT l.id) FILTER (WHERE l.kind = 'event' AND ${inRange('l.created_at')})::int AS events,
         count(DISTINCT p.id) FILTER (WHERE p.status NOT IN ('resolved', 'closed'))::int AS open_problems
       FROM problems p LEFT JOIN problem_links l ON l.problem_id = p.id
       GROUP BY 1 HAVING count(DISTINCT l.id) FILTER (WHERE l.kind IN ('incident', 'event') AND ${inRange('l.created_at')}) > 0
         OR count(DISTINCT p.id) FILTER (WHERE p.status NOT IN ('resolved', 'closed')) > 0
       ORDER BY 2 DESC, 4 DESC LIMIT 10`,
      range,
    ),
    query(
      `SELECT coalesce(c.name, 'Uncategorised') AS name, count(*)::int AS logged,
         count(*) FILTER (WHERE p.status NOT IN ('resolved', 'closed'))::int AS open
       FROM problems p LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${inRange('p.created_at')} GROUP BY 1 ORDER BY 2 DESC`,
      range,
    ),
    query(`SELECT count(*)::int AS count,
             coalesce(round(avg(extract(epoch FROM now() - known_error_at) / 86400)), 0)::int AS avg_age_days,
             count(*) FILTER (WHERE workaround <> '')::int AS with_workaround,
             count(*) FILTER (WHERE coalesce(ec_decision, 'pending') <> 'pending')::int AS with_decision,
             count(*) FILTER (WHERE ec_decision = 'accept')::int AS risk_accepted,
             count(*) FILTER (WHERE ec_review_date <= current_date)::int AS review_due
           FROM problems WHERE status = 'known_error'`),
    query(
      `SELECT count(*) FILTER (WHERE status = 'done' AND ${inRange('completed_at')})::int AS completed,
         count(*) FILTER (WHERE status = 'done' AND ${inRange('completed_at')} AND due_date IS NOT NULL AND completed_at::date <= due_date)::int AS completed_on_time,
         count(*) FILTER (WHERE status = 'done' AND ${inRange('completed_at')} AND due_date IS NOT NULL)::int AS completed_with_due,
         count(*) FILTER (WHERE ${inRange('created_at')})::int AS created,
         count(*) FILTER (WHERE status = 'open' AND due_date < current_date)::int AS overdue_now,
         count(*) FILTER (WHERE status = 'open')::int AS open_now
       FROM problem_actions`,
      range,
    ),
    query(
      `SELECT count(*) FILTER (WHERE ${inRange('created_at')})::int AS opened,
         count(*) FILTER (WHERE is_major AND ${inRange('created_at')})::int AS major_opened,
         count(*) FILTER (WHERE status NOT IN ('resolved', 'closed'))::int AS open_now
       FROM problems`,
      range,
    ),
    // CI hotspots (#26): records and problems per CI, and records nobody has linked to a problem yet.
    query(
      `SELECT c.ref, c.name, c.class, t.label AS type_label, c.criticality,
         (SELECT count(*) FROM external_records r WHERE r.ci_id = c.id AND ${inRange('r.occurred_at')})::int AS records,
         (SELECT count(*) FROM external_records r WHERE r.ci_id = c.id AND r.problem_id IS NULL AND NOT r.dismissed AND ${inRange('r.occurred_at')})::int AS unlinked,
         (SELECT count(*) FROM problem_cis pc JOIN problems p ON p.id = pc.problem_id WHERE pc.ci_id = c.id AND p.status NOT IN ('resolved', 'closed'))::int AS open_problems,
         (SELECT count(*) FROM problem_cis pc JOIN problems p ON p.id = pc.problem_id WHERE pc.ci_id = c.id AND p.status = 'known_error')::int AS known_errors
       FROM configuration_items c JOIN ci_types t ON t.name = c.ci_type
       WHERE EXISTS (SELECT 1 FROM external_records r WHERE r.ci_id = c.id AND ${inRange('r.occurred_at')})
          OR EXISTS (SELECT 1 FROM problem_cis pc JOIN problems p ON p.id = pc.problem_id WHERE pc.ci_id = c.id AND p.status NOT IN ('resolved', 'closed'))
       ORDER BY unlinked DESC, records DESC, open_problems DESC LIMIT 10`,
      range,
    ),
    query(
      `SELECT t.label AS name, count(DISTINCT r.id)::int AS records, count(DISTINCT pc.problem_id)::int AS problems
       FROM configuration_items c JOIN ci_types t ON t.name = c.ci_type
       LEFT JOIN external_records r ON r.ci_id = c.id AND ${inRange('r.occurred_at')}
       LEFT JOIN problem_cis pc ON pc.ci_id = c.id
       GROUP BY t.label HAVING count(DISTINCT r.id) > 0 OR count(DISTINCT pc.problem_id) > 0
       ORDER BY 2 DESC, 3 DESC LIMIT 10`,
      range,
    ),
    // Incidents (#28): volumes, time to respond (MTTA) and to resolve (MTTR), reopen rate, major incidents.
    query(
      `SELECT count(*) FILTER (WHERE ${inRange('created_at')})::int AS opened,
         count(*) FILTER (WHERE ${inRange('resolved_at')})::int AS resolved,
         count(*) FILTER (WHERE is_major AND ${inRange('created_at')})::int AS major,
         count(*) FILTER (WHERE status NOT IN ('resolved', 'closed'))::int AS open_now,
         count(*) FILTER (WHERE reopen_count > 0 AND ${inRange('created_at')})::int AS reopened,
         count(*) FILTER (WHERE problem_id IS NOT NULL AND ${inRange('created_at')})::int AS with_problem,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM responded_at - created_at) / 60) FILTER (WHERE responded_at IS NOT NULL AND ${inRange('created_at')}) AS mtta_median_min,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM resolved_at - created_at) / 3600) FILTER (WHERE ${inRange('resolved_at')}) AS mttr_median_h
       FROM incidents`,
      range,
    ),
    query(
      `SELECT c.ref, c.name, count(*)::int AS incidents, count(*) FILTER (WHERE i.problem_id IS NULL)::int AS without_problem
       FROM incidents i JOIN incident_cis x ON x.incident_id = i.id JOIN configuration_items c ON c.id = x.ci_id
       WHERE ${inRange('i.created_at')} GROUP BY c.ref, c.name ORDER BY 3 DESC LIMIT 10`,
      range,
    ),
  ]);

  const sum = (key: string) => flow.rows.reduce((n, r) => n + r[key], 0);
  const round = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
  const det = Object.fromEntries(detection.rows.map((r) => [r.detection, r.count]));
  const a = actionStats.rows[0];
  return {
    period: { from, to, bucket },
    summary: {
      opened: totals.rows[0].opened,
      major_opened: totals.rows[0].major_opened,
      known_errors_raised: sum('known_errors'),
      resolved: sum('resolved'),
      closed: sum('closed'),
      reopened: reopened.rows[0].count,
      open_now: totals.rows[0].open_now,
      proactive: det.proactive ?? 0,
      reactive: det.reactive ?? 0,
    },
    flow: flow.rows,
    backlog: backlog.rows,
    lead_times: leadTimes.rows
      .filter((r) => r.known_error_count || r.resolved_count)
      .map((r) => ({
        priority: r.priority,
        known_error_count: r.known_error_count,
        known_error_median_h: round(r.known_error_median_h),
        known_error_p90_h: round(r.known_error_p90_h),
        resolved_count: r.resolved_count,
        resolved_median_h: round(r.resolved_median_h),
        resolved_p90_h: round(r.resolved_p90_h),
      })),
    closures: closures.rows,
    hotspots: { services: services.rows, categories: categories.rows, cis: cis.rows, ci_types: ciTypes.rows },
    incidents: { ...incidentStats.rows[0], mtta_median_min: round(incidentStats.rows[0].mtta_median_min), mttr_median_h: round(incidentStats.rows[0].mttr_median_h), by_ci: incidentCis.rows },
    known_errors: knownErrors.rows[0],
    actions: {
      created: a.created,
      completed: a.completed,
      on_time_rate: a.completed_with_due ? Math.round((a.completed_on_time / a.completed_with_due) * 100) : null,
      open_now: a.open_now,
      overdue_now: a.overdue_now,
    },
  };
}

export const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  // Neutralise spreadsheet formulas (CSV injection): text starting with = + - @ tab or CR is prefixed with '.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** All problems logged in, or active during, the period as CSV (one row per problem). */
export async function problemsCsv({ from, to }: ReportParams) {
  const { rows } = await query(
    `SELECT p.ref, p.title, p.status, p.priority, p.impact, p.urgency, p.is_major, p.detection, c.name AS category,
       p.affected_service, a.username AS assignee, p.created_at, p.known_error_at, p.resolved_at, p.closed_at, p.closure_code,
       p.ec_decision, p.workaround_effectiveness,
       (SELECT count(*) FROM problem_links l WHERE l.problem_id = p.id AND l.kind = 'incident') AS incidents,
       (SELECT count(*) FROM problem_links l WHERE l.problem_id = p.id AND l.kind = 'event') AS events,
       (SELECT count(*) FROM problem_actions x WHERE x.problem_id = p.id AND x.status = 'open') AS open_actions
     FROM problems p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN users a ON a.id = p.assignee_id
     WHERE p.created_at < $2::date + 1 AND coalesce(p.closed_at, 'infinity') >= $1::date
     ORDER BY p.id`,
    [from, to],
  );
  const columns = rows.length ? Object.keys(rows[0]) : ['ref'];
  return [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}
