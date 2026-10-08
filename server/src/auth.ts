import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { query } from './db.js';
import { forbidden, HttpError } from './errors.js';
import { logger } from './log.js';
import { checkSameOrigin } from './security.js';

const securityLog = logger.child({ event: { dataset: 'kernel.security' } });
import type { Role } from './workflow.js';

export interface User {
  id: number;
  username: string;
  display_name: string;
  email: string;
  role: Role;
  preferences: Preferences;
  must_change_password: boolean;
}

export interface Preferences {
  theme?: 'system' | 'light' | 'dark';
  /** Step-by-step guidance through the process; on unless turned off. */
  guided?: boolean;
  intro_seen?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

export const SESSION_COOKIE = 'kernel_session';
const USER_COLUMNS = 'u.id, u.username, u.display_name, u.email, u.role, u.preferences, u.must_change_password';

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

export async function createSession(req: FastifyRequest, reply: FastifyReply, userId: number) {
  const token = randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES ($1, $2, now() + $3 * interval '1 day', $4, $5)`,
    [sha256(token), userId, config.sessionDays, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300)],
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

export async function createApiToken(userId: number, name: string, expiresInDays?: number) {
  const token = 'krn_' + randomBytes(24).toString('base64url');
  const { rows } = await query(
    `INSERT INTO api_tokens (user_id, name, token_hash, prefix, expires_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + $5 * interval '1 day' END)
     RETURNING id, name, prefix, created_at, last_used_at, expires_at`,
    [userId, name, sha256(token), token.slice(0, 8), expiresInDays ?? null],
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
     SELECT ${USER_COLUMNS} FROM sessions ss JOIN users u ON u.id = ss.user_id
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

/** Rejects a login attempt when the client or the account has had too many recent failures. */
export function guardLogin(ip: string, account: string) {
  if (count(`ip:${ip}`) >= MAX_PER_IP || count(`acct:${account}`) >= MAX_PER_ACCOUNT) {
    throw new HttpError(429, 'Too many failed login attempts, try again in 15 minutes');
  }
}

export function loginFailed(ip: string, account: string) {
  for (const key of [`ip:${ip}`, `acct:${account}`]) {
    const e = failures.get(key);
    if (!e || e.until <= Date.now()) failures.set(key, { count: 1, until: Date.now() + WINDOW_MS });
    else e.count++;
  }
  if (count(`acct:${account}`) === MAX_PER_ACCOUNT) {
    securityLog.warn({ event: { action: 'auth.account_locked', category: ['authentication'] }, user: { name: account }, source: { ip } }, 'Account temporarily locked after failed logins');
  }
  if (failures.size > 50_000) for (const [k, v] of failures) if (v.until <= Date.now()) failures.delete(k);
}

export function loginSucceeded(account: string) {
  failures.delete(`acct:${account}`);
}

async function userFromApiToken(token: string): Promise<User | null> {
  const { rows } = await query(
    `UPDATE api_tokens t SET last_used_at = now() FROM users u
     WHERE u.id = t.user_id AND t.token_hash = $1 AND u.active AND (t.expires_at IS NULL OR t.expires_at > now())
     RETURNING ${USER_COLUMNS}`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

/**
 * Resolves the caller from a bearer token or the session cookie. Cookie-authenticated
 * mutations must carry the X-Kernel-Request header, which a cross-site form cannot send.
 */
export async function authenticate(req: FastifyRequest) {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) {
    req.user = (await userFromApiToken(bearer)) ?? undefined;
    return;
  }
  const cookie = req.cookies[SESSION_COOKIE];
  if (!cookie) return;
  req.user = (await userFromSession(cookie)) ?? undefined;
  if (req.user && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (!req.headers['x-kernel-request']) throw forbidden('Missing X-Kernel-Request header');
    checkSameOrigin(req);
  }
  // A generated initial password must be changed before anything else.
  if (req.user?.must_change_password && !['/api/auth/me', '/api/auth/password', '/api/auth/logout', '/api/meta'].includes(req.url.split('?')[0])) {
    throw new HttpError(403, 'Change your password before continuing', { must_change_password: true });
  }
}

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return req.user;
}

export function requireRole(req: FastifyRequest, ...roles: Role[]): User {
  const user = requireUser(req);
  if (!roles.includes(user.role)) throw forbidden();
  return user;
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
