// Two-factor authentication (TOTP + recovery codes), step-up re-authentication and the MFA policy.
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { currentSessionHash, type User } from './auth.js';
import { pool, query, tx } from './db.js';
import { badRequest, conflict, forbidden, HttpError } from './errors.js';
import { audit } from './audit.js';
import { decryptSecret, encryptSecret } from './secrets.js';
import { clearMfaPolicyCache } from './mfapolicy.js';
import { generateSecret, otpauthUrl, verifyCode } from './totp.js';
import type { Role } from './workflow.js';
import { tokenHash } from './core/hash.js';
import { notify } from './notifications.js';

const STEP_UP_MINUTES = Number(process.env.KERNEL_STEPUP_MINUTES ?? 10);

export async function requiredRoles(): Promise<Role[]> {
  const { rows } = await query("SELECT value FROM settings WHERE key = 'mfa_required_roles'");
  return rows[0]?.value ?? [];
}

export async function setRequiredRoles(roles: Role[], reason: string) {
  const before = await requiredRoles();
  clearMfaPolicyCache();
  await query("INSERT INTO settings (key, value) VALUES ('mfa_required_roles', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [JSON.stringify(roles)]);
  clearMfaPolicyCache();
  await audit(null, { entity_type: 'setting', entity_ref: 'mfa_required_roles', action: 'update', changes: { required_roles: { from: before, to: roles } }, reason });
  return roles;
}

export async function mfaStatus(user: User) {
  const [{ rows }, roles] = await Promise.all([
    query(
      `SELECT mfa_enabled_at, (SELECT count(*)::int FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL) AS recovery_codes_left
       FROM users WHERE id = $1`,
      [user.id],
    ),
    requiredRoles(),
  ]);
  return { enabled: !!rows[0].mfa_enabled_at, enabled_at: rows[0].mfa_enabled_at, recovery_codes_left: rows[0].recovery_codes_left, required: roles.includes(user.role) };
}

/** Checks a TOTP code (no replays) or an unused recovery code for the user. */
export async function checkSecondFactor(userId: number, code: string): Promise<boolean> {
  return tx(async (db) => {
    const { rows } = await db.query('SELECT mfa_secret, mfa_enabled_at, mfa_last_step FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const u = rows[0];
    if (!u?.mfa_enabled_at || !u.mfa_secret) return false;
    const trimmed = code.trim();
    if (/^\d{6}$/.test(trimmed.replace(/\s/g, ''))) {
      const step = verifyCode(decryptSecret(u.mfa_secret), trimmed);
      if (step === null || step <= Number(u.mfa_last_step)) return false;
      await db.query('UPDATE users SET mfa_last_step = $2 WHERE id = $1', [userId, step]);
      return true;
    }
    const { rows: codes } = await db.query('SELECT id, code_hash FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [userId]);
    for (const c of codes) {
      if (await bcrypt.compare(trimmed.toLowerCase().replace(/[^a-z0-9]/g, ''), c.code_hash)) {
        await db.query('UPDATE mfa_recovery_codes SET used_at = now() WHERE id = $1', [c.id]);
        return true;
      }
    }
    return false;
  });
}

async function hasMfa(userId: number) {
  const { rows } = await query('SELECT mfa_enabled_at FROM users WHERE id = $1', [userId]);
  return !!rows[0]?.mfa_enabled_at;
}

// ---- Login challenge ---------------------------------------------------------------------------

export async function createChallenge(userId: number) {
  const token = randomBytes(32).toString('base64url');
  await query(`INSERT INTO mfa_challenges (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '5 minutes')`, [tokenHash(token), userId]);
  return token;
}

/** Consumes a login challenge when the code is right; returns the user id. */
export async function completeChallenge(token: string, code: string): Promise<number | null> {
  const { rows } = await query('SELECT user_id FROM mfa_challenges WHERE token_hash = $1 AND expires_at > now() AND attempts < 5', [tokenHash(token)]);
  if (!rows[0]) throw new HttpError(401, 'The sign-in has expired; start again');
  if (!(await checkSecondFactor(rows[0].user_id, code))) {
    // Five wrong codes end the challenge; the password has to be entered again.
    await query('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = $1', [tokenHash(token)]);
    return null;
  }
  await query('DELETE FROM mfa_challenges WHERE token_hash = $1 OR expires_at < now()', [tokenHash(token)]);
  return rows[0].user_id;
}

/** The account a pending sign-in challenge belongs to (for a passkey as the second factor). */
export const challengeUserId = async (token: string) =>
  (await query('SELECT user_id FROM mfa_challenges WHERE token_hash = $1 AND expires_at > now() AND attempts < 5', [tokenHash(token)])).rows[0]?.user_id as number | undefined;

/** Ends a pending sign-in challenge once its second factor (here: a passkey) was verified elsewhere. */
export async function consumeChallenge(token: string) {
  await query('DELETE FROM mfa_challenges WHERE token_hash = $1', [tokenHash(token)]);
}

export const challengeUser = async (token: string) =>
  (await query('SELECT u.username FROM mfa_challenges c JOIN users u ON u.id = c.user_id WHERE c.token_hash = $1', [tokenHash(token)])).rows[0]?.username as string | undefined;

// ---- Enrolment ---------------------------------------------------------------------------------

export async function startSetup(user: User) {
  if (await hasMfa(user.id)) throw conflict('Two-factor authentication is already enabled; disable it first to re-enrol');
  const secret = generateSecret();
  await query('UPDATE users SET mfa_secret = $2 WHERE id = $1', [user.id, encryptSecret(secret)]);
  const url = otpauthUrl(secret, user.username);
  return { secret, otpauth_url: url, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) };
}

function newRecoveryCodes() {
  return Array.from({ length: 10 }, () => {
    const raw = randomBytes(5).toString('hex'); // 10 hex characters
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

async function storeRecoveryCodes(userId: number, codes: string[]) {
  await query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
  for (const c of codes) await query('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)', [userId, await bcrypt.hash(c.replace('-', ''), 10)]);
}

export async function enable(user: User, code: string) {
  const { rows } = await query('SELECT mfa_secret, mfa_enabled_at FROM users WHERE id = $1', [user.id]);
  if (rows[0].mfa_enabled_at) throw conflict('Two-factor authentication is already enabled');
  if (!rows[0].mfa_secret) throw badRequest('Start the setup first');
  const step = verifyCode(decryptSecret(rows[0].mfa_secret), code);
  if (step === null) throw badRequest('That code is not valid; check the time on your device and try again');
  await query('UPDATE users SET mfa_enabled_at = now(), mfa_last_step = $2 WHERE id = $1', [user.id, step]);
  const codes = newRecoveryCodes();
  await storeRecoveryCodes(user.id, codes);
  await audit(null, { entity_type: 'user', entity_ref: user.username, action: 'mfa_enable' });
  return { recovery_codes: codes };
}

export async function regenerateRecoveryCodes(user: User) {
  if (!(await hasMfa(user.id))) throw conflict('Two-factor authentication is not enabled');
  const codes = newRecoveryCodes();
  await storeRecoveryCodes(user.id, codes);
  await audit(null, { entity_type: 'user', entity_ref: user.username, action: 'mfa_recovery_codes' });
  return { recovery_codes: codes };
}

export async function disable(actor: User, userId: number, reason = '') {
  const { rows } = await query('SELECT role, username FROM users WHERE id = $1', [userId]);
  if (!rows[0]) throw new HttpError(404, 'User not found');
  if (actor.id === userId && (await requiredRoles()).includes(rows[0].role)) {
    throw forbidden('Your role requires two-factor authentication');
  }
  await query('UPDATE users SET mfa_secret = NULL, mfa_enabled_at = NULL, mfa_last_step = 0 WHERE id = $1', [userId]);
  await query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
  if (actor.id !== userId) await forgetDevices(userId);
  await audit(null, { entity_type: 'user', entity_ref: rows[0].username, action: actor.id === userId ? 'mfa_disable' : 'mfa_reset', reason });
}

// ---- Step-up re-authentication -----------------------------------------------------------------

/**
 * Sensitive actions need a recent re-authentication in a browser session, and are not available with API tokens
 * (a leaked token must not be able to mint tokens, change roles or webhook targets).
 */
export async function requireStepUp(req: FastifyRequest) {
  if (req.headers.authorization) throw forbidden('This action is only available when signed in to the web UI');
  const { rows } = await query(
    `SELECT reauth_at > now() - $2 * interval '1 minute' AS fresh FROM sessions WHERE token_hash = $1`,
    [currentSessionHash(req), STEP_UP_MINUTES],
  );
  if (!rows[0]?.fresh) throw new HttpError(403, 'Confirm it is you to continue', { reauth_required: true, mfa: await hasMfa(req.user!.id) });
}

export async function reauthenticate(req: FastifyRequest, user: User, password: string, code?: string) {
  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
  if (!(await bcrypt.compare(password, rows[0].password_hash))) throw new HttpError(401, 'Incorrect password');
  if (await hasMfa(user.id)) {
    if (!code || !(await checkSecondFactor(user.id, code))) throw new HttpError(401, 'Enter a valid code from your authenticator app');
  }
  await query('UPDATE sessions SET reauth_at = now() WHERE token_hash = $1', [currentSessionHash(req)]);
}

// ---- Known devices -------------------------------------------------------------------------------

export const DEVICE_COOKIE = 'kernel_device';

export async function rememberDevice(userId: number, existing?: string) {
  if (existing) {
    const { rowCount } = await query('UPDATE known_devices SET last_used_at = now() WHERE token_hash = $1 AND user_id = $2', [tokenHash(existing), userId]);
    if (rowCount) return existing;
  }
  const token = randomBytes(24).toString('base64url');
  await query('INSERT INTO known_devices (token_hash, user_id) VALUES ($1, $2)', [tokenHash(token), userId]);
  return token;
}

/** Whether the device cookie belongs to the named account (used to bypass a per-account lockout). */
export async function isKnownDevice(token: string | undefined, username: string) {
  if (!token) return false;
  const { rows } = await query(
    `SELECT 1 FROM known_devices d JOIN users u ON u.id = d.user_id
     WHERE d.token_hash = $1 AND lower(u.username) = lower($2) AND d.last_used_at > now() - interval '180 days'`,
    [tokenHash(token), username],
  );
  return !!rows[0];
}

/** Forgets the user's known devices (all, or all but the current one). */
/** A sign-in from a device this account has not used before is worth knowing about (#75), unless it is the first. */
export async function noticeNewDevice(userId: number, device: string, userAgent: string | undefined) {
  const { rows } = await query('SELECT count(*)::int AS n FROM known_devices WHERE user_id = $1', [userId]);
  if (rows[0].n <= 1) return;
  await notify(pool, { users: [userId], event: 'account_security', ref: '', title: 'New sign-in', summary: `Your account was signed in to from a new device (${(userAgent ?? 'unknown browser').slice(0, 80)}). If it was not you, change your password.`, path: '/settings', dedupe: `device:${userId}:${device.slice(0, 12)}` });
}

export async function forgetDevices(userId: number, keep?: string) {
  await query('DELETE FROM known_devices WHERE user_id = $1 AND token_hash <> $2', [userId, keep ? tokenHash(keep) : '']);
}
