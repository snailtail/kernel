// The cross-practice dashboard (#54): a few KPIs for service owners and managers, each with a trend over the last six
// periods, how it is calculated and the list behind it. Read through row-level security like everything else, so the
// numbers are what the reader may see (managers are told when restricted records are left out).
import { z } from 'zod';
import type { User } from '../security/auth.js';
import { query } from '../core/db.js';
import { moduleEnabled } from '../core/modules.js';
import { authorize, can } from '../security/policy.js';
import { hiddenRecordsExist } from '../security/visibility.js';

export const TILES = ['mttr', 'sla', 'change_success', 'recurring', 'problems_resolved', 'major_open', 'requests_fulfilled', 'satisfaction', 'points_done', 'unplanned_work', 'fix_lead_time', 'recurred_after_fix'] as const;
type TileId = (typeof TILES)[number];
const PERIODS = 6;

export const kpiSchema = z.object({ period: z.enum(['month', 'week']).default('month') });

interface Tile {
  id: TileId;
  label: string;
  /** The latest period's value (or the current one, for "open now" tiles). */
  value: number | null;
  unit: 'minutes' | 'percent' | 'count';
  /** One value per period, oldest first, the last being the current (partial) period. */
  trend: (number | null)[];
  trend_label: string;
  /** Smaller numbers are better (for colouring the change). */
  lower_is_better: boolean;
  detail: string;
  basis: string;
  link: string;
}

const pct = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 10 : null);
const dur = (m: number | null) => (m === null ? '–' : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`);

export async function kpis(user: User, { period }: z.infer<typeof kpiSchema>) {
  authorize(user, 'report.read');
  // A tile shows only when its practice is on and the reader may read it; nothing is counted from the rest.
  const incident = moduleEnabled('incident') && can(user.role, 'incident.read');
  const change = moduleEnabled('change') && can(user.role, 'change.read');
  const problem = can(user.role, 'problem.read');
  // Service requests (#44) never count in the incident tiles; they get their own tile when the module is on.
  const request = moduleEnabled('request') && can(user.role, 'request.read');
  // The last six periods, the current (partial) one last. $1 = 'month' | 'week'.
  const P = `WITH p AS (
    SELECT gs AS start, gs + ('1 ' || $1)::interval AS stop
    FROM generate_series(date_trunc($1, now()) - ('1 ' || $1)::interval * ${PERIODS - 1}, date_trunc($1, now()), ('1 ' || $1)::interval) gs)`;
  const none = { rows: [] as any[] };
  // How people rated their closed tickets in the portal (#45): only while the portal is on.
  const portal = moduleEnabled('portal') && (incident || request);
  // Development work (#166): only with the module on.
  const development = moduleEnabled('development') && can(user.role, 'work.read');
  // Closing the loop between a problem and its fix (#167): changes carry the fix, through the problem's bugs or not.
  const fixes = development && change && problem;
  const [periods, resolved, changes, recurring, problems, knownErrors, major, requests, ratings, done, sprints, fixed, recurred] = await Promise.all([
    query(`${P} SELECT start::date::text AS start FROM p ORDER BY start`, [period]),
    incident
      ? query(
          `${P} SELECT p.start::date::text AS start, i.priority, count(*)::int AS resolved,
             sum(extract(epoch FROM i.resolved_at - i.created_at) / 60)::float AS minutes,
             count(*) FILTER (WHERE i.resolution_due_at IS NOT NULL)::int AS with_target,
             count(*) FILTER (WHERE i.resolution_due_at IS NOT NULL AND i.resolution_breached_at IS NULL AND i.resolved_at <= i.resolution_due_at)::int AS met
           FROM p JOIN incidents i ON i.resolved_at >= p.start AND i.resolved_at < p.stop
           GROUP BY 1, 2`,
          [period],
        )
      : none,
    change
      ? query(
          `${P} SELECT p.start::date::text AS start,
             count(c.id) FILTER (WHERE c.outcome IS NOT NULL)::int AS implemented,
             count(c.id) FILTER (WHERE c.outcome = 'successful')::int AS successful,
             count(c.id) FILTER (WHERE c.actual_start IS NOT NULL AND EXISTS (
               SELECT 1 FROM change_cis x JOIN incident_cis y ON y.ci_id = x.ci_id JOIN incidents i ON i.id = y.incident_id
               WHERE x.change_id = c.id AND i.created_at BETWEEN c.actual_start AND c.actual_start + interval '24 hours'))::int AS followed
           FROM p LEFT JOIN changes c ON c.outcome IS NOT NULL AND c.actual_end >= p.start AND c.actual_end < p.stop
           GROUP BY 1`,
          [period],
        )
      : none,
    // Recurring: CIs or categories with three or more incidents in the 30 days up to the end of the period, none of
    // them linked to a problem. Counted per CI and per category (a cluster may show in both). Only with problems on.
    incident && problem
      ? query(
          `${P} SELECT p.start::date::text AS start, (
             SELECT count(*) FROM (
               SELECT x.ci_id FROM incidents i JOIN incident_cis x ON x.incident_id = i.id
               WHERE i.problem_id IS NULL AND i.created_at > least(p.stop, now()) - interval '30 days' AND i.created_at <= least(p.stop, now())
               GROUP BY x.ci_id HAVING count(DISTINCT i.id) >= 3
               UNION ALL
               SELECT i.category_id FROM incidents i
               WHERE i.category_id IS NOT NULL AND i.problem_id IS NULL AND i.created_at > least(p.stop, now()) - interval '30 days' AND i.created_at <= least(p.stop, now())
               GROUP BY i.category_id HAVING count(*) >= 3
             ) g)::int AS clusters
           FROM p`,
          [period],
        )
      : none,
    problem ? query(`${P} SELECT p.start::date::text AS start, count(x.id)::int AS resolved FROM p LEFT JOIN problems x ON x.resolved_at >= p.start AND x.resolved_at < p.stop GROUP BY 1`, [period]) : none,
    problem ? query("SELECT count(*)::int AS known_errors, count(*) FILTER (WHERE workaround <> '')::int AS with_workaround FROM problems WHERE status = 'known_error'") : none,
    incident
      ? query(
          `${P} SELECT p.start::date::text AS start, count(i.id)::int AS declared,
             (SELECT count(*) FROM incidents o WHERE o.is_major AND o.status NOT IN ('resolved', 'closed'))::int AS open_now
           FROM p LEFT JOIN incidents i ON i.is_major AND coalesce(i.major_declared_at, i.created_at) >= p.start AND coalesce(i.major_declared_at, i.created_at) < p.stop
           GROUP BY 1`,
          [period],
        )
      : none,
    request
      ? query(
          `${P} SELECT p.start::date::text AS start, count(r.id)::int AS fulfilled,
             count(r.id) FILTER (WHERE r.resolution_due_at IS NOT NULL)::int AS with_target,
             count(r.id) FILTER (WHERE r.resolution_due_at IS NOT NULL AND r.resolution_breached_at IS NULL AND r.resolved_at <= r.resolution_due_at)::int AS met
           FROM p LEFT JOIN requests r ON r.status = 'fulfilled' AND r.resolved_at >= p.start AND r.resolved_at < p.stop
           GROUP BY 1`,
          [period],
        )
      : none,
    portal
      ? query(
          `${P} SELECT p.start::date::text AS start, count(f.id)::int AS total,
             count(f.id) FILTER (WHERE f.rating = 'good')::int AS good, count(f.id) FILTER (WHERE f.rating = 'okay')::int AS okay,
             count(f.id) FILTER (WHERE f.rating = 'bad')::int AS bad
           FROM p LEFT JOIN portal_feedback f ON f.created_at >= p.start AND f.created_at < p.stop
             AND (f.incident_id IS NULL OR $2) AND (f.request_id IS NULL OR $3)
           GROUP BY 1`,
          [period, incident, request],
        )
      : none,
    development
      ? query(
          `${P} SELECT p.start::date::text AS start, coalesce(sum(w.points), 0)::int AS points, count(w.id)::int AS items
           FROM p LEFT JOIN work_items w ON w.status = 'done' AND w.type <> 'epic' AND w.done_at >= p.start AND w.done_at < p.stop
           GROUP BY 1`,
          [period],
        )
      : none,
    // A completed sprint's stays keep their points and outcome (development/sprints.ts), so these do not move later.
    development
      ? query(
          `${P} SELECT p.start::date::text AS start, count(DISTINCT s.id)::int AS sprints,
             coalesce(sum(si.points) FILTER (WHERE si.outcome IS NOT NULL), 0)::int AS scope,
             coalesce(sum(si.points) FILTER (WHERE si.outcome IS NOT NULL AND si.unplanned), 0)::int AS unplanned
           FROM p LEFT JOIN sprints s ON s.status = 'completed' AND s.completed_at >= p.start AND s.completed_at < p.stop
           LEFT JOIN sprint_items si ON si.sprint_id = s.id
           GROUP BY 1`,
          [period],
        )
      : none,
    // Problems whose fix was deployed in the period (migration 161), from the known error to the deploy.
    fixes
      ? query(
          `${P} SELECT p.start::date::text AS start, count(x.id)::int AS fixed,
             avg(extract(epoch FROM d.deployed_at - x.known_error_at) / 60)::float AS minutes
           FROM p LEFT JOIN (problem_fix_deployed d JOIN problems x ON x.id = d.problem_id AND x.known_error_at IS NOT NULL)
             ON d.deployed_at >= p.start AND d.deployed_at < p.stop
           GROUP BY 1`,
          [period],
        )
      : none,
    // Incidents logged in the period on a problem whose fix was already deployed.
    fixes && incident
      ? query(
          `${P} SELECT p.start::date::text AS start, count(i.id)::int AS incidents, count(DISTINCT i.problem_id)::int AS problems
           FROM p LEFT JOIN (incidents i JOIN problem_fix_deployed d ON d.problem_id = i.problem_id AND i.created_at > d.deployed_at)
             ON i.created_at >= p.start AND i.created_at < p.stop
           GROUP BY 1`,
          [period],
        )
      : none,
  ]);
  const starts: string[] = periods.rows.map((r) => r.start);
  const per = <T>(rows: any[], f: (rs: any[]) => T) => starts.map((s) => f(rows.filter((r) => r.start === s)));
  const last = <T>(xs: T[]) => xs[xs.length - 1];
  const unit = period === 'month' ? 'month' : 'week';
  const tiles: Tile[] = [];

  if (incident) {
    const mttr = per(resolved.rows, (rs) => {
      const n = rs.reduce((a, r) => a + r.resolved, 0);
      return n ? Math.round(rs.reduce((a, r) => a + r.minutes, 0) / n) : null;
    });
    const current = resolved.rows.filter((r) => r.start === last(starts)).sort((a, b) => a.priority - b.priority);
    tiles.push({
      id: 'mttr', label: 'Mean time to resolve', value: last(mttr), unit: 'minutes', trend: mttr, trend_label: `per ${unit}`, lower_is_better: true,
      detail: current.map((r) => `P${r.priority} ${dur(Math.round(r.minutes / r.resolved))}`).join(' · ') || `Nothing resolved this ${unit}.`,
      basis: `The mean time from logging to resolution of incidents resolved in the ${unit}, all priorities; per priority below.`,
      link: '/incidents?status=resolved',
    });
    if (moduleEnabled('sla')) {
      const sla = per(resolved.rows, (rs) => pct(rs.reduce((a, r) => a + r.met, 0), rs.reduce((a, r) => a + r.with_target, 0)));
      const of = resolved.rows.filter((r) => r.start === last(starts)).reduce((a, r) => a + r.with_target, 0);
      tiles.push({
        id: 'sla', label: 'Resolved within SLA', value: last(sla), unit: 'percent', trend: sla, trend_label: `per ${unit}`, lower_is_better: false,
        detail: of ? `${of} incidents with a resolution target this ${unit}.` : `No incidents with a resolution target this ${unit}.`,
        basis: `Incidents resolved in the ${unit} with a resolution target: the share resolved by the target and never breached.`,
        link: '/reports',
      });
    }
  }
  if (change) {
    const success = per(changes.rows, (rs) => pct(rs[0]?.successful ?? 0, rs[0]?.implemented ?? 0));
    const now = changes.rows.find((r) => r.start === last(starts));
    tiles.push({
      id: 'change_success', label: 'Change success rate', value: last(success), unit: 'percent', trend: success, trend_label: `per ${unit}`, lower_is_better: false,
      detail: now?.implemented ? `${now.successful} of ${now.implemented} successful · ${now.followed} followed by an incident within 24 h` : `No changes completed this ${unit}.`,
      basis: `Changes completed in the ${unit} (by actual end) that were successful. "Followed by an incident": an incident on one of the change's CIs within 24 hours of its start.`,
      link: '/changes?status=all',
    });
  }
  if (incident && problem) {
    const clusters = per(recurring.rows, (rs) => rs[0]?.clusters ?? 0);
    tiles.push({
      id: 'recurring', label: 'Recurring incidents', value: last(clusters), unit: 'count', trend: clusters, trend_label: `at the end of each ${unit}`, lower_is_better: true,
      detail: last(clusters) ? 'CIs or categories that keep breaking without a problem.' : 'Nothing recurs without a problem.',
      basis: 'CIs and categories with 3 or more incidents in the last 30 days, none of them linked to a problem (counted per CI and per category).',
      link: '/candidates',
    });
  }
  if (problem) {
    const resolvedProblems = per(problems.rows, (rs) => rs[0]?.resolved ?? 0);
    const ke = knownErrors.rows[0];
    tiles.push({
      id: 'problems_resolved', label: 'Problems resolved', value: last(resolvedProblems), unit: 'count', trend: resolvedProblems, trend_label: `per ${unit}`, lower_is_better: false,
      detail: `${ke.with_workaround} of ${ke.known_errors} known errors have a workaround.`,
      basis: `Problems resolved in the ${unit}. Known errors: open known errors now, and how many have a workaround written down.`,
      link: '/problems?status=resolved',
    });
  }
  if (incident) {
    const declared = per(major.rows, (rs) => rs[0]?.declared ?? 0);
    tiles.push({
      id: 'major_open', label: 'Open major incidents', value: major.rows[0]?.open_now ?? 0, unit: 'count', trend: declared, trend_label: `declared per ${unit}`, lower_is_better: true,
      detail: `${last(declared)} declared this ${unit}.`,
      basis: `Major incidents not yet resolved, now. The trend counts major incidents declared per ${unit}.`,
      link: '/incidents?major=true',
    });
  }
  if (request) {
    const fulfilled = per(requests.rows, (rs) => rs[0]?.fulfilled ?? 0);
    const now = requests.rows.find((r) => r.start === last(starts));
    tiles.push({
      id: 'requests_fulfilled', label: 'Requests fulfilled', value: last(fulfilled), unit: 'count', trend: fulfilled, trend_label: `per ${unit}`, lower_is_better: false,
      detail: now?.with_target ? `${now.met} of ${now.with_target} within their SLA.` : `No requests with a target fulfilled this ${unit}.`,
      basis: `Service requests fulfilled in the ${unit}, and how many within their SLA. Requests never count as incidents.`,
      link: '/requests?status=fulfilled',
    });
  }
  if (portal) {
    const good = per(ratings.rows, (rs) => pct(rs[0]?.good ?? 0, rs[0]?.total ?? 0));
    const now = ratings.rows.find((r) => r.start === last(starts));
    tiles.push({
      id: 'satisfaction', label: 'Satisfaction', value: last(good), unit: 'percent', trend: good, trend_label: `rated good per ${unit}`, lower_is_better: false,
      detail: now?.total ? `${now.good} good, ${now.okay} okay, ${now.bad} not good, of ${now.total} ratings.` : `No ratings this ${unit}.`,
      basis: `The share of ratings that were "good", from the one-click question people get in the portal when their ticket is closed.`,
      link: '/incidents?status=closed',
    });
  }
  if (development) {
    const points = per(done.rows, (rs) => rs[0]?.points ?? 0);
    const now = done.rows.find((r) => r.start === last(starts));
    tiles.push({
      id: 'points_done', label: 'Story points done', value: last(points), unit: 'count', trend: points, trend_label: `per ${unit}`, lower_is_better: false,
      detail: `${now?.items ?? 0} stories, bugs and tasks finished this ${unit}.`,
      basis: `The story points of work items finished in the ${unit}, in sprints or on a Kanban board: the teams' velocity over time.`,
      link: '/work?status=done',
    });
    const unplanned = per(sprints.rows, (rs) => pct(rs[0]?.unplanned ?? 0, rs[0]?.scope ?? 0));
    const sprintsNow = sprints.rows.find((r) => r.start === last(starts));
    tiles.push({
      id: 'unplanned_work', label: 'Unplanned work', value: last(unplanned), unit: 'percent', trend: unplanned, trend_label: `per ${unit}`, lower_is_better: true,
      detail: sprintsNow?.sprints ? `${sprintsNow.unplanned} of ${sprintsNow.scope} points in ${sprintsNow.sprints} completed sprint${sprintsNow.sprints === 1 ? '' : 's'} came after the start.` : `No sprints completed this ${unit}.`,
      basis: `Sprints completed in the ${unit}: the share of their points that were added after the sprint started.`,
      link: '/work',
    });
  }
  if (fixes) {
    const lead = per(fixed.rows, (rs) => (rs[0]?.fixed ? Math.round(rs[0].minutes) : null));
    const now = fixed.rows.find((r) => r.start === last(starts));
    tiles.push({
      id: 'fix_lead_time', label: 'Time to deploy a fix', value: last(lead), unit: 'minutes', trend: lead, trend_label: `per ${unit}`, lower_is_better: true,
      detail: now?.fixed ? `${now.fixed} problem${now.fixed === 1 ? '' : 's'} got the fix deployed this ${unit}.` : `No fixes deployed this ${unit}.`,
      basis: `Problems whose fix was deployed in the ${unit}: the mean time from the known error to the last successful change that carries the fix, once its bugs and stories are done.`,
      link: '/problems?status=resolved',
    });
    if (incident) {
      const again = per(recurred.rows, (rs) => rs[0]?.incidents ?? 0);
      const now = recurred.rows.find((r) => r.start === last(starts));
      tiles.push({
        id: 'recurred_after_fix', label: 'Incidents after the fix', value: last(again), unit: 'count', trend: again, trend_label: `per ${unit}`, lower_is_better: true,
        detail: now?.incidents ? `On ${now.problems} problem${now.problems === 1 ? '' : 's'} whose fix was already deployed.` : `No incidents on fixed problems this ${unit}.`,
        basis: `Incidents logged in the ${unit} and linked to a problem whose fix had already been deployed: the fix did not hold, or the problem was wider.`,
        link: '/problems',
      });
    }
  }
  return {
    period: { unit: period, starts },
    tiles,
    restricted_records_left_out: ['admin', 'manager'].includes(user.role) ? await hiddenRecordsExist() : false,
  };
}
