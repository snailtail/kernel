import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { createApiToken, createSession, currentSessionHash, destroySession, guardLogin, hashPassword, listSessions, loginFailed, loginSucceeded, requireUser, revokeSession, verifyLogin } from '../auth.js';
import { checkPassword } from '../passwords.js';
import { rateLimit } from '../ratelimit.js';
import { query } from '../db.js';
import { badRequest, HttpError, notFound } from '../errors.js';

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ username: z.string().max(200), password: z.string().max(1000) }).parse(req.body);
    const account = body.username.trim().toLowerCase();
    // Brute force protection per client and per account (also for unknown accounts, so nothing is revealed).
    guardLogin(req.ip, account);
    const user = await verifyLogin(body.username, body.password);
    if (!user) {
      loginFailed(req.ip, account);
      throw new HttpError(401, 'Invalid username or password');
    }
    loginSucceeded(account);
    await createSession(req, reply, user.id);
    return user;
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(req, reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => requireUser(req));

  app.put('/api/auth/preferences', async (req) => {
    const user = requireUser(req);
    const body = z.object({ theme: z.enum(['system', 'light', 'dark']).optional(), guided: z.boolean().optional(), intro_seen: z.boolean().optional() }).strict().parse(req.body);
    const { rows } = await query('UPDATE users SET preferences = preferences || $2 WHERE id = $1 RETURNING preferences', [user.id, body]);
    return rows[0].preferences;
  });

  app.post('/api/auth/password', async (req) => {
    const user = requireUser(req);
    const body = z.object({ current: z.string(), password: z.string() }).parse(req.body);
    rateLimit(`password:${user.id}`, 10, 3600_000);
    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    if (!(await bcrypt.compare(body.current, rows[0].password_hash))) throw badRequest('Current password is incorrect');
    if (body.password === body.current) throw badRequest('Choose a new password');
    await checkPassword(body.password, user);
    await query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [user.id, await hashPassword(body.password)]);
    // Sign out other sessions after a password change.
    await query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [user.id, currentSessionHash(req)]);
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
      'SELECT id, name, prefix, created_at, last_used_at, expires_at FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC',
      [user.id],
    );
    return rows;
  });

  app.post('/api/tokens', async (req) => {
    const user = requireUser(req);
    rateLimit(`tokens:${user.id}`, 20, 3600_000);
    const body = z
      .object({ name: z.string().trim().min(1).max(100), expires_in_days: z.number().int().min(1).max(3650).optional() })
      .parse(req.body);
    return createApiToken(user.id, body.name, body.expires_in_days);
  });

  app.delete<{ Params: { id: string } }>('/api/tokens/:id', async (req) => {
    const user = requireUser(req);
    const { rowCount } = await query('DELETE FROM api_tokens WHERE id = $1 AND user_id = $2', [Number(req.params.id), user.id]);
    if (!rowCount) throw notFound();
    return { ok: true };
  });
}
