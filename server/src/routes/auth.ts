import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { notify } from '../notifications.js';
import * as passkeys from '../passkeys.js';
import { MFA_PENDING_COOKIE, ssoSettings } from '../sso.js';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { TOKEN_MAX_DAYS, TOKEN_SCOPES, createApiToken, createSession, currentSessionHash, destroySession, guardLogin, hashPassword, listSessions, loginFailed, loginSucceeded, requireUser, revokeSession, verifyLogin } from '../auth.js';
import { audit } from '../audit.js';
import { config } from '../config.js';
import * as mfa from '../mfa.js';
import { mfaRequiredFor } from '../mfapolicy.js';
import { checkPassword } from '../passwords.js';
import { rateLimit } from '../ratelimit.js';
import { pool, query } from '../db.js';
import { badRequest, forbidden, HttpError, notFound } from '../errors.js';

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ username: z.string().max(200), password: z.string().max(1000) }).parse(req.body);
    const account = body.username.trim().toLowerCase();
    // Brute force protection per client and per account (also for unknown accounts, so nothing is revealed).
    const device = req.cookies[mfa.DEVICE_COOKIE];
    guardLogin(req.ip, account, await mfa.isKnownDevice(device, account));
    const user = await verifyLogin(body.username, body.password);
    // With SSO on and local sign-in kept for administrators only (break-glass), others must use SSO.
    const sso = await ssoSettings();
    if (user && sso.enabled && sso.local_login === 'admins' && user.role !== 'admin') {
      loginFailed(req.ip, account);
      throw new HttpError(403, 'Sign in with single sign-on');
    }
    if (!user) {
      loginFailed(req.ip, account);
      throw new HttpError(401, 'Invalid username or password');
    }
    // A second factor: the authenticator code and/or a passkey (#75).
    const passkey = await passkeys.hasPasskey(user.id);
    if (user.mfa_enabled || passkey) return { mfa_required: true, mfa_token: await mfa.createChallenge(user.id), methods: [...(user.mfa_enabled ? ['totp'] : []), ...(passkey ? ['passkey'] : [])] };
    loginSucceeded(account);
    await finishLogin(req, reply, user.id, user.username);
    return user;
  });

  // After SSO, the challenge is in a cookie rather than the page (#41).
  app.get('/api/auth/mfa-pending', async (req) => ({ pending: !!req.cookies[MFA_PENDING_COOKIE] && !!(await mfa.challengeUser(req.cookies[MFA_PENDING_COOKIE]!)) }));
  app.post('/api/auth/login/mfa', async (req, reply) => {
    const body = z.object({ mfa_token: z.string().max(200).optional(), code: z.string().max(40) }).parse(req.body);
    // A random 256-bit challenge id from the login response or, after SSO, the pending cookie.
    const challenge = body.mfa_token ?? req.cookies[MFA_PENDING_COOKIE] ?? '';
    reply.clearCookie(MFA_PENDING_COOKIE, { path: '/api/auth' });
    const account = (await mfa.challengeUser(challenge))?.toLowerCase() ?? '';
    guardLogin(req.ip, account, await mfa.isKnownDevice(req.cookies[mfa.DEVICE_COOKIE], account));
    const userId = await mfa.completeChallenge(challenge, body.code);
    if (!userId) {
      loginFailed(req.ip, account);
      throw new HttpError(401, 'That code is not valid');
    }
    loginSucceeded(account);
    await finishLogin(req, reply, userId, account, true);
    return (await query(`SELECT id, username, display_name, email, role, preferences, must_change_password, true AS mfa_enabled FROM users WHERE id = $1`, [userId])).rows[0];
  });

  async function finishLogin(req: FastifyRequest, reply: FastifyReply, userId: number, username: string, secondFactor = false) {
    await createSession(req, reply, userId, 'password', secondFactor);
    await audit(null, { entity_type: 'session', entity_ref: username, action: 'login', actor: { id: userId, name: username } });
    const known = req.cookies[mfa.DEVICE_COOKIE];
    const device = await mfa.rememberDevice(userId, known);
    // A sign-in from a device this account has not used before is worth knowing about (#75).
    const { rows: devices } = device !== known ? await query('SELECT count(*)::int AS n FROM known_devices WHERE user_id = $1', [userId]) : { rows: [{ n: 0 }] };
    if (device !== known && devices[0].n > 1) {
      await notify(pool, { users: [userId], event: 'account_security', ref: '', title: 'New sign-in', summary: `Your account was signed in to from a new device (${String(req.headers['user-agent'] ?? 'unknown browser').slice(0, 80)}). If it was not you, change your password.`, path: '/settings', dedupe: `device:${userId}:${device.slice(0, 12)}` });
    }
    reply.setCookie(mfa.DEVICE_COOKIE, device, { path: '/api/auth', httpOnly: true, sameSite: 'strict', secure: config.secureCookies || req.protocol === 'https', maxAge: 180 * 86400 });
  }

  // ---- Passkeys (#75) ----
  app.post('/api/auth/passkey/options', async (req) => {
    rateLimit(`passkey-options:${req.ip}`, 30, 60_000);
    const body = z.object({ mfa_token: z.string().max(200).optional() }).parse(req.body ?? {});
    if (body.mfa_token) {
      const userId = await mfa.challengeUserId(body.mfa_token);
      if (!userId) throw new HttpError(401, 'The sign-in has expired; start again');
      return passkeys.authenticationOptions('second_factor', userId);
    }
    return passkeys.authenticationOptions('login', null);
  });
  app.post('/api/auth/passkey/login', async (req, reply) => {
    rateLimit(`passkey-login:${req.ip}`, 20, 60_000);
    const body = z.object({ response: z.any(), mfa_token: z.string().max(200).optional() }).parse(req.body);
    let userId: number;
    if (body.mfa_token) {
      // The password was right; the passkey is the second factor.
      const pending = await mfa.challengeUserId(body.mfa_token);
      if (!pending) throw new HttpError(401, 'The sign-in has expired; start again');
      userId = await passkeys.verifyPasskey('second_factor', body.response, pending);
      await mfa.consumeChallenge(body.mfa_token);
      const { rows } = await query('SELECT username FROM users WHERE id = $1', [userId]);
      loginSucceeded(rows[0].username.toLowerCase());
      await finishLogin(req, reply, userId, rows[0].username, true);
    } else {
      userId = await passkeys.passkeyLogin(req, reply, body.response);
    }
    return (await query(`SELECT id, username, display_name, email, role, preferences, must_change_password, mfa_enabled_at IS NOT NULL AS mfa_enabled FROM users WHERE id = $1`, [userId])).rows[0];
  });
  app.get('/api/auth/passkeys', async (req) => passkeys.listPasskeys(requireUser(req)));
  app.post('/api/auth/passkeys/options', async (req) => {
    const user = requireUser(req);
    await mfa.requireStepUp(req);
    return passkeys.registrationOptions(user);
  });
  app.post('/api/auth/passkeys', async (req) => {
    const user = requireUser(req);
    await mfa.requireStepUp(req);
    const body = z.object({ response: z.any(), name: z.string().trim().max(100).default('Passkey') }).parse(req.body);
    return passkeys.register(user, body.response, body.name);
  });
  app.delete<{ Params: { id: string } }>('/api/auth/passkeys/:id', async (req) => {
    const user = requireUser(req);
    await mfa.requireStepUp(req);
    return passkeys.removePasskey(user, Number(req.params.id));
  });
  app.post('/api/auth/reauth/passkey/options', async (req) => passkeys.authenticationOptions('step_up', requireUser(req).id));
  app.post('/api/auth/reauth/passkey', async (req) => {
    const user = requireUser(req);
    rateLimit(`reauth:${user.id}`, 10, 15 * 60_000);
    await passkeys.passkeyStepUp(req, user, z.object({ response: z.any() }).parse(req.body).response);
    return { ok: true };
  });

  app.post('/api/auth/reauth', async (req) => {
    const user = requireUser(req);
    rateLimit(`reauth:${user.id}`, 10, 15 * 60_000);
    const body = z.object({ password: z.string().max(1000), code: z.string().max(40).optional() }).parse(req.body);
    await mfa.reauthenticate(req, user, body.password, body.code);
    return { ok: true };
  });

  app.get('/api/auth/mfa', async (req) => mfa.mfaStatus(requireUser(req)));
  app.post('/api/auth/mfa/setup', async (req) => {
    const user = requireUser(req);
    await mfa.requireStepUp(req);
    return mfa.startSetup(user);
  });
  app.post('/api/auth/mfa/enable', async (req) => {
    const user = requireUser(req);
    rateLimit(`mfa-enable:${user.id}`, 10, 15 * 60_000);
    return mfa.enable(user, z.object({ code: z.string().max(10) }).parse(req.body).code);
  });
  app.post('/api/auth/mfa/disable', async (req) => {
    const user = requireUser(req);
    await mfa.requireStepUp(req);
    await mfa.disable(user, user.id);
    return { ok: true };
  });
  app.post('/api/auth/mfa/recovery-codes', async (req) => {
    const user = requireUser(req);
    await mfa.requireStepUp(req);
    return mfa.regenerateRecoveryCodes(user);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.user) await audit(null, { entity_type: 'session', entity_ref: req.user.username, action: 'logout' });
    await destroySession(req, reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const user = requireUser(req);
    return { ...user, mfa_enrollment_required: !user.mfa_enabled && (await mfaRequiredFor(user.role)) };
  });

  app.put('/api/auth/preferences', async (req) => {
    const user = requireUser(req);
    const body = z
      .object({
        theme: z.enum(['system', 'light', 'dark']).optional(),
        guided: z.boolean().optional(),
        intro_seen: z.boolean().optional(),
        live_presence: z.boolean().optional(),
        nav_collapsed: z.array(z.enum(['respond', 'improve', 'learn', 'directory'])).max(4).optional(),
      })
      .strict()
      .parse(req.body);
    const { rows } = await query('UPDATE users SET preferences = preferences || $2 WHERE id = $1 RETURNING preferences', [user.id, body]);
    return rows[0].preferences;
  });

  app.post('/api/auth/password', async (req) => {
    const user = requireUser(req);
    if (req.headers.authorization) throw forbidden('Change your password when signed in to the web UI');
    const body = z.object({ current: z.string(), password: z.string(), revoke_tokens: z.boolean().optional(), code: z.string().max(40).optional() }).parse(req.body);
    rateLimit(`password:${user.id}`, 10, 3600_000);
    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    if (!(await bcrypt.compare(body.current, rows[0].password_hash))) throw badRequest('Current password is incorrect');
    if (body.password === body.current) throw badRequest('Choose a new password');
    if (user.mfa_enabled && !(body.code && (await mfa.checkSecondFactor(user.id, body.code)))) {
      throw new HttpError(400, 'Enter a code from your authenticator app to change the password', { code_required: true });
    }
    await checkPassword(body.password, user);
    await query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [user.id, await hashPassword(body.password)]);
    // Sign out other sessions after a password change, and optionally revoke API tokens too.
    await query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [user.id, currentSessionHash(req)]);
    if (body.revoke_tokens) await query('DELETE FROM api_tokens WHERE user_id = $1', [user.id]);
    await mfa.forgetDevices(user.id, req.cookies[mfa.DEVICE_COOKIE]);
    await audit(null, { entity_type: 'user', entity_ref: user.username, action: 'password_change', changes: { password: '[changed]', revoked_tokens: !!body.revoke_tokens } });
    return { ok: true };
  });

  app.get('/api/auth/sessions', async (req) => listSessions(requireUser(req), req));
  app.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', async (req) => {
    await revokeSession(requireUser(req), req.params.id);
    return { ok: true };
  });
  app.post('/api/auth/sessions/revoke-others', async (req) => {
    const user = requireUser(req);
    const { rowCount } = await query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [user.id, currentSessionHash(req)]);
    return { revoked: rowCount };
  });

  // Personal API tokens for MCP clients and scripts
  app.get('/api/tokens', async (req) => {
    const user = requireUser(req);
    const { rows } = await query(
      'SELECT id, name, prefix, scopes, created_at, last_used_at, last_used_ip, expires_at FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC',
      [user.id],
    );
    return rows;
  });

  app.post('/api/tokens', async (req) => {
    const user = requireUser(req);
    rateLimit(`tokens:${user.id}`, 20, 3600_000);
    await mfa.requireStepUp(req);
    const body = z
      .object({
        name: z.string().trim().min(1).max(100),
        expires_in_days: z.number().int().min(1).max(TOKEN_MAX_DAYS).default(90),
        // Least privilege by default: read only (integration accounts: ingest only).
        scopes: z.array(z.enum(TOKEN_SCOPES)).min(1).optional(),
      })
      .parse(req.body);
    const scopes = body.scopes ?? (user.role === 'integration' ? ['ingest'] : ['read']);
    if (user.role === 'integration' && scopes.some((s) => s !== 'ingest' && s !== 'read')) throw badRequest('Integration accounts can only have read and ingest tokens');
    const created = await createApiToken(user.id, body.name, body.expires_in_days, [...new Set(scopes)]);
    await audit(null, { entity_type: 'api_token', entity_ref: created.prefix, action: 'create', changes: { name: body.name, scopes: created.scopes, expires_at: created.expires_at } });
    return created;
  });

  /**
   * Rotation without downtime (#75): a successor with the same name, scopes and lifetime; the old token keeps working
   * for 24 hours (or until it expires, if sooner) so integrations can switch over.
   */
  app.post<{ Params: { id: string } }>('/api/tokens/:id/rotate', async (req) => {
    const user = requireUser(req);
    rateLimit(`tokens:${user.id}`, 20, 3600_000);
    await mfa.requireStepUp(req);
    const { rows } = await query(
      `SELECT id, name, scopes, prefix, greatest(1, ceil(extract(epoch FROM (expires_at - created_at)) / 86400))::int AS days
       FROM api_tokens WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND rotated_to IS NULL AND (expires_at IS NULL OR expires_at > now())`,
      [Number(req.params.id), user.id],
    );
    if (!rows[0]) throw notFound('No active token with that id');
    const successor = await createApiToken(user.id, rows[0].name, Math.min(rows[0].days ?? 90, TOKEN_MAX_DAYS), rows[0].scopes);
    await query("UPDATE api_tokens SET rotated_to = $2, expires_at = least(coalesce(expires_at, now() + interval '1 day'), now() + interval '1 day') WHERE id = $1", [rows[0].id, successor.id]);
    await audit(null, { entity_type: 'api_token', entity_ref: rows[0].prefix, action: 'rotate', changes: { successor: successor.prefix, overlap_hours: 24 } });
    return { ...successor, previous_expires_in_hours: 24 };
  });

  app.delete<{ Params: { id: string } }>('/api/tokens/:id', async (req) => {
    const user = requireUser(req);
    const { rows } = await query('UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING prefix, name', [Number(req.params.id), user.id]);
    if (!rows[0]) throw notFound();
    await audit(null, { entity_type: 'api_token', entity_ref: rows[0].prefix, action: 'revoke', changes: { name: rows[0].name } });
    return { ok: true };
  });
}
