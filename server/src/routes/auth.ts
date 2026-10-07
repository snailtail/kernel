import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { createApiToken, createSession, destroySession, hashPassword, requireUser, verifyLogin } from '../auth.js';
import { query } from '../db.js';
import { badRequest, HttpError, notFound } from '../errors.js';

// Simple in-memory brute force protection: 10 failed logins per IP per 15 minutes.
const failures = new Map<string, { count: number; until: number }>();
const WINDOW_MS = 15 * 60 * 1000;

function checkLoginRate(ip: string) {
  const entry = failures.get(ip);
  if (entry && entry.until > Date.now() && entry.count >= 10) {
    throw new HttpError(429, 'Too many failed login attempts, try again later');
  }
}

function recordFailure(ip: string) {
  const entry = failures.get(ip);
  if (!entry || entry.until < Date.now()) failures.set(ip, { count: 1, until: Date.now() + WINDOW_MS });
  else entry.count++;
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (req, reply) => {
    checkLoginRate(req.ip);
    const body = z.object({ username: z.string(), password: z.string() }).parse(req.body);
    const user = await verifyLogin(body.username, body.password);
    if (!user) {
      recordFailure(req.ip);
      throw new HttpError(401, 'Invalid username or password');
    }
    failures.delete(req.ip);
    await createSession(req, reply, user.id);
    return user;
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(req, reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => requireUser(req));

  app.post('/api/auth/password', async (req) => {
    const user = requireUser(req);
    const body = z.object({ current: z.string(), password: z.string().min(10, 'Use at least 10 characters') }).parse(req.body);
    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    if (!(await bcrypt.compare(body.current, rows[0].password_hash))) throw badRequest('Current password is incorrect');
    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(body.password)]);
    return { ok: true };
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
