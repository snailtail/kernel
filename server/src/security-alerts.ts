// Security alerting (#64, part 2): built-in detection rules read security_events and report what they find to
// Kernel's own event management (#30) under the reserved source "Kernel security". From there an event rule opens a
// security incident – in the Security category and restricted to its team (ADR 0002) – and administrators are
// notified. The rules are fixed code with adjustable thresholds, never expressions, like the event rules.
//
// Rows are capped at 30 a minute per action and caller (security-events.ts); a summary row carries the rest in
// detail.suppressed, and every count here weighs rows by it, so a password spray is counted in full.
import { z } from 'zod';
import { audit } from './audit.js';
import { query, tx } from './db.js';
import { processEvents, SECURITY_SOURCE, type EventResult, type NormalisedEvent } from './events.js';
import { notify } from './notifications.js';
import { WEIGHT_SQL } from './security-events.js';

const threshold = (count: number, minutes: number) =>
  z.object({ enabled: z.boolean().default(true), threshold: z.number().int().min(2).max(100_000).default(count), window_minutes: z.number().int().min(1).max(1440).default(minutes) });
const toggle = () => z.object({ enabled: z.boolean().default(true) });

export const alertingSchema = z.object({
  enabled: z.boolean().default(true),
  /** Failed sign-ins (password, second factor, passkey, SSO, step-up) for one account, or from one address. */
  failed_sign_ins: threshold(10, 10).default({ enabled: true, threshold: 10, window_minutes: 10 }),
  /** Denied requests and invalid tokens from one token, user or address: someone probing refs or routes. */
  denials: threshold(20, 10).default({ enabled: true, threshold: 20, window_minutes: 10 }),
  /** Exports by one person (CSV, audit trail, records), or one export of at least `rows` rows. */
  bulk_export: threshold(5, 60).extend({ rows: z.number().int().min(10).max(10_000_000).default(1000) }).default({ enabled: true, threshold: 5, window_minutes: 60, rows: 1000 }),
  /** A sign-in from a country the account has not signed in from before (needs a trusted proxy, e.g. Cloudflare). */
  new_country: toggle().default({ enabled: true }),
  /** Someone became an administrator. */
  new_admin: toggle().default({ enabled: true }),
  /** Keys, single sign-on, AI providers, connectors, webhooks and event or dev sources changed. */
  credential_change: toggle().default({ enabled: true }),
});
export type Alerting = z.infer<typeof alertingSchema>;

export async function alertingSettings(): Promise<Alerting> {
  const { rows } = await query("SELECT value FROM settings WHERE key = 'security_alerting'");
  return alertingSchema.parse(rows[0]?.value ?? {});
}

// ---- The detection rules -------------------------------------------------------------------------

const SIGN_IN_FAILURES = ['auth.login_failed', 'auth.passkey_failed', 'auth.sso_failed', 'auth.step_up_failed'];
const DENIALS = ['authz.denied', 'auth.token_invalid'];
const CREDENTIALS = ['keys', 'sso', 'ai_provider', 'connector', 'webhook', 'event_source', 'dev_source'];

interface Detection { rule: keyof Omit<Alerting, 'enabled'>; check: string; severity: NormalisedEvent['severity']; message: string }

/** How an account appears in an alert: the username, or a short part of the digest of a name with no account. */
const ACCOUNT_SQL = `coalesce(u.username, CASE WHEN s.account <> '' THEN 'unknown account …' || right(s.account, 8) END)`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// Far above the threshold is no longer a few typos: one step up.
const graded = (n: number, t: number) => (n >= 5 * t ? 'major' : 'minor');

/** Counting rules: who crossed the threshold in the window, with at least one event since the last run. */
async function counting(cfg: Alerting, since: number): Promise<{ hits: Detection[]; checked: Set<Detection['rule']> }> {
  const hits: Detection[] = [];
  const checked = new Set<Detection['rule']>();
  const recent = 's.at > now() - $2 * interval \'1 minute\'';
  if (cfg.failed_sign_ins.enabled) {
    checked.add('failed_sign_ins');
    const { threshold: t, window_minutes: w } = cfg.failed_sign_ins;
    const { rows: byIp } = await query(
      `SELECT s.ip AS subject, sum(${WEIGHT_SQL})::int AS n, count(DISTINCT coalesce(s.user_id::text, nullif(s.account, '')))::int AS accounts,
              bool_or(s.detail ? 'suppressed') AS partial
       FROM security_events s WHERE s.action = ANY($1) AND ${recent} AND s.ip IS NOT NULL
       GROUP BY s.ip HAVING sum(${WEIGHT_SQL}) >= $3 AND max(s.id) > $4`,
      [SIGN_IN_FAILURES, w, t, since],
    );
    for (const r of byIp) {
      hits.push({
        rule: 'failed_sign_ins', check: `Failed sign-ins from ${r.subject}`, severity: graded(r.n, t),
        message: `${plural(r.n, 'failed sign-in')} in ${w} minutes from ${r.subject}${r.accounts > 1 ? `, against ${r.partial ? 'at least ' : ''}${r.accounts} accounts (password spraying?)` : ''}.`,
      });
    }
    const { rows: byAccount } = await query(
      `SELECT ${ACCOUNT_SQL} AS subject, sum(${WEIGHT_SQL})::int AS n, count(DISTINCT s.ip)::int AS addresses
       FROM security_events s LEFT JOIN users u ON u.id = s.user_id
       WHERE s.action = ANY($1) AND ${recent} AND (s.user_id IS NOT NULL OR s.account <> '')
       GROUP BY s.user_id, u.username, s.account HAVING sum(${WEIGHT_SQL}) >= $3 AND max(s.id) > $4`,
      [SIGN_IN_FAILURES, w, t, since],
    );
    for (const r of byAccount) {
      hits.push({
        rule: 'failed_sign_ins', check: `Failed sign-ins for ${r.subject}`, severity: graded(r.n, t),
        message: `${plural(r.n, 'failed sign-in')} in ${w} minutes for ${r.subject}${r.addresses > 1 ? `, from ${r.addresses} addresses` : ''}.`,
      });
    }
  }
  if (cfg.denials.enabled) {
    checked.add('denials');
    const { threshold: t, window_minutes: w } = cfg.denials;
    const { rows } = await query(
      `SELECT CASE WHEN s.token_prefix <> '' THEN 'token ' || s.token_prefix || '…' WHEN u.id IS NOT NULL THEN u.username ELSE s.ip END AS subject,
              sum(${WEIGHT_SQL})::int AS n, count(DISTINCT s.target)::int AS targets
       FROM security_events s LEFT JOIN users u ON u.id = s.user_id
       WHERE s.action = ANY($1) AND ${recent}
       GROUP BY 1 HAVING sum(${WEIGHT_SQL}) >= $3 AND max(s.id) > $4`,
      [DENIALS, w, t, since],
    );
    for (const r of rows.filter((r) => r.subject)) {
      hits.push({
        rule: 'denials', check: `Denied requests from ${r.subject}`, severity: graded(r.n, t),
        message: `${plural(r.n, 'denied or unauthenticated request')} in ${w} minutes from ${r.subject}, to ${plural(r.targets, 'route or record')}.`,
      });
    }
  }
  if (cfg.bulk_export.enabled) {
    checked.add('bulk_export');
    const { threshold: t, window_minutes: w, rows: big } = cfg.bulk_export;
    const { rows } = await query(
      `SELECT u.username AS subject, sum(${WEIGHT_SQL})::int AS n, max(coalesce((s.detail->>'rows')::int, 0))::int AS largest
       FROM security_events s JOIN users u ON u.id = s.user_id
       WHERE (s.action = 'data.export' OR s.action LIKE '%.export') AND s.at > now() - $1 * interval '1 minute'
       GROUP BY u.username HAVING (sum(${WEIGHT_SQL}) >= $2 OR max(coalesce((s.detail->>'rows')::int, 0)) >= $4) AND max(s.id) > $3`,
      [w, t, since, big],
    );
    for (const r of rows) {
      hits.push({
        rule: 'bulk_export', check: `Bulk export by ${r.subject}`, severity: 'minor',
        message: `${plural(r.n, 'export')} in ${w} minutes by ${r.subject}${r.largest >= big ? `, the largest with ${r.largest} rows` : ''}.`,
      });
    }
  }
  return { hits, checked };
}

/** One-off rules: each matching event since the last run is an alert of its own. */
async function oneOff(cfg: Alerting, since: number, until: number): Promise<Detection[]> {
  const hits: Detection[] = [];
  const range = 's.id > $1 AND s.id <= $2';
  if (cfg.new_admin.enabled) {
    const { rows } = await query(
      `SELECT s.target, t.username, a.username AS by FROM security_events s
       LEFT JOIN users t ON s.target IN ('#' || t.id, t.username) LEFT JOIN users a ON a.id = s.user_id
       WHERE ${range} AND s.action IN ('user.create', 'user.update') AND s.detail->>'role' = 'admin'`,
      [since, until],
    );
    for (const r of rows) {
      const who = r.username ?? `user ${r.target}`;
      hits.push({ rule: 'new_admin', check: `New administrator: ${who}`, severity: 'minor', message: `${who} became an administrator${r.by ? `, by ${r.by}` : ''}.` });
    }
  }
  if (cfg.credential_change.enabled) {
    const { rows } = await query(
      `SELECT s.action, s.target, s.message, u.username AS by FROM security_events s LEFT JOIN users u ON u.id = s.user_id
       WHERE ${range} AND split_part(s.action, '.', 1) = ANY($3) AND s.outcome = 'success'`,
      [since, until, CREDENTIALS],
    );
    for (const r of rows) {
      const what = `${r.action.split('.')[0].replace(/_/g, ' ')}${r.target ? ` ${r.target}` : ''}`;
      hits.push({ rule: 'credential_change', check: `Credentials changed: ${what}`, severity: 'warning', message: `${r.message}: ${what}${r.by ? `, by ${r.by}` : ''}.` });
    }
  }
  if (cfg.new_country.enabled) {
    // Only for an account with history: its first sign-in with a known country is not "new".
    const { rows } = await query(
      `SELECT u.username, s.country FROM security_events s JOIN users u ON u.id = s.user_id
       WHERE ${range} AND s.action = 'session.login' AND s.country <> ''
         AND NOT EXISTS (SELECT 1 FROM security_events p WHERE p.action = 'session.login' AND p.user_id = s.user_id AND p.country = s.country AND p.id < s.id)
         AND EXISTS (SELECT 1 FROM security_events p WHERE p.action = 'session.login' AND p.user_id = s.user_id AND p.country <> '' AND p.id < s.id)`,
      [since, until],
    );
    for (const r of rows) {
      hits.push({ rule: 'new_country', check: `Sign-in from a new country: ${r.username} (${r.country})`, severity: 'minor', message: `${r.username} signed in from ${r.country}, a country this account has not signed in from before.` });
    }
  }
  return hits;
}

// ---- Running them --------------------------------------------------------------------------------

const CHECK_PREFIX: Partial<Record<Detection['rule'], string[]>> = {
  failed_sign_ins: ['Failed sign-ins from ', 'Failed sign-ins for '],
  denials: ['Denied requests from '],
  bulk_export: ['Bulk export by '],
};

/** Moves the cursor over the events written since the last run; null when another instance holds it. */
async function claimRange(): Promise<{ since: number; until: number } | null> {
  return tx(async (db) => {
    const { rows: lock } = await db.query('SELECT pg_try_advisory_xact_lock(8302) AS ok');
    if (!lock[0].ok) return null;
    const { rows: cur } = await db.query("SELECT (value->>'last_id')::bigint AS id FROM settings WHERE key = 'security_alert_cursor'");
    // A few seconds' margin: rows are written in the background and may commit slightly out of id order.
    const { rows: max } = await db.query("SELECT max(id) AS id FROM security_events WHERE at < now() - interval '5 seconds'");
    const since = Number(cur[0]?.id ?? 0);
    const until = Math.max(since, Number(max[0].id ?? 0));
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('security_alert_cursor', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [JSON.stringify({ last_id: until })],
    );
    return { since, until };
  });
}

/** One run: detect, report to event management, clear what fell below its threshold, notify administrators. */
export async function runSecurityAlerting(): Promise<EventResult[]> {
  const cfg = await alertingSettings();
  if (!cfg.enabled) return [];
  const range = await claimRange();
  if (!range) return [];
  const { hits, checked } = await counting(cfg, range.since);
  hits.push(...(range.until > range.since ? await oneOff(cfg, range.since, range.until) : []));
  // A counting alert clears once its subject is back under the threshold; one-off alerts wait for a person.
  const { rows: open } = await query("SELECT check_key FROM alerts WHERE source = $1 AND status = 'open'", [SECURITY_SOURCE]);
  const firing = new Set(hits.map((h) => h.check));
  const stillOver = await stillOverThreshold(cfg, open.map((a) => a.check_key));
  const clears = open
    .map((a) => a.check_key as string)
    .filter((c) => !firing.has(c) && !stillOver.has(c) && [...checked].some((r) => CHECK_PREFIX[r]?.some((p) => c.startsWith(p))));
  const events: NormalisedEvent[] = [
    ...hits.map((h) => ({ check: h.check.slice(0, 200), severity: h.severity, message: h.message })),
    ...clears.map((c) => ({ check: c, severity: 'clear' as const, message: '' })),
  ];
  if (!events.length) return [];
  const results = await processEvents(SECURITY_SOURCE, '', events, true);
  await notifyAdmins(hits, results);
  return results;
}

/** Open counting alerts whose subject is still over its threshold, though nothing new arrived since the last run. */
async function stillOverThreshold(cfg: Alerting, checks: string[]) {
  const over = new Set<string>();
  if (!checks.length) return over;
  const { hits } = await counting(cfg, 0);
  for (const h of hits) over.add(h.check);
  return over;
}

const FRESH = new Set(['opened', 'reopened', 'incident_created', 'incident_grouped', 'incident_reopened', 'rate_limited', 'no_security_team']);

async function notifyAdmins(hits: Detection[], results: EventResult[]) {
  const fresh = results.map((r, n) => ({ r, h: hits[n] })).filter(({ r, h }) => h && FRESH.has(r.outcome));
  if (!fresh.length) return;
  await tx(async (db) => {
    const { rows } = await db.query("SELECT id FROM users WHERE active AND role = 'admin' AND erased_at IS NULL");
    for (const { r, h } of fresh) {
      await notify(db, {
        users: rows.map((u) => u.id),
        event: 'security_alert',
        // Not the incident: it is restricted to its team, and administrators reach it only through break-glass.
        ref: '',
        title: h.check,
        summary: h.message,
        path: '/admin/security-events',
        dedupe: `security_alert:${r.alert_id}:${Date.now()}`,
      });
    }
  });
}

export function startSecurityAlertWorker(log: (msg: string) => void) {
  setInterval(() => runSecurityAlerting().catch((err) => log(`security alerting failed: ${err.message}`)), 60_000).unref();
}

// ---- Settings and the admin view -----------------------------------------------------------------

export async function saveAlertingSettings(value: Alerting, reason: string) {
  const before = await alertingSettings();
  await query("INSERT INTO settings (key, value) VALUES ('security_alerting', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [JSON.stringify(value)]);
  await audit(null, { entity_type: 'setting', entity_ref: 'security_alerting', action: 'update', changes: { from: before, to: value }, reason });
  return alertingStatus();
}

/** The settings, the event rule that turns security alerts into incidents (and its team), and the open alerts. */
export async function alertingStatus() {
  const [settings, rules, open] = await Promise.all([
    alertingSettings(),
    query(
      `SELECT r.id, r.name, r.enabled, r.conditions->>'min_severity' AS min_severity, coalesce(t.id, g.id) AS team_id, coalesce(t.name, g.name) AS team_name
       FROM event_rules r LEFT JOIN teams t ON t.id = r.team_id
       LEFT JOIN teams g ON r.team_id IS NULL AND r.assignment_group <> '' AND lower(g.name) = lower(trim(r.assignment_group)) AND g.active
       WHERE r.conditions->'sources' ? $1 ORDER BY r.position, r.id`,
      [SECURITY_SOURCE],
    ),
    query(
      `SELECT a.id, a.check_key, a.severity, a.message, a.count, a.first_seen, a.last_seen, a.acknowledged_at, i.ref AS incident_ref
       FROM alerts a LEFT JOIN incidents i ON i.id = a.incident_id WHERE a.source = $1 AND a.status = 'open' ORDER BY a.last_seen DESC LIMIT 50`,
      [SECURITY_SOURCE],
    ),
  ]);
  return { settings, source: SECURITY_SOURCE, rules: rules.rows, open_alerts: open.rows };
}
