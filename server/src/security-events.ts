// Security events (#64, A09:2025): who signed in or failed to, what was denied or blocked, which token turned up from
// a new address, who changed roles, credentials or settings, and who exported or revealed data. Each event is one
// structured line in the kernel.security log stream (for Elasticsearch/SIEM) and a row in security_events, which
// the admin view, MCP and the detection rules read. Nothing secret is stored: no credentials, no request bodies,
// and a sign-in name that matches no account only as a keyed digest (ADR 0001).
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { digestOf } from './audit.js';
import { config } from './config.js';
import { currentContext } from './context.js';
import { query } from './db.js';
import { logger } from './log.js';
import { minimiseData } from './minimise.js';
import { setBlockedSink } from './outbound.js';

export const SECURITY_CATEGORIES = ['authentication', 'authorization', 'iam', 'configuration', 'data_access', 'web', 'network', 'integrity', 'api'] as const;
export type SecurityCategory = (typeof SECURITY_CATEGORIES)[number];
export const SECURITY_OUTCOMES = ['success', 'failure', 'denied', 'blocked', 'info'] as const;
export type SecurityOutcome = (typeof SECURITY_OUTCOMES)[number];
type Severity = 'info' | 'warning' | 'minor' | 'major' | 'critical';

export interface SecurityEvent {
  /** Dotted name, e.g. auth.login_failed or authz.denied. */
  action: string;
  category: SecurityCategory;
  outcome: SecurityOutcome;
  /** Defaults to info for success/info and warning otherwise. */
  severity?: Severity;
  message: string;
  /** A sign-in name: resolved to the account's id, or kept only as a digest. */
  account?: string;
  userId?: number | null;
  /** The record ref, route or setting the event is about. */
  target?: string;
  /** Short, non-secret facts (minimised: long values become {changed: true}). */
  detail?: Record<string, unknown>;
  /** false: only the log line (routine, high-volume events such as MCP reads). */
  store?: boolean;
}

// The dataset sits in the event object itself: a child logger binding `event` would give the line two event keys.
const securityLog = logger;

/** Who and from where, from the request when there is one, else from the request context. */
export interface Origin { userId: number | null; actorType: string; channel: string; tokenPrefix: string; ip: string; country: string; userAgent: string; requestId: string }

export function originOf(req?: FastifyRequest): Origin {
  const ctx = currentContext();
  if (!req) return { userId: ctx.userId, actorType: ctx.actorType, channel: ctx.channel, tokenPrefix: ctx.tokenPrefix, ip: ctx.ip, country: ctx.country ?? '', userAgent: ctx.userAgent, requestId: ctx.requestId };
  const bearer = !!req.headers.authorization;
  const path = req.url.split('?')[0];
  return {
    userId: req.user?.id ?? null,
    actorType: !req.user ? 'anonymous' : bearer ? (path.startsWith('/mcp') ? 'mcp' : 'api_token') : 'user',
    channel: path.startsWith('/mcp') ? 'mcp' : bearer ? 'api' : 'web',
    tokenPrefix: req.tokenPrefix ?? '',
    ip: req.ip,
    // The visitor's country as Cloudflare saw it, only when the proxy chain is trusted to set the header.
    country: config.trustProxy ? String(req.headers['cf-ipcountry'] ?? '').slice(0, 2).toUpperCase().replace(/[^A-Z]/g, '') : '',
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
    requestId: String(req.id ?? ''),
  };
}

// A flood (a scanner, a script hammering a denied route) must not fill the table: per action and caller, at most
// this many rows a minute. The log line is still written, so the SIEM sees the full volume.
const PER_MINUTE = 30;
const recent = new Map<string, { n: number; until: number }>();
function admit(key: string) {
  const now = Date.now();
  const e = recent.get(key);
  if (!e || e.until <= now) {
    if (recent.size > 20_000) for (const [k, v] of recent) if (v.until <= now) recent.delete(k);
    recent.set(key, { n: 1, until: now + 60_000 });
    return true;
  }
  return ++e.n <= PER_MINUTE;
}

const pending = new Set<Promise<unknown>>();
/** Waits for queued writes (tests, and shutdown). */
export const flushSecurityEvents = async () => {
  while (pending.size) await Promise.allSettled([...pending]);
};

/**
 * Records a security event. It never throws and never delays the request: the row is written in the background,
 * outside any transaction, so a denied or rolled-back request still leaves its trace.
 */
export function securityEvent(e: SecurityEvent, req?: FastifyRequest, origin: Origin = originOf(req)) {
  const severity = e.severity ?? (e.outcome === 'success' || e.outcome === 'info' ? 'info' : 'warning');
  const detail = minimiseData(e.detail ?? {});
  const userId = e.userId !== undefined ? e.userId : origin.userId;
  securityLog[severity === 'info' ? 'info' : 'warn'](
    {
      event: { dataset: 'kernel.security', kind: 'event', category: [e.category], action: e.action, outcome: e.outcome, severity },
      ...(userId ? { user: { id: userId } } : {}),
      ...(origin.ip ? { source: { ip: origin.ip, ...(origin.country ? { geo: { country_iso_code: origin.country } } : {}) } } : {}),
      ...(origin.tokenPrefix ? { token: { prefix: origin.tokenPrefix } } : {}),
      ...(e.target ? { target: e.target } : {}),
      channel: origin.channel,
      request_id: origin.requestId || undefined,
      detail,
    },
    e.message,
  );
  if (e.store === false || !admit(`${e.action}|${userId ?? origin.ip}`)) return;
  const write = (async () => {
    let account = '';
    let uid = userId;
    if (e.account) {
      const name = e.account.trim().toLowerCase().slice(0, 200);
      const { rows } = await query('SELECT id FROM users WHERE lower(username) = $1', [name]);
      if (rows[0]) uid = uid ?? rows[0].id;
      else account = (digestOf(name) as { digest?: string }).digest ?? 'unknown account';
    }
    await query(
      `INSERT INTO security_events (action, category, outcome, severity, user_id, account, actor_type, channel, token_prefix, ip, country, user_agent, request_id, target, detail, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, nullif($10, ''), $11, $12, $13, $14, $15, $16)`,
      [e.action, e.category, e.outcome, severity, uid, account, origin.actorType, origin.channel, origin.tokenPrefix, origin.ip, origin.country,
        origin.userAgent, origin.requestId, (e.target ?? '').slice(0, 300), JSON.stringify(detail), e.message.slice(0, 500)],
    );
  })()
    .catch((err) => securityLog.error({ event: { dataset: 'kernel.security', action: e.action }, err: (err as Error).message }, 'security event not stored'))
    .finally(() => pending.delete(write));
  pending.add(write);
}

// ---- Events derived from the audit trail ---------------------------------------------------------

// Audited changes that matter for security, by entity type. Everything else in the audit trail is process work.
const AUDIT_CATEGORY: Record<string, SecurityCategory> = {
  session: 'authentication',
  user: 'iam',
  api_token: 'iam',
  setting: 'configuration',
  keys: 'configuration',
  webhook: 'configuration',
  connector: 'configuration',
  event_source: 'configuration',
  dev_source: 'configuration',
  ai_provider: 'configuration',
  sso: 'configuration',
  audit_log: 'integrity',
};
// Actions that are security relevant on any record: data access and overrides.
const DATA_ACCESS = new Set(['reveal', 'export', 'erase', 'break_glass', 'redact_history']);
const AUTH_ACTIONS = new Set(['login', 'logout', 'account_locked', 'mfa_enable', 'mfa_disable', 'mfa_reset', 'mfa_recovery_codes', 'password_change', 'passkey_added', 'passkey_removed', 'passkey_clone_suspected']);
const TEAM_ACTIONS = new Set(['paging', 'paging_removed', 'members']);

const MESSAGES: Record<string, string> = {
  'session.login': 'Signed in',
  'session.logout': 'Signed out',
  'session.account_locked': 'Account locked after repeated failed sign-ins',
  'user.create': 'User created',
  'user.update': 'User changed',
  'user.erase': 'User erased',
  'user.password_change': 'Password changed',
  'user.mfa_enable': 'Two-factor authentication turned on',
  'user.mfa_disable': 'Two-factor authentication turned off',
  'user.mfa_reset': 'Two-factor authentication reset by an administrator',
  'user.mfa_recovery_codes': 'New recovery codes generated',
  'user.passkey_added': 'Passkey added',
  'user.passkey_removed': 'Passkey removed',
  'user.passkey_clone_suspected': 'Passkey refused: it looks copied',
  'api_token.create': 'API token created',
  'api_token.revoke': 'API token revoked',
  'api_token.rotate': 'API token rotated',
};

/** Maps a committed audit entry to a security event, when it is one. */
export function fromAudit(entry: { entity_type: string; entity_ref?: string; action: string; changes?: Record<string, unknown> }, origin: Origin) {
  const { entity_type: type, action } = entry;
  let category = AUDIT_CATEGORY[type];
  if (AUTH_ACTIONS.has(action)) category = 'authentication';
  else if (DATA_ACCESS.has(action)) category = 'data_access';
  else if (type === 'team' && TEAM_ACTIONS.has(action)) category = action === 'members' ? 'iam' : 'configuration';
  if (!category) return;
  const changes = entry.changes ?? {};
  const role = changes.role as { from?: unknown; to?: unknown } | string | undefined;
  const newRole = typeof role === 'object' && role ? role.to : type === 'user' && action === 'create' ? role : undefined;
  const failure = action === 'account_locked' || action === 'passkey_clone_suspected';
  // Without an actor (a lock-out after failed sign-ins), the account the entry is about is the user.
  const subject = (type === 'session' || type === 'user') && /^#\d+$/.test(entry.entity_ref ?? '') ? Number(entry.entity_ref!.slice(1)) : null;
  if (origin.userId === null && subject) origin = { ...origin, userId: subject };
  securityEvent(
    {
      action: `${type}.${action}`,
      category,
      outcome: failure ? 'failure' : 'success',
      // A new administrator, a lock-out and a suspected cloned passkey deserve attention.
      severity: newRole === 'admin' || action === 'passkey_clone_suspected' ? 'minor' : failure ? 'warning' : undefined,
      message: MESSAGES[`${type}.${action}`] ?? `${type.replace(/_/g, ' ')}: ${action.replace(/_/g, ' ')}`,
      target: entry.entity_ref ?? '',
      // Which fields changed, never their values; a role change is the exception, as it is not personal.
      detail: { fields: Object.keys(changes).slice(0, 20), ...(newRole ? { role: newRole } : {}), ...(typeof role === 'object' && role ? { role_from: role.from } : {}) },
    },
    undefined,
    origin,
  );
}

// ---- Blocked outbound requests (SSRF protection) ------------------------------------------------

setBlockedSink((url, reason) => {
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    /* not a URL */
  }
  // Only the host: paths and query strings of configured URLs can carry tokens.
  securityEvent({ action: 'network.outbound_blocked', category: 'network', outcome: 'blocked', message: 'Outbound request blocked', target: host, detail: { reason: reason.slice(0, 200) } });
});

// ---- Responses: denials, rate limits and bad signatures ------------------------------------------

const HOOKS = /^\/api\/(event-hooks|dev-hooks|paging\/\d+\/inbound)/;
// Failures here are already recorded as sign-in failures, or are a signed-out browser asking who it is.
const QUIET_401 = new Set(['/api/auth/me', '/api/auth/login', '/api/auth/login/mfa', '/api/auth/passkey/login', '/api/auth/passkey/options', '/api/auth/mfa-pending', '/api/auth/sso/callback', '/api/meta']);

/** Records 401, 403 and 429 responses; registered as an onResponse hook on the root instance. */
export function recordResponse(req: FastifyRequest, reply: FastifyReply) {
  const status = reply.statusCode;
  if (status !== 401 && status !== 403 && status !== 429) return;
  if ((req as { prompt?: boolean }).prompt) return;
  const path = req.url.split('?')[0];
  if (!path.startsWith('/api/') && !path.startsWith('/mcp')) return;
  const route = req.routeOptions?.url ?? path;
  const ref = (req.params as { ref?: string } | undefined)?.ref;
  const target = `${req.method} ${route}${ref ? ` ${ref}` : ''}`.slice(0, 300);
  if (status === 429) {
    const login = path.startsWith('/api/auth/');
    return securityEvent({ action: login ? 'auth.throttled' : 'api.rate_limited', category: login ? 'authentication' : 'api', outcome: 'blocked', message: login ? 'Sign-in attempts throttled' : 'Rate limit reached', target }, req);
  }
  if (HOOKS.test(path)) return securityEvent({ action: 'webhook.signature_invalid', category: 'integrity', outcome: 'denied', message: 'Inbound webhook with an unknown token or invalid signature', target }, req);
  if (status === 401) {
    if (QUIET_401.has(path)) return;
    // A bearer token that matched nothing: wrong, revoked or expired, or someone guessing.
    if (req.headers.authorization && !req.user) return securityEvent({ action: 'auth.token_invalid', category: 'authentication', outcome: 'failure', message: 'Unknown, revoked or expired API token', target }, req);
    // Signed in, but a password, code or passkey confirming a sensitive action was wrong.
    if (req.user) return securityEvent({ action: 'auth.step_up_failed', category: 'authentication', outcome: 'failure', message: 'Re-authentication failed', target }, req);
    return securityEvent({ action: 'authn.required', category: 'authentication', outcome: 'denied', severity: 'info', message: 'Request without a valid session', target }, req);
  }
  securityEvent({ action: 'authz.denied', category: 'authorization', outcome: 'denied', message: 'Access denied', target }, req);
}

// ---- Reading ------------------------------------------------------------------------------------

export const securityQuerySchema = z.object({
  action: z.string().max(100).optional(),
  category: z.enum(SECURITY_CATEGORIES).optional(),
  outcome: z.enum(SECURITY_OUTCOMES).optional(),
  min_severity: z.enum(['info', 'warning', 'minor', 'major', 'critical']).optional(),
  user: z.string().max(100).optional().describe('Username or display name'),
  ip: z.string().max(60).optional(),
  token_prefix: z.string().max(40).optional(),
  target: z.string().max(100).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  before_id: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

const SEVERITY_RANK = "array_position(ARRAY['info','warning','minor','major','critical'], s.severity)";

export async function querySecurityEvents(f: z.infer<typeof securityQuerySchema>) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (f.action) add('s.action ILIKE ?', `%${f.action}%`);
  if (f.category) add('s.category = ?', f.category);
  if (f.outcome) add('s.outcome = ?', f.outcome);
  if (f.min_severity) add(`${SEVERITY_RANK} >= array_position(ARRAY['info','warning','minor','major','critical'], ?)`, f.min_severity);
  if (f.user) add("(u.username ILIKE ? OR u.display_name ILIKE ?)", `%${f.user}%`);
  if (f.ip) add('s.ip = ?', f.ip);
  if (f.token_prefix) add('s.token_prefix LIKE ?', `${f.token_prefix}%`);
  if (f.target) add('s.target ILIKE ?', `%${f.target}%`);
  if (f.from) add('s.at >= ?::timestamptz', f.from);
  if (f.to) add("s.at < ?::date + interval '1 day'", f.to);
  if (f.before_id) add('s.id < ?', f.before_id);
  params.push(f.limit);
  const { rows } = await query(
    `SELECT s.id, s.at, s.action, s.category, s.outcome, s.severity, s.user_id,
            CASE WHEN u.erased_at IS NOT NULL THEN 'deleted user #' || u.id ELSE u.display_name END AS user_name,
            CASE WHEN u.erased_at IS NULL THEN u.username END AS username,
            s.account, s.actor_type, s.channel, s.token_prefix, s.ip, s.country, s.user_agent, s.request_id, s.target, s.detail, s.message
     FROM security_events s LEFT JOIN users u ON u.id = s.user_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.id DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/** Counts for the last 24 hours, by outcome and by the most frequent actions, for the top of the admin view. */
export async function securitySummary() {
  const [outcomes, actions] = await Promise.all([
    query("SELECT outcome, count(*)::int AS n FROM security_events WHERE at > now() - interval '24 hours' GROUP BY outcome"),
    query(
      `SELECT action, outcome, count(*)::int AS n FROM security_events WHERE at > now() - interval '24 hours' AND outcome <> 'success' AND outcome <> 'info'
       GROUP BY action, outcome ORDER BY n DESC LIMIT 8`,
    ),
  ]);
  return { since: new Date(Date.now() - 86400_000).toISOString(), outcomes: Object.fromEntries(outcomes.rows.map((r) => [r.outcome, r.n])), top: actions.rows };
}

/** Retention: events, and the addresses tokens were seen from, are kept for privacy.security_event_days (365). */
export async function purgeSecurityEvents() {
  const days = "coalesce((SELECT (value->>'security_event_days')::int FROM settings WHERE key = 'privacy'), 365) * interval '1 day'";
  await query(`DELETE FROM security_events WHERE at < now() - ${days}`);
  await query(`DELETE FROM api_token_ips WHERE first_seen < now() - ${days}`);
}
