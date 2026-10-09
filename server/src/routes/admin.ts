import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword, requireUser } from '../auth.js';
import { backupStatus } from '../backups.js';
import { disable as disableMfa, requiredRoles, requireStepUp, setRequiredRoles } from '../mfa.js';
import { checkPassword } from '../passwords.js';
import { securityStatus } from '../security.js';
import * as webhooks from '../webhooks.js';
import { query } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit, auditQuerySchema, queryAudit, requireReason, verifyChain } from '../audit.js';
import { csvCell } from '../reports.js';
import { approvalsRequired, setApprovalsRequired } from '../approvals.js';
import { ROLES } from '../workflow.js';

const userFields = {
  username: z.string().trim().min(2).max(50).regex(/^[a-zA-Z0-9._-]+$/, 'Use letters, digits, dot, dash or underscore'),
  display_name: z.string().trim().min(1).max(100),
  email: z.string().trim().max(200),
  role: z.enum(ROLES),
  active: z.boolean(),
  /** Source systems an integration account may report CIs for (exact names, e.g. vCenter). */
  ci_source_systems: z.array(z.string().trim().min(1).max(100)).max(20),
  /** Standard change templates a pipeline (integration) account may register changes from. */
  change_templates: z.array(z.number().int()).max(50),
};
const password = z.string();
const USER_COLUMNS = 'id, username, display_name, email, role, active, ci_source_systems, change_templates, created_at, mfa_enabled_at IS NOT NULL AS mfa_enabled';

export async function adminRoutes(app: FastifyInstance) {
  app.get('/api/users', async (req) => {
    requireUser(req, 'user.manage');
    return (await query(`SELECT ${USER_COLUMNS} FROM users ORDER BY username`)).rows;
  });

  app.post('/api/users', async (req, reply) => {
    requireUser(req, 'user.manage');
    await requireStepUp(req);
    const body = z.object({ ...userFields, email: userFields.email.default(''), active: userFields.active.default(true), ci_source_systems: userFields.ci_source_systems.default([]), change_templates: userFields.change_templates.default([]), password }).parse(req.body);
    await checkPassword(body.password, body);
    try {
      const { rows } = await query(
        `INSERT INTO users (username, display_name, email, role, active, ci_source_systems, change_templates, password_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${USER_COLUMNS}`,
        [body.username, body.display_name, body.email, body.role, body.active, body.ci_source_systems, body.change_templates, await hashPassword(body.password)],
      );
      await audit(null, { entity_type: 'user', entity_ref: body.username, action: 'create', changes: { display_name: body.display_name, email: body.email, role: body.role, active: body.active, ci_source_systems: body.ci_source_systems } });
      reply.code(201);
      return rows[0];
    } catch (err: any) {
      if (err.code === '23505') throw conflict('Username is already taken');
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>('/api/users/:id', async (req) => {
    const admin = requireUser(req, 'user.manage');
    await requireStepUp(req);
    const id = Number(req.params.id);
    const body = z.object({ ...userFields, password, reason: z.string().max(1000).optional() }).partial().omit({ username: true }).parse(req.body);
    if (id === admin.id && (body.active === false || (body.role && body.role !== 'admin'))) {
      throw badRequest('You cannot deactivate or demote yourself');
    }
    const { password: newPassword, reason, ...fields } = body;
    const { rows: before } = await query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
    if (!before[0]) throw notFound();
    // Changing someone's role, status or password is sensitive: a reason is required and recorded.
    const sourcesChanged = (fields.ci_source_systems !== undefined && JSON.stringify(fields.ci_source_systems) !== JSON.stringify(before[0].ci_source_systems))
      || (fields.change_templates !== undefined && JSON.stringify(fields.change_templates) !== JSON.stringify(before[0].change_templates));
    const sensitive = id !== admin.id && (newPassword || sourcesChanged || (fields.role && fields.role !== before[0].role) || (fields.active !== undefined && fields.active !== before[0].active));
    const why = sensitive ? requireReason(reason) : reason;
    if (newPassword) await checkPassword(newPassword, { username: before[0].username, ...fields });
    const sets = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (newPassword) sets.push(['password_hash', await hashPassword(newPassword)]);
    if (!sets.length) throw badRequest('Nothing to update');
    const { rows } = await query(
      `UPDATE users SET ${sets.map(([k], i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING ${USER_COLUMNS}`,
      [id, ...sets.map(([, v]) => v)],
    );
    if (!rows[0]) throw notFound();
    const changes: Record<string, unknown> = Object.fromEntries(
      Object.entries(fields).filter(([k, v]) => v !== undefined && JSON.stringify(before[0][k]) !== JSON.stringify(v)).map(([k, v]) => [k, { from: before[0][k], to: v }]),
    );
    if (newPassword) changes.password = '[changed]';
    await audit(null, { entity_type: 'user', entity_ref: before[0].username, action: 'update', changes, reason: why });
    // Changing role, status or password signs the user out everywhere.
    await query('DELETE FROM sessions WHERE user_id = $1 AND user_id <> $2', [id, admin.id]);
    return rows[0];
  });

  app.get('/api/admin/backups', async (req) => {
    requireUser(req, 'backup.read');
    return backupStatus();
  });

  type Id = { Params: { id: string } };
  app.get('/api/webhooks', async (req) => {
    requireUser(req, 'webhook.manage');
    return { webhooks: await webhooks.listWebhooks(), events: webhooks.EVENTS, formats: webhooks.FORMATS };
  });
  app.post('/api/webhooks', async (req, reply) => {
    const admin = requireUser(req, 'webhook.manage');
    await requireStepUp(req);
    reply.code(201);
    return webhooks.createWebhook(admin, webhooks.webhookSchema.parse(req.body));
  });
  app.put<Id>('/api/webhooks/:id', async (req) => {
    const admin = requireUser(req, 'webhook.manage');
    await requireStepUp(req);
    return webhooks.updateWebhook(admin, Number(req.params.id), webhooks.webhookSchema.parse(req.body));
  });
  app.delete<Id & { Querystring: { reason?: string } }>('/api/webhooks/:id', async (req) => {
    const admin = requireUser(req, 'webhook.manage');
    await requireStepUp(req);
    await webhooks.deleteWebhook(admin, Number(req.params.id), requireReason(req.query.reason));
    return { ok: true };
  });
  app.post<Id>('/api/webhooks/:id/rotate', async (req) => {
    const admin = requireUser(req, 'webhook.manage');
    await requireStepUp(req);
    return webhooks.rotateSecret(admin, Number(req.params.id));
  });
  app.get<Id>('/api/webhooks/:id/deliveries', async (req) => {
    requireUser(req, 'webhook.manage');
    return webhooks.deliveries(Number(req.params.id));
  });
  app.post<Id>('/api/webhooks/:id/ping', async (req) => {
    const admin = requireUser(req, 'webhook.manage');
    return webhooks.ping(admin, Number(req.params.id));
  });

  app.get('/api/admin/mcp-approvals', async (req) => {
    requireUser(req, 'mfa.policy');
    return { required: await approvalsRequired() };
  });
  app.put('/api/admin/mcp-approvals', async (req) => {
    const admin = requireUser(req, 'mfa.policy');
    await requireStepUp(req);
    const body = z.object({ required: z.boolean(), reason: z.string().max(1000).optional() }).parse(req.body);
    return setApprovalsRequired(admin, body.required, requireReason(body.reason));
  });

  app.get('/api/admin/mfa-policy', async (req) => {
    requireUser(req, 'mfa.policy');
    return { required_roles: await requiredRoles() };
  });
  app.put('/api/admin/mfa-policy', async (req) => {
    const admin = requireUser(req, 'mfa.policy');
    await requireStepUp(req);
    const body = z.object({ required_roles: z.array(z.enum(ROLES)).max(10), reason: z.string().max(1000).optional() }).parse(req.body);
    return { required_roles: await setRequiredRoles(admin, body.required_roles, requireReason(body.reason)) };
  });
  app.post<{ Params: { id: string } }>('/api/users/:id/mfa/reset', async (req) => {
    const admin = requireUser(req, 'user.manage');
    await requireStepUp(req);
    const body = z.object({ reason: z.string().max(1000).optional() }).parse(req.body ?? {});
    await disableMfa(admin, Number(req.params.id), requireReason(body.reason));
    return { ok: true };
  });

  app.get('/api/admin/security', async (req) => {
    requireUser(req, 'security.read');
    return securityStatus();
  });

  app.post('/api/categories', async (req, reply) => {
    requireUser(req, 'category.manage');
    const body = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
    const { rows } = await query('INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING *', [body.name]);
    if (!rows[0]) throw conflict('Category already exists');
    await audit(null, { entity_type: 'category', entity_ref: body.name, action: 'create' });
    reply.code(201);
    return rows[0];
  });

  app.patch<{ Params: { id: string } }>('/api/categories/:id', async (req) => {
    requireUser(req, 'category.manage');
    const body = z.object({ name: z.string().trim().min(1).max(100).optional(), active: z.boolean().optional() }).parse(req.body);
    const { rows: before } = await query('SELECT * FROM categories WHERE id = $1', [Number(req.params.id)]);
    if (!before[0]) throw notFound();
    const { rows } = await query(
      'UPDATE categories SET name = coalesce($2, name), active = coalesce($3, active) WHERE id = $1 RETURNING *',
      [Number(req.params.id), body.name ?? null, body.active ?? null],
    );
    await audit(null, {
      entity_type: 'category',
      entity_ref: before[0].name,
      action: 'update',
      changes: Object.fromEntries(Object.entries(body).filter(([k, v]) => v !== undefined && before[0][k] !== v).map(([k, v]) => [k, { from: before[0][k], to: v }])),
    });
    return rows[0];
  });

  // ---- Audit trail ----------------------------------------------------------------------------
  app.get('/api/audit', async (req) => {
    requireUser(req, 'audit.read');
    return queryAudit(auditQuerySchema.parse(req.query));
  });
  app.get('/api/audit.csv', async (req, reply) => {
    requireUser(req, 'audit.read');
    const filter = auditQuerySchema.parse({ ...(req.query as object), limit: 1000 });
    const rows = await queryAudit(filter);
    await audit(null, { entity_type: 'audit_log', action: 'export', changes: { filter, rows: rows.length } });
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="kernel-audit.csv"');
    const cols = ['id', 'at', 'actor_name', 'actor_type', 'channel', 'ip', 'entity_type', 'entity_ref', 'action', 'changes', 'reason'] as const;
    return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(c === 'changes' ? JSON.stringify(r[c]) : c === 'at' ? (r.at as Date).toISOString() : r[c])).join(','))].join('\r\n') + '\r\n';
  });
  app.get('/api/audit/verify', async (req) => {
    requireUser(req, 'audit.read');
    return verifyChain();
  });
}
