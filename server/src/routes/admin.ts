import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword, requireRole } from '../auth.js';
import { backupStatus } from '../backups.js';
import { disable as disableMfa, requiredRoles, requireStepUp, setRequiredRoles } from '../mfa.js';
import { checkPassword } from '../passwords.js';
import { securityStatus } from '../security.js';
import * as webhooks from '../webhooks.js';
import { query } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { ROLES } from '../workflow.js';

const userFields = {
  username: z.string().trim().min(2).max(50).regex(/^[a-zA-Z0-9._-]+$/, 'Use letters, digits, dot, dash or underscore'),
  display_name: z.string().trim().min(1).max(100),
  email: z.string().trim().max(200),
  role: z.enum(ROLES),
  active: z.boolean(),
};
const password = z.string();
const USER_COLUMNS = 'id, username, display_name, email, role, active, created_at, mfa_enabled_at IS NOT NULL AS mfa_enabled';

export async function adminRoutes(app: FastifyInstance) {
  app.get('/api/users', async (req) => {
    requireRole(req, 'admin');
    return (await query(`SELECT ${USER_COLUMNS} FROM users ORDER BY username`)).rows;
  });

  app.post('/api/users', async (req, reply) => {
    requireRole(req, 'admin');
    await requireStepUp(req);
    const body = z.object({ ...userFields, email: userFields.email.default(''), active: userFields.active.default(true), password }).parse(req.body);
    await checkPassword(body.password, body);
    try {
      const { rows } = await query(
        `INSERT INTO users (username, display_name, email, role, active, password_hash) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${USER_COLUMNS}`,
        [body.username, body.display_name, body.email, body.role, body.active, await hashPassword(body.password)],
      );
      reply.code(201);
      return rows[0];
    } catch (err: any) {
      if (err.code === '23505') throw conflict('Username is already taken');
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>('/api/users/:id', async (req) => {
    const admin = requireRole(req, 'admin');
    await requireStepUp(req);
    const id = Number(req.params.id);
    const body = z.object({ ...userFields, password }).partial().omit({ username: true }).parse(req.body);
    if (id === admin.id && (body.active === false || (body.role && body.role !== 'admin'))) {
      throw badRequest('You cannot deactivate or demote yourself');
    }
    const { password: newPassword, ...fields } = body;
    if (newPassword) await checkPassword(newPassword, fields);
    const sets = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (newPassword) sets.push(['password_hash', await hashPassword(newPassword)]);
    if (!sets.length) throw badRequest('Nothing to update');
    const { rows } = await query(
      `UPDATE users SET ${sets.map(([k], i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING ${USER_COLUMNS}`,
      [id, ...sets.map(([, v]) => v)],
    );
    if (!rows[0]) throw notFound();
    // Changing role, status or password signs the user out everywhere.
    await query('DELETE FROM sessions WHERE user_id = $1 AND user_id <> $2', [id, admin.id]);
    return rows[0];
  });

  app.get('/api/admin/backups', async (req) => {
    requireRole(req, 'admin', 'problem_manager');
    return backupStatus();
  });

  type Id = { Params: { id: string } };
  app.get('/api/webhooks', async (req) => {
    requireRole(req, 'admin');
    return { webhooks: await webhooks.listWebhooks(), events: webhooks.EVENTS, formats: webhooks.FORMATS };
  });
  app.post('/api/webhooks', async (req, reply) => {
    const admin = requireRole(req, 'admin');
    await requireStepUp(req);
    reply.code(201);
    return webhooks.createWebhook(admin, webhooks.webhookSchema.parse(req.body));
  });
  app.put<Id>('/api/webhooks/:id', async (req) => {
    const admin = requireRole(req, 'admin');
    await requireStepUp(req);
    return webhooks.updateWebhook(admin, Number(req.params.id), webhooks.webhookSchema.parse(req.body));
  });
  app.delete<Id>('/api/webhooks/:id', async (req) => {
    const admin = requireRole(req, 'admin');
    await requireStepUp(req);
    await webhooks.deleteWebhook(admin, Number(req.params.id));
    return { ok: true };
  });
  app.post<Id>('/api/webhooks/:id/rotate', async (req) => {
    const admin = requireRole(req, 'admin');
    await requireStepUp(req);
    return webhooks.rotateSecret(admin, Number(req.params.id));
  });
  app.get<Id>('/api/webhooks/:id/deliveries', async (req) => {
    requireRole(req, 'admin');
    return webhooks.deliveries(Number(req.params.id));
  });
  app.post<Id>('/api/webhooks/:id/ping', async (req) => {
    const admin = requireRole(req, 'admin');
    return webhooks.ping(admin, Number(req.params.id));
  });

  app.get('/api/admin/mfa-policy', async (req) => {
    requireRole(req, 'admin');
    return { required_roles: await requiredRoles() };
  });
  app.put('/api/admin/mfa-policy', async (req) => {
    const admin = requireRole(req, 'admin');
    await requireStepUp(req);
    const body = z.object({ required_roles: z.array(z.enum(ROLES)).max(10) }).parse(req.body);
    return { required_roles: await setRequiredRoles(admin, body.required_roles) };
  });
  app.post<{ Params: { id: string } }>('/api/users/:id/mfa/reset', async (req) => {
    const admin = requireRole(req, 'admin');
    await requireStepUp(req);
    await disableMfa(admin, Number(req.params.id));
    return { ok: true };
  });

  app.get('/api/admin/security', async (req) => {
    requireRole(req, 'admin');
    return securityStatus();
  });

  app.post('/api/categories', async (req, reply) => {
    requireRole(req, 'admin', 'problem_manager');
    const body = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
    const { rows } = await query('INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING *', [body.name]);
    if (!rows[0]) throw conflict('Category already exists');
    reply.code(201);
    return rows[0];
  });

  app.patch<{ Params: { id: string } }>('/api/categories/:id', async (req) => {
    requireRole(req, 'admin', 'problem_manager');
    const body = z.object({ name: z.string().trim().min(1).max(100).optional(), active: z.boolean().optional() }).parse(req.body);
    const { rows } = await query(
      'UPDATE categories SET name = coalesce($2, name), active = coalesce($3, active) WHERE id = $1 RETURNING *',
      [Number(req.params.id), body.name ?? null, body.active ?? null],
    );
    if (!rows[0]) throw notFound();
    return rows[0];
  });
}
