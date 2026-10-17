import { createHash, randomBytes } from 'node:crypto';
import { notify } from './notifications.js';
import bcrypt from 'bcryptjs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { pool, query } from './db.js';
import { forbidden, HttpError } from './errors.js';
import { audit } from './audit.js';
import { mfaRequiredFor } from './mfapolicy.js';
import { authorize, type Action } from './policy.js';
import { checkSameOrigin } from './security.js';
import { originOf, securityEvent } from './security-events.js';
import type { Role } from './workflow.js';

export interface User {
  id: number;
  username: string;
  display_name: string;
  email: string;
  role: Role;
  preferences: Preferences;
  must_change_password: boolean;
  mfa_enabled: boolean;
}

export interface Preferences {
  theme?: 'system' | 'light' | 'dark';
  /** Step-by-step guidance through the process; on unless turned off. */
  guided?: boolean;
  intro_seen?: boolean;
  /** Show others when I have a record open (#70); on unless turned off. */
  live_presence?: boolean;
  nav_collapsed?: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
    /** Scopes of the API token used, if the request was token-authenticated. */
    tokenScopes?: string[];
    tokenPrefix?: string;
  }
}

export const SESSION_COOKIE = 'kernel_session';
const USER_COLUMNS = 'u.id, u.username, u.display_name, u.email, u.role, u.preferences, u.must_change_password, u.mfa_enabled_at IS NOT NULL AS mfa_enabled';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export const hashPassword = (password: string) => bcrypt.hash(password, 12);

export async function verifyLogin(username: string, password: string): Promise<User | null> {
  const { rows } = await query(
    `SELECT ${USER_COLUMNS}, u.password_hash FROM users u WHERE lower(u.username) = lower($1) AND u.active`,
    [username],
  );
  // Compare against a dummy hash for unknown users so timing does not reveal which usernames exist.
  const hash = rows[0]?.password_hash ?? '$2b$12$C6UzMDM.H6dfI/f/IKcEeO5h0mJ0aXz4m3Q1pQ0b1aQO2yE6K7XGu';
  const ok = await bcrypt.compare(password, hash);
  if (!ok || !rows[0]) return null;
  const { password_hash: _, ...user } = rows[0];
  return user;
}

/** A new session (always a new id, so a session cannot be fixed in advance), recording how the person signed in. */
export async function createSession(req: FastifyRequest, reply: FastifyReply, userId: number, method: 'password' | 'sso' | 'access' | 'passkey' = 'password', idpMfa = false) {
  const token = randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent, auth_method, idp_mfa) VALUES ($1, $2, now() + $3 * interval '1 day', $4, $5, $6, $7)`,
    [sha256(token), userId, config.sessionDays, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300), method, idpMfa],
  );
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // Secure when forced, or when the request arrived over HTTPS (e.g. through a tunnel or reverse proxy).
    secure: config.secureCookies || req.protocol === 'https',
    maxAge: config.sessionDays * 86400,
  });
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export const TOKEN_SCOPES = ['read', 'write', 'mcp', 'ingest'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export const TOKEN_MAX_DAYS = Number(process.env.KERNEL_TOKEN_MAX_DAYS ?? 365);

/** Creates a personal API token. The kernel_pat_ prefix makes leaked tokens recognisable for secret scanners. */
export async function createApiToken(userId: number, name: string, expiresInDays: number, scopes: TokenScope[]) {
  const token = 'kernel_pat_' + randomBytes(32).toString('base64url');
  const { rows } = await query(
    `INSERT INTO api_tokens (user_id, name, token_hash, prefix, expires_at, scopes)
     VALUES ($1, $2, $3, $4, now() + $5 * interval '1 day', $6)
     RETURNING id, name, prefix, created_at, last_used_at, expires_at, scopes`,
    [userId, name, sha256(token), token.slice(0, 16), expiresInDays, scopes],
  );
  return { ...rows[0], token };
}

async function userFromSession(token: string): Promise<User | null> {
  // Absolute lifetime (expires_at) and idle timeout (last_seen_at); activity is recorded at most once a minute.
  const { rows } = await query(
    `WITH s AS (
       UPDATE sessions SET last_seen_at = now()
       WHERE token_hash = $1 AND expires_at > now() AND last_seen_at > now() - $2 * interval '1 hour'
         AND last_seen_at < now() - interval '1 minute'
       RETURNING user_id)
     SELECT ${USER_COLUMNS}, ss.auth_method, ss.idp_mfa, u.sso_subject IS NOT NULL AS sso FROM sessions ss JOIN users u ON u.id = ss.user_id
     WHERE ss.token_hash = $1 AND ss.expires_at > now() AND ss.last_seen_at > now() - $2 * interval '1 hour' AND u.active`,
    [sha256(token), config.sessionIdleHours],
  );
  return rows[0] ?? null;
}

export const currentSessionHash = (req: FastifyRequest) => sha256(req.cookies[SESSION_COOKIE] ?? '');

export async function listSessions(user: User, req: FastifyRequest) {
  const current = currentSessionHash(req);
  const { rows } = await query(
    `SELECT left(token_hash, 16) AS id, created_at, last_seen_at, expires_at, ip, user_agent, token_hash = $2 AS current
     FROM sessions WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC`,
    [user.id, current],
  );
  return rows;
}

export async function revokeSession(user: User, id: string) {
  const { rowCount } = await query('DELETE FROM sessions WHERE user_id = $1 AND left(token_hash, 16) = $2', [user.id, id]);
  if (!rowCount) throw new HttpError(404, 'Session not found');
  securityEvent({ action: 'auth.session_revoked', category: 'authentication', outcome: 'success', message: 'Session signed out remotely', target: `#${user.id}` });
}

// ---- Brute force protection ------------------------------------------------------------------

const failures = new Map<string, { count: number; until: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_IP = 20;
const MAX_PER_ACCOUNT = 8;

function count(key: string) {
  const e = failures.get(key);
  return e && e.until > Date.now() ? e.count : 0;
}

/**
 * Rejects a login attempt when the client or the account has had too many recent failures. A device where the
 * account signed in before skips the per-account lock, so others cannot lock a user out (the per-IP limit stays).
 */
export function guardLogin(ip: string, account: string, knownDevice = false) {
  if (count(`ip:${ip}`) >= MAX_PER_IP || (!knownDevice && count(`acct:${account}`) >= MAX_PER_ACCOUNT)) {
    throw new HttpError(429, 'Too many failed login attempts, try again in 15 minutes');
  }
}

export function loginFailed(req: FastifyRequest, account: string, reason: 'password' | 'second_factor' | 'sso_required') {
  const ip = req.ip;
  securityEvent({ action: 'auth.login_failed', category: 'authentication', outcome: 'failure', message: reason === 'second_factor' ? 'Invalid second factor' : reason === 'sso_required' ? 'Local sign-in refused: single sign-on required' : 'Invalid username or password', account, detail: { reason } }, req);
  for (const key of [`ip:${ip}`, `acct:${account}`]) {
    const e = failures.get(key);
    if (!e || e.until <= Date.now()) failures.set(key, { count: 1, until: Date.now() + WINDOW_MS });
    else e.count++;
  }
  if (count(`acct:${account}`) === MAX_PER_ACCOUNT) {
    void audit(null, { entity_type: 'session', entity_ref: account, action: 'account_locked', changes: { ip } }).catch(() => {});
    // The owner and the administrators hear about it (#75); nothing is sent for names that are not accounts.
    void (async () => {
      const { rows } = await query('SELECT id FROM users WHERE lower(username) = $1 AND active', [account]);
      if (!rows[0]) return;
      const { rows: admins } = await query("SELECT id FROM users WHERE role = 'admin' AND active");
      await notify(pool, { users: [rows[0].id, ...admins.map((a) => a.id)], event: 'account_security', ref: '', title: 'Account locked', summary: `Sign-in to ${account} was locked for 15 minutes after repeated failed attempts.`, path: '/settings', dedupe: `locked:${account}:${Math.floor(Date.now() / 900_000)}` });
    })().catch(() => {});
  }
  if (failures.size > 50_000) for (const [k, v] of failures) if (v.until <= Date.now()) failures.delete(k);
}

export function loginSucceeded(account: string) {
  failures.delete(`acct:${account}`);
}

async function userFromApiToken(req: FastifyRequest, token: string): Promise<(User & { scopes: TokenScope[]; token_prefix: string }) | null> {
  const ip = req.ip;
  const { rows } = await query(
    `UPDATE api_tokens t SET last_used_at = now(), last_used_ip = $2 FROM users u, api_tokens old
     WHERE old.id = t.id AND u.id = t.user_id AND t.token_hash = $1 AND u.active AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
     RETURNING ${USER_COLUMNS}, t.scopes, t.prefix AS token_prefix, t.id AS token_id, old.last_used_ip AS previous_ip`,
    [sha256(token), ip],
  );
  if (!rows[0]) return null;
  const { token_id, previous_ip, ...found } = rows[0];
  await noteTokenAddress(req, token_id, found.id, found.token_prefix, previous_ip);
  return found;
}

// Addresses already known per token, so a busy token costs no extra write per request.
const seenAddresses = new Set<string>();
/** The first use of a token from an address it was never used from is a security event (#64). */
async function noteTokenAddress(req: FastifyRequest, tokenId: number, userId: number, prefix: string, previousIp: string) {
  const key = `${tokenId}|${req.ip}`;
  if (seenAddresses.has(key)) return;
  const { rows } = await query('INSERT INTO api_token_ips (token_id, ip) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING ip', [tokenId, req.ip]);
  if (seenAddresses.size > 50_000) seenAddresses.clear();
  seenAddresses.add(key);
  // The very first use (no earlier address) is expected; a further address is worth a look.
  if (rows[0] && previousIp && previousIp !== req.ip) {
    securityEvent({ action: 'auth.token_new_address', category: 'authentication', outcome: 'info', severity: 'warning', message: `API token ${prefix}… used from a new address`, userId, target: prefix, detail: { previous_ip: previousIp } }, req, { ...originOf(req), userId, tokenPrefix: prefix });
  }
}

/**
 * What a token may do: GET needs read, other methods need write, /mcp needs mcp (plus read/write per tool),
 * and reporting records needs ingest (or write). /api/auth/me is always allowed so clients can check who they are.
 */
export function checkTokenScope(req: FastifyRequest) {
  const scopes = req.tokenScopes;
  if (!scopes) return;
  const path = req.url.split('?')[0];
  if (path === '/api/auth/me') return;
  const need =
    path === '/mcp' ? 'mcp'
    : (path === '/api/integrations/records' || path === '/api/cis/upsert' || path === '/api/ci-relationships/sync' || path === '/api/changes/register' || path === '/api/events' || path === '/api/cmdb/ci-batch' || path === '/api/candidates/report') && req.method === 'POST' ? (scopes.includes('write') ? 'write' : 'ingest')
    : ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? 'read'
    : 'write';
  if (!scopes.includes(need)) throw forbidden(`This API token lacks the "${need}" scope`);
}

/**
 * Resolves the caller from a bearer token or the session cookie. Cookie-authenticated
 * mutations must carry the X-Kernel-Request header, which a cross-site form cannot send.
 */
export async function authenticate(req: FastifyRequest) {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(\S+)\s*$/i)?.[1]; // disjoint classes: linear time on any header
  if (bearer) {
    const found = await userFromApiToken(req, bearer);
    if (found) {
      const { scopes, token_prefix, ...user } = found;
      req.user = user;
      req.tokenScopes = scopes;
      req.tokenPrefix = token_prefix;
      checkTokenScope(req);
    }
    return;
  }
  const cookie = req.cookies[SESSION_COOKIE];
  if (!cookie) return;
  req.user = (await userFromSession(cookie)) ?? undefined;
  if (req.user && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (!req.headers['x-kernel-request']) throw forbidden('Missing X-Kernel-Request header');
    checkSameOrigin(req);
  }
  // A generated initial password must be changed, and required two-factor authentication set up, before anything else.
  const path = req.url.split('?')[0];
  if (req.user?.must_change_password && !['/api/auth/me', '/api/auth/password', '/api/auth/logout', '/api/meta'].includes(path)) {
    throw new HttpError(403, 'Change your password before continuing', { must_change_password: true });
  }
  // An SSO session whose ID token proved the provider's MFA (amr/acr, when trusted) counts as two factors (#41).
  const viaIdp = (req.user as any)?.idp_mfa === true;
  if (req.user && !req.user.mfa_enabled && !viaIdp && !path.startsWith('/api/auth/') && path !== '/api/meta' && (await mfaRequiredFor(req.user.role))) {
    throw new HttpError(403, 'Set up two-factor authentication before continuing', { mfa_enrollment_required: true });
  }
}

/** The signed-in user; with an action, also checks that their role allows it (see policy.ts). */
export function requireUser(req: FastifyRequest, action?: Action): User {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  if (action) authorize(req.user, action);
  return req.user;
}


/** Creates the initial admin account when the database has no users. */
export async function bootstrapAdmin(log: (msg: string) => void) {
  const { rows } = await query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) return;
  let password = config.adminPassword;
  if (!password) {
    password = randomBytes(12).toString('base64url');
    log(`Created user "admin" with generated password: ${password}  (change it after first login)`);
  } else {
    log('Created user "admin" with password from KERNEL_ADMIN_PASSWORD');
  }
  await query(
    `INSERT INTO users (username, display_name, password_hash, role, must_change_password) VALUES ('admin', 'Administrator', $1, 'admin', true)`,
    [await hashPassword(password)],
  );
}
