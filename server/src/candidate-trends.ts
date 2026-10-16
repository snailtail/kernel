// Proactive problem candidates (part 2 of #31): trends in monitoring events and in changes, before they hurt. The same
// model as the rules in candidates.ts (Raw with a finish(records) that gives the reason), plus an evidence series per
// day. Imports from candidates.ts are types only, so the two modules load in either order.
import { z } from 'zod';
import type { EvidenceRecord, Raw, Series } from './candidates.js';
import type { Db } from './problems.js';

const days = (d: number, max = 30) => z.number().int().min(1).max(max).default(d);
const count = (n: number) => z.number().int().min(2).max(1000).default(n);

export const TREND_RULES = {
  flapping: {
    label: 'Flapping checks',
    description: 'A check that keeps clearing and firing again: reopened at least min_flaps times within window_days days.',
    detection: 'proactive',
    proactive: true,
    settings: z.object({ min_flaps: count(5), window_days: days(7) }),
  },
  rising_warnings: {
    label: 'Rising warnings on a CI',
    description: 'At least min_events warning or minor events on a CI in the last window_days days, and at least factor_percent % of the window before. Events during maintenance windows do not count.',
    detection: 'proactive',
    proactive: true,
    settings: z.object({ min_events: count(10), factor_percent: z.number().int().min(110).max(10000).default(200), window_days: days(7) }),
  },
  capacity_warnings: {
    label: 'Recurring capacity warnings',
    description: 'Disk, memory, storage or quota alerts on the same CI that fired at least min_firings times within window_days days.',
    detection: 'proactive',
    proactive: true,
    settings: z.object({ min_firings: count(3), window_days: days(30) }),
  },
  self_clearing: {
    label: 'Alerts that clear themselves',
    description: 'A check that fired at least min_firings times within window_days days and cleared on its own within max_minutes minutes each time, without anyone acknowledging it or an incident.',
    detection: 'proactive',
    proactive: true,
    settings: z.object({ min_firings: count(5), max_minutes: z.number().int().min(1).max(1440).default(30), window_days: days(14) }),
  },
  change_correlation: {
    label: 'Changes that fail or hurt',
    description: 'At least min_changes changes on a CI within window_days days, of which at least min_percent % failed, were rolled back, or were followed by an incident on the CI within within_hours hours.',
    detection: 'proactive',
    proactive: true,
    settings: z.object({
      min_changes: count(3), min_percent: z.number().int().min(1).max(100).default(50),
      within_hours: z.number().int().min(1).max(168).default(24), window_days: days(90, 365),
    }),
  },
} as const;
type Settings<R extends keyof typeof TREND_RULES> = z.infer<(typeof TREND_RULES)[R]['settings']>;

const LIMIT = 200;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const named = (name: string, ref: string | null) => (ref ? `${name} (${ref})` : name);
const day = (d: Date) => d.toISOString().slice(0, 10);

/** One value per day for the last `span` days (oldest first), zeros where nothing happened. */
function perDay(span: number, values: Map<string, number>): Series['points'] {
  const today = new Date();
  return Array.from({ length: span }, (_, i) => {
    const d = day(new Date(today.getTime() - (span - 1 - i) * 86_400_000));
    return { day: d, value: values.get(d) ?? 0 };
  });
}
const countBy = (dates: (string | null)[]) => {
  const m = new Map<string, number>();
  for (const d of dates) if (d) m.set(day(new Date(d)), (m.get(day(new Date(d))) ?? 0) + 1);
  return m;
};
/** Where the alerts are: the CI, or the host name the source gave when no CI matched. */
const where = (g: { ci_name: string | null; ci_ref: string | null; hint: string }) => (g.ci_name ? named(g.ci_name, g.ci_ref) : g.hint || 'an unmapped host');
const ALERT_JSON = `json_build_object('key', 'a:' || a.id, 'kind', 'event', 'id', NULL, 'incident_ref', NULL, 'alert_id', a.id, 'system', a.source,
  'reference', a.check_key, 'summary', a.message, 'category', '', 'occurred_at', a.first_seen, 'ci_ref', c.ref, 'note', NOTE)`;
/** Alerts that may count: not explained by a problem, not dismissed the old way, not suppressed (maintenance). */
// Kernel's own security alerts (#64) are for administrators and a security incident, not problem candidates.
const ALERT_OK = "a.problem_id IS NULL AND NOT a.candidate_dismissed AND a.suppressed = '' AND a.source <> 'Kernel security'";

const alertSubject = (g: any) => ({
  service: g.ci_name ?? '', ci_ref: g.ci_ref as string | null, ci_class: g.ci_class as string | null,
  cis: g.ci_ref ? [{ ref: g.ci_ref, name: g.ci_name, role: 'subject' as const }] : [],
});

/**
 * Checks that keep reopening. Kernel reopens an alert that fires again within the reopen window instead of starting
 * another (events.ts), and counts it in flap_count; the window here is on the alert's last activity.
 */
export async function flapping(db: Db, s: Settings<'flapping'>): Promise<Raw[]> {
  const { rows } = await db.query(
    `SELECT md5(a.source || '|' || a.dedupe_ci || '|' || a.check_key) AS identity, a.source, a.check_key, min(a.ci_hint) AS hint,
            c.ref AS ci_ref, c.name AS ci_name, c.class AS ci_class, sum(a.flap_count)::int AS flaps,
            json_agg(${ALERT_JSON.replace('NOTE', "a.flap_count || ' reopenings'")} ORDER BY a.last_seen DESC) AS records
     FROM alerts a LEFT JOIN configuration_items c ON c.id = a.ci_id
     WHERE ${ALERT_OK} AND a.flap_count > 0 AND a.last_seen > now() - $1 * interval '1 day'
     GROUP BY 1, 2, 3, c.id HAVING sum(a.flap_count) >= $2 ORDER BY sum(a.flap_count) DESC LIMIT ${LIMIT}`,
    [s.window_days, s.min_flaps],
  );
  if (!rows.length) return [];
  // The series: raw events per day for these alerts (kept for the raw retention, 14 days by default).
  const ids = rows.flatMap((g) => g.records.map((r: EvidenceRecord) => r.alert_id));
  const { rows: evs } = await db.query(
    `SELECT e.alert_id, e.occurred_at::date::text AS day, count(*)::int AS n FROM events e WHERE e.alert_id = ANY($1) AND e.occurred_at > now() - $2 * interval '1 day' GROUP BY 1, 2`,
    [ids, s.window_days],
  );
  return rows.map((g) => {
    const mine = new Set(g.records.map((r: EvidenceRecord) => Number(r.alert_id)));
    const byDay = new Map<string, number>();
    for (const e of evs.filter((x) => mine.has(Number(x.alert_id)))) byDay.set(e.day, (byDay.get(e.day) ?? 0) + e.n);
    return {
      key: `flapping:check:${g.identity.slice(0, 16)}`,
      rule: 'flapping' as const,
      subject: { type: 'check' as const, ref: g.ci_ref, name: `${g.check_key} on ${g.ci_name ?? (g.hint || 'unmapped host')}` },
      ...alertSubject(g),
      records: g.records,
      series: [{ label: 'Events per day', unit: 'events', points: perDay(s.window_days, byDay) }],
      title: () => `Flapping check ${g.check_key} on ${g.ci_name ?? (g.hint || 'an unmapped host')}`,
      // A dismissal holds until a new alert joins: reopenings of the same alert do not bring it back (snooze for that).
      finish: (rs: EvidenceRecord[]) => (rs.length
        ? `${g.check_key} from ${g.source} on ${where(g)} reopened ${g.flaps} times in ${s.window_days} days: it keeps clearing and firing again`
        : null),
    };
  });
}

/** Warning-level events per CI, this window against the one before, from the daily counts (kept long after raw events). */
export async function risingWarnings(db: Db, s: Settings<'rising_warnings'>): Promise<Raw[]> {
  const { rows } = await db.query(
    `WITH d AS (
       SELECT ci_id, day, sum(count - suppressed)::int AS n FROM event_daily
       WHERE ci_id <> 0 AND severity IN ('warning', 'minor') AND day > current_date - 2 * $1 GROUP BY 1, 2
     )
     SELECT c.id, c.ref AS ci_ref, c.name AS ci_name, c.class AS ci_class,
            coalesce(sum(n) FILTER (WHERE day > current_date - $1), 0)::int AS now_n,
            coalesce(sum(n) FILTER (WHERE day <= current_date - $1), 0)::int AS before_n,
            json_agg(json_build_object('day', day::text, 'n', n)) AS days
     FROM d JOIN configuration_items c ON c.id = d.ci_id
     GROUP BY c.id
     HAVING coalesce(sum(n) FILTER (WHERE day > current_date - $1), 0) >= $2
        AND coalesce(sum(n) FILTER (WHERE day > current_date - $1), 0) * 100 >= $3 * greatest(coalesce(sum(n) FILTER (WHERE day <= current_date - $1), 0), 1)
     ORDER BY 5 DESC LIMIT ${LIMIT}`,
    [s.window_days, s.min_events, s.factor_percent],
  );
  if (!rows.length) return [];
  // The evidence: the warning alerts on those CIs in this window that no problem explains yet.
  const { rows: alerts } = await db.query(
    `SELECT a.ci_id, ${ALERT_JSON.replace('NOTE', "a.severity || ', ' || a.count || ' events'")} AS record
     FROM alerts a JOIN configuration_items c ON c.id = a.ci_id
     WHERE ${ALERT_OK} AND a.ci_id = ANY($1) AND a.severity IN ('warning', 'minor') AND a.last_seen > now() - $2 * interval '1 day'
     ORDER BY a.last_seen DESC`,
    [rows.map((g) => g.id), s.window_days],
  );
  return rows.map((g) => {
    const byDay = new Map<string, number>(g.days.map((x: { day: string; n: number }) => [x.day, x.n]));
    const points = perDay(2 * s.window_days, byDay);
    const growth = g.before_n ? `${Math.round((g.now_n / g.before_n) * 100)} % of the ${s.window_days} days before (${g.before_n})` : `none in the ${s.window_days} days before`;
    return {
      key: `rising_warnings:ci:${g.ci_ref}`,
      rule: 'rising_warnings' as const,
      subject: { type: 'ci' as const, ref: g.ci_ref, name: g.ci_name },
      ...alertSubject(g),
      records: alerts.filter((a) => a.ci_id === g.id).map((a) => a.record),
      series: [{ label: 'Warnings per day', unit: 'events', points, split: points[s.window_days].day }],
      title: () => `Rising warnings on ${g.ci_name}`,
      finish: (rs: EvidenceRecord[]) => (rs.length ? `${plural(g.now_n, 'warning')} on ${named(g.ci_name, g.ci_ref)} in the last ${s.window_days} days, ${growth}` : null),
    };
  });
}

/** Words that mark a capacity check: disk, file system, memory, storage, quota… (PostgreSQL word-boundary regex). */
const CAPACITY = String.raw`\m(disk|filesystem|file system|volume|storage|inodes?|quota|capacity|memory|swap|heap|oom|out of memory)`;

export async function capacityWarnings(db: Db, s: Settings<'capacity_warnings'>): Promise<Raw[]> {
  const { rows } = await db.query(
    `SELECT a.dedupe_ci, md5(a.dedupe_ci) AS identity, min(a.ci_hint) AS hint, c.ref AS ci_ref, c.name AS ci_name, c.class AS ci_class,
            (count(*) + sum(a.flap_count))::int AS firings, array_agg(DISTINCT a.check_key) AS checks,
            json_agg(${ALERT_JSON.replace('NOTE', "a.severity")} ORDER BY a.first_seen DESC) AS records
     FROM alerts a LEFT JOIN configuration_items c ON c.id = a.ci_id
     WHERE ${ALERT_OK} AND a.first_seen > now() - $1 * interval '1 day' AND (a.check_key || ' ' || a.message) ~* $3
     GROUP BY a.dedupe_ci, c.id HAVING count(*) + sum(a.flap_count) >= $2 ORDER BY 7 DESC LIMIT ${LIMIT}`,
    [s.window_days, s.min_firings, CAPACITY],
  );
  return rows.map((g) => ({
    key: g.ci_ref ? `capacity_warnings:ci:${g.ci_ref}` : `capacity_warnings:host:${g.identity.slice(0, 16)}`,
    rule: 'capacity_warnings' as const,
    subject: { type: g.ci_ref ? ('ci' as const) : ('check' as const), ref: g.ci_ref, name: g.ci_name ?? (g.hint || 'unmapped host') },
    ...alertSubject(g),
    records: g.records,
    series: [{ label: 'Capacity alerts per day', unit: 'alerts', points: perDay(s.window_days, countBy(g.records.map((r: EvidenceRecord) => r.occurred_at))) }],
    title: () => `Recurring capacity warnings on ${g.ci_name ?? (g.hint || 'an unmapped host')}`,
    finish: (rs: EvidenceRecord[]) => (rs.length
      ? `Capacity alerts (${g.checks.slice(0, 3).join(', ')}${g.checks.length > 3 ? ', …' : ''}) fired ${g.firings} times on ${where(g)} in ${s.window_days} days: it will run out unless the cause is found`
      : null),
  }));
}

export async function selfClearing(db: Db, s: Settings<'self_clearing'>): Promise<Raw[]> {
  const { rows } = await db.query(
    `SELECT md5(a.source || '|' || a.dedupe_ci || '|' || a.check_key) AS identity, a.source, a.check_key, min(a.ci_hint) AS hint,
            c.ref AS ci_ref, c.name AS ci_name, c.class AS ci_class, count(*)::int AS firings,
            round(avg(extract(epoch FROM a.cleared_at - a.first_seen)) / 60)::int AS avg_minutes,
            json_agg(${ALERT_JSON.replace('NOTE', "'cleared after ' || greatest(1, round(extract(epoch FROM a.cleared_at - a.first_seen) / 60))::int || ' min'")} ORDER BY a.first_seen DESC) AS records
     FROM alerts a LEFT JOIN configuration_items c ON c.id = a.ci_id
     WHERE ${ALERT_OK} AND a.status = 'closed' AND a.cleared_at IS NOT NULL AND a.acknowledged_at IS NULL AND a.incident_id IS NULL
       AND a.first_seen > now() - $1 * interval '1 day' AND a.cleared_at - a.first_seen <= $3 * interval '1 minute'
     GROUP BY 1, 2, 3, c.id HAVING count(*) >= $2 ORDER BY count(*) DESC LIMIT ${LIMIT}`,
    [s.window_days, s.min_firings, s.max_minutes],
  );
  return rows.map((g) => ({
    key: `self_clearing:check:${g.identity.slice(0, 16)}`,
    rule: 'self_clearing' as const,
    subject: { type: 'check' as const, ref: g.ci_ref, name: `${g.check_key} on ${g.ci_name ?? (g.hint || 'unmapped host')}` },
    ...alertSubject(g),
    records: g.records,
    series: [{ label: 'Firings per day', unit: 'alerts', points: perDay(s.window_days, countBy(g.records.map((r: EvidenceRecord) => r.occurred_at))) }],
    title: () => `${g.check_key} on ${g.ci_name ?? (g.hint || 'an unmapped host')} keeps firing and clearing itself`,
    finish: (rs: EvidenceRecord[]) => (rs.length >= s.min_firings
      ? `${g.check_key} from ${g.source} on ${where(g)} fired ${plural(rs.length, 'time')} in ${s.window_days} days and cleared itself after ${g.avg_minutes} minutes on average, unnoticed`
      : null),
  }));
}

const OUTCOME: Record<string, string> = { failed: 'failed', rolled_back: 'rolled back', successful: 'successful' };

/**
 * Changes per CI that failed, were rolled back, or were followed by an incident on the same CI within `hours`.
 * Changes already linked to a problem are being looked at, so they do not count.
 */
export async function changeCorrelation(db: Db, s: Settings<'change_correlation'>): Promise<Raw[]> {
  const { rows: chs } = await db.query(
    `SELECT x.ci_id, c.ref AS ci_ref, c.name AS ci_name, c.class AS ci_class, ch.ref, ch.title, ch.outcome,
            coalesce(ch.actual_end, ch.actual_start, ch.closed_at) AS done
     FROM changes ch JOIN change_cis x ON x.change_id = ch.id JOIN configuration_items c ON c.id = x.ci_id
     WHERE ch.outcome IS NOT NULL AND coalesce(ch.actual_end, ch.actual_start, ch.closed_at) > now() - $1 * interval '1 day'
       AND NOT EXISTS (SELECT 1 FROM problem_links l WHERE l.kind = 'change' AND l.system = 'Kernel' AND l.reference = ch.ref)`,
    [s.window_days],
  );
  if (!chs.length) return [];
  const { rows: after } = await db.query(
    `SELECT DISTINCT ch.ref AS change_ref, x.ci_id, i.ref, i.title, i.created_at, i.problem_id IS NOT NULL AS linked
     FROM changes ch JOIN change_cis x ON x.change_id = ch.id JOIN incident_cis ic ON ic.ci_id = x.ci_id JOIN incidents i ON i.id = ic.incident_id
     WHERE ch.ref = ANY($1) AND i.created_at >= coalesce(ch.actual_end, ch.actual_start, ch.closed_at)
       AND i.created_at < coalesce(ch.actual_end, ch.actual_start, ch.closed_at) + $2 * interval '1 hour'`,
    [[...new Set(chs.map((c) => c.ref))], s.within_hours],
  );
  const byCi = new Map<number, any[]>();
  for (const c of chs) byCi.set(c.ci_id, [...(byCi.get(c.ci_id) ?? []), c]);
  const out: Raw[] = [];
  for (const [ciId, list] of byCi) {
    if (list.length < s.min_changes) continue;
    const { ci_ref, ci_name, ci_class } = list[0];
    const records: EvidenceRecord[] = [];
    for (const c of list.sort((a, b) => +new Date(b.done) - +new Date(a.done))) {
      const followed = after.filter((a) => a.change_ref === c.ref && a.ci_id === ciId);
      const failed = c.outcome !== 'successful';
      const note = [failed ? OUTCOME[c.outcome] : '', followed.length ? `followed by ${followed.map((f) => f.ref).join(', ')}` : ''].filter(Boolean).join(', ') || 'successful';
      records.push({ key: `c:${c.ref}`, kind: 'change', id: null, incident_ref: null, alert_id: null, change_ref: c.ref, system: 'Kernel', reference: c.ref,
        summary: c.title, category: '', occurred_at: c.done, ci_ref, note, bad: failed || followed.length > 0 });
      for (const f of followed) {
        if (records.some((r) => r.key === `i:${f.ref}`)) continue;
        records.push({ key: `i:${f.ref}`, kind: 'incident', id: null, incident_ref: f.ref, alert_id: null, system: 'Kernel', reference: f.ref,
          summary: f.title, category: '', occurred_at: f.created_at, ci_ref, note: `after ${c.ref}` });
      }
    }
    const verdict = (rs: EvidenceRecord[]) => {
      const changes = rs.filter((r) => r.kind === 'change'), bad = changes.filter((r) => r.bad);
      return { n: changes.length, bad: bad.length, ok: changes.length >= s.min_changes && bad.length > 0 && bad.length * 100 >= s.min_percent * changes.length };
    };
    if (!verdict(records).ok) continue;
    out.push({
      key: `change_correlation:ci:${ci_ref}`,
      rule: 'change_correlation',
      subject: { type: ci_class === 'service' ? 'service' : 'ci', ref: ci_ref, name: ci_name },
      service: ci_name, ci_ref, ci_class,
      records,
      cis: [{ ref: ci_ref, name: ci_name, role: 'subject' }],
      title: () => `Changes on ${ci_name} often fail or cause incidents`,
      finish: (rs) => {
        const v = verdict(rs);
        return v.ok ? `${v.bad} of ${plural(v.n, 'change')} on ${named(ci_name, ci_ref)} in ${s.window_days} days failed, were rolled back or were followed by an incident within ${s.within_hours} hours` : null;
      },
    });
    if (out.length >= LIMIT) break;
  }
  return out;
}
