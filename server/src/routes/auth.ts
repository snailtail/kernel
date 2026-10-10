import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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
import { query } from '../db.js';
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
    if (user.mfa_enabled) return { mfa_required: true, mfa_token: await mfa.createChallenge(user.id) };
    loginSucceeded(account);
    await finishLogin(req, reply, user.id, user.username);
    return user;
  });

  // After SSO, the challenge is in a cookie rather than the page (#41).
  app.get('/api/auth/mfa-pending', async (req) => ({ pending: !!req.cookies[MFA_PENDING_COOKIE] && !!(await mfa.challengeUser(req.cookies[MFA_PENDING_COOKIE]!)) }));
  app.post('/api/auth/login/mfa', async (req, reply) => {
    const parsed = z.object({ mfa_token: z.string().max(200).optional(), code: z.string().max(40) }).parse(req.body);
    const body = { ...parsed, mfa_token: parsed.mfa_token ?? req.cookies[MFA_PENDING_COOKIE] ?? '' };
    reply.clearCookie(MFA_PENDING_COOKIE, { path: '/api/auth' });
    const account = (await mfa.challengeUser(body.mfa_token))?.toLowerCase() ?? '';
    guardLogin(req.ip, account, await mfa.isKnownDevice(req.cookies[mfa.DEVICE_COOKIE], account));
    const userId = await mfa.completeChallenge(body.mfa_token, body.code);
    if (!userId) {
      loginFailed(req.ip, account);
      throw new HttpError(401, 'That code is not valid');
    }
    loginSucceeded(account);
    await finishLogin(req, reply, userId, account);
    return (await query(`SELECT id, username, display_name, email, role, preferences, must_change_password, true AS mfa_enabled FROM users WHERE id = $1`, [userId])).rows[0];
  });

  async function finishLogin(req: FastifyRequest, reply: FastifyReply, userId: number, username: string) {
    await createSession(req, reply, userId);
    await audit(null, { entity_type: 'session', entity_ref: username, action: 'login', actor: { id: userId, name: username } });
    const device = await mfa.rememberDevice(userId, req.cookies[mfa.DEVICE_COOKIE]);
    reply.setCookie(mfa.DEVICE_COOKIE, device, { path: '/api/auth', httpOnly: true, sameSite: 'strict', secure: config.secureCookies || req.protocol === 'https', maxAge: 180 * 86400 });
  }

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
        // Saved list views: a name and the list's query string, e.g. "status=known_error&priority=1".
        saved_views: z.array(z.object({ name: z.string().trim().min(1).max(60), page: z.enum(['problems', 'actions']), query: z.string().max(500) })).max(30).optional(),
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

  app.delete<{ Params: { id: string } }>('/api/tokens/:id', async (req) => {
    const user = requireUser(req);
    const { rows } = await query('UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING prefix, name', [Number(req.params.id), user.id]);
    if (!rows[0]) throw notFound();
    await audit(null, { entity_type: 'api_token', entity_ref: rows[0].prefix, action: 'revoke', changes: { name: rows[0].name } });
    return { ok: true };
  });
}
