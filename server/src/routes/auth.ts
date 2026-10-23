import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as passkeys from '../passkeys.js';
import { MFA_PENDING_COOKIE, ssoSettings } from '../sso.js';
import { z } from 'zod';
import { startFor } from '../start-page.js';
import * as tokens from '../api-tokens.js';
import * as users from '../users.js';
import { createSession, currentSessionHash, destroySession, guardLogin, listSessions, loginFailed, loginSucceeded, requireUser, revokeOtherSessions, revokeSession, verifyLogin } from '../auth.js';
import { audit } from '../audit.js';
import { config } from '../config.js';
import * as mfa from '../mfa.js';
import { mfaRequiredFor } from '../mfapolicy.js';
import { rateLimit } from '../ratelimit.js';
import { forbidden, HttpError } from '../errors.js';

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
      loginFailed(req, account, 'sso_required');
      throw new HttpError(403, 'Sign in with single sign-on');
    }
    if (!user) {
      loginFailed(req, account, 'password');
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
      loginFailed(req, account, 'second_factor');
      throw new HttpError(401, 'That code is not valid');
    }
    loginSucceeded(account);
    await finishLogin(req, reply, userId, account, true);
    return { ...(await users.signedInUser(userId)), mfa_enabled: true };
  });

  async function finishLogin(req: FastifyRequest, reply: FastifyReply, userId: number, username: string, secondFactor = false) {
    await createSession(req, reply, userId, 'password', secondFactor);
    await audit(null, { entity_type: 'session', entity_ref: username, action: 'login', actor: { id: userId, name: username } });
    const known = req.cookies[mfa.DEVICE_COOKIE];
    const device = await mfa.rememberDevice(userId, known);
    if (device !== known) await mfa.noticeNewDevice(userId, device, req.headers['user-agent']);
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
      const username = await users.usernameOf(userId);
      loginSucceeded(username.toLowerCase());
      await finishLogin(req, reply, userId, username, true);
    } else {
      userId = await passkeys.passkeyLogin(req, reply, body.response);
    }
    return users.signedInUser(userId);
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
    return { ...user, ...(await startFor(user)), mfa_enrollment_required: !user.mfa_enabled && (await mfaRequiredFor(user.role)) };
  });

  app.put('/api/auth/preferences', async (req) => users.savePreferences(requireUser(req), users.preferencesSchema.parse(req.body)));

  app.post('/api/auth/password', async (req) => {
    const user = requireUser(req);
    if (req.headers.authorization) throw forbidden('Change your password when signed in to the web UI');
    const body = users.passwordChangeSchema.parse(req.body);
    rateLimit(`password:${user.id}`, 10, 3600_000);
    await users.changePassword(user, body, { session: currentSessionHash(req), device: req.cookies[mfa.DEVICE_COOKIE] });
    return { ok: true };
  });

  app.get('/api/auth/sessions', async (req) => listSessions(requireUser(req), req));
  app.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', async (req) => {
    await revokeSession(requireUser(req), req.params.id);
    return { ok: true };
  });
  app.post('/api/auth/sessions/revoke-others', async (req) => ({ revoked: await revokeOtherSessions(requireUser(req), req) }));

  // Personal API tokens for MCP clients and scripts
  app.get('/api/tokens', async (req) => tokens.listTokens(requireUser(req)));

  app.post('/api/tokens', async (req) => {
    const user = requireUser(req);
    rateLimit(`tokens:${user.id}`, 20, 3600_000);
    await mfa.requireStepUp(req);
    return tokens.issueToken(user, tokens.tokenSchema.parse(req.body));
  });

  app.post<{ Params: { id: string } }>('/api/tokens/:id/rotate', async (req) => {
    const user = requireUser(req);
    rateLimit(`tokens:${user.id}`, 20, 3600_000);
    await mfa.requireStepUp(req);
    return tokens.rotateToken(user, Number(req.params.id));
  });

  app.delete<{ Params: { id: string } }>('/api/tokens/:id', async (req) => {
    await tokens.revokeToken(requireUser(req), Number(req.params.id));
    return { ok: true };
  });
}
