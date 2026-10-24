import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { aiDataPolicy, setAiDataPolicy } from '../records/attachments.js';
import { refreshVisibility } from '../security/visibility.js';
import { requireUser } from '../security/auth.js';
import { backupStatus } from '../security/backups.js';
import { disable as disableMfa, requiredRoles, requireStepUp, setRequiredRoles } from '../security/mfa.js';
import { securityStatus } from '../security/security.js';
import * as webhooks from '../notifications/webhooks.js';
import { auditCsv, auditQuerySchema, queryAudit, requireReason, verifyChain } from '../security/audit.js';
import { privacySchema, privacySettings, querySecurityEvents, savePrivacySettings, securityQuerySchema, securitySummary } from '../security/security-events.js';
import { alertingSchema, alertingStatus, saveAlertingSettings } from '../events/security-alerts.js';
import { approvalsRequired, setApprovalsRequired } from '../changes/approvals.js';
import { createCategory, updateCategory } from '../records/meta.js';
import * as users from '../people/users.js';
import { legacyRole, ROLES } from '../problems/workflow.js';

export async function adminRoutes(app: FastifyInstance) {
  app.get('/api/users', async (req) => {
    requireUser(req, 'user.manage');
    return users.listUsers();
  });

  app.post('/api/users', async (req, reply) => {
    requireUser(req, 'user.manage');
    await requireStepUp(req);
    const created = await users.createUser(users.createUserSchema.parse(req.body));
    reply.code(201);
    return created;
  });

  app.patch<{ Params: { id: string } }>('/api/users/:id', async (req) => {
    const admin = requireUser(req, 'user.manage');
    await requireStepUp(req);
    return users.updateUser(admin, Number(req.params.id), users.updateUserSchema.parse(req.body));
  });

  // Erasure (GDPR): see users.eraseUser.
  app.post<{ Params: { id: string } }>('/api/users/:id/erase', async (req) => {
    const admin = requireUser(req, 'user.manage');
    await requireStepUp(req);
    const reason = requireReason(z.object({ reason: z.string().max(1000).optional() }).parse(req.body ?? {}).reason);
    await users.eraseUser(admin, Number(req.params.id), reason);
    return { ok: true };
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
    requireUser(req, 'webhook.manage');
    await requireStepUp(req);
    reply.code(201);
    return webhooks.createWebhook(webhooks.webhookSchema.parse(req.body));
  });
  app.put<Id>('/api/webhooks/:id', async (req) => {
    requireUser(req, 'webhook.manage');
    await requireStepUp(req);
    return webhooks.updateWebhook(Number(req.params.id), webhooks.webhookSchema.parse(req.body));
  });
  // The reason travels in the body: query strings end up in proxy and request logs, and reasons may describe people.
  app.post<Id>('/api/webhooks/:id/delete', async (req) => {
    requireUser(req, 'webhook.manage');
    await requireStepUp(req);
    const body = z.object({ reason: z.string().max(1000).optional() }).parse(req.body ?? {});
    await webhooks.deleteWebhook(Number(req.params.id), requireReason(body.reason));
    return { ok: true };
  });
  app.post<Id>('/api/webhooks/:id/rotate', async (req) => {
    requireUser(req, 'webhook.manage');
    await requireStepUp(req);
    return webhooks.rotateSecret(Number(req.params.id));
  });
  app.get<Id>('/api/webhooks/:id/deliveries', async (req) => {
    requireUser(req, 'webhook.manage');
    return webhooks.deliveries(Number(req.params.id));
  });
  app.post<Id>('/api/webhooks/:id/ping', async (req) => {
    requireUser(req, 'webhook.manage');
    return webhooks.ping(Number(req.params.id));
  });

  app.get('/api/admin/mcp-approvals', async (req) => {
    requireUser(req, 'mfa.policy');
    return { required: await approvalsRequired() };
  });
  app.put('/api/admin/mcp-approvals', async (req) => {
    requireUser(req, 'mfa.policy');
    await requireStepUp(req);
    const body = z.object({ required: z.boolean(), reason: z.string().max(1000).optional() }).parse(req.body);
    return setApprovalsRequired(body.required, requireReason(body.reason));
  });

  app.get('/api/admin/ai-data', async (req) => {
    requireUser(req, 'mfa.policy');
    return aiDataPolicy();
  });
  app.put('/api/admin/ai-data', async (req) => {
    const admin = requireUser(req, 'mfa.policy');
    await requireStepUp(req);
    const body = z.object({ attachment_images: z.boolean(), flagged_text: z.boolean(), restricted_records: z.boolean().default(false), reason: z.string().max(1000).optional() }).parse(req.body);
    const saved = await setAiDataPolicy(admin, { attachment_images: body.attachment_images, flagged_text: body.flagged_text, restricted_records: body.restricted_records }, requireReason(body.reason));
    await refreshVisibility();
    return saved;
  });

  app.get('/api/admin/mfa-policy', async (req) => {
    requireUser(req, 'mfa.policy');
    return { required_roles: await requiredRoles() };
  });
  app.put('/api/admin/mfa-policy', async (req) => {
    requireUser(req, 'mfa.policy');
    await requireStepUp(req);
    const body = z.object({ required_roles: z.array(z.preprocess(legacyRole, z.enum(ROLES))).max(10), reason: z.string().max(1000).optional() }).parse(req.body);
    return { required_roles: await setRequiredRoles(body.required_roles, requireReason(body.reason)) };
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
    const created = await createCategory(body.name);
    reply.code(201);
    return created;
  });

  app.patch<{ Params: { id: string } }>('/api/categories/:id', async (req) => {
    requireUser(req, 'category.manage');
    const body = z.object({ name: z.string().trim().min(1).max(100).optional(), active: z.boolean().optional() }).parse(req.body);
    return updateCategory(Number(req.params.id), body);
  });

  // ---- Audit trail ----------------------------------------------------------------------------
  app.get('/api/audit', async (req) => {
    requireUser(req, 'audit.read');
    return queryAudit(auditQuerySchema.parse(req.query));
  });
  app.get('/api/audit.csv', async (req, reply) => {
    requireUser(req, 'audit.read');
    const csv = await auditCsv(auditQuerySchema.parse({ ...(req.query as object), limit: 1000 }));
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="kernel-audit.csv"');
    return csv;
  });
  app.get('/api/audit/verify', async (req) => {
    requireUser(req, 'audit.read');
    return verifyChain();
  });

  // ---- Security events (#64) ---------------------------------------------------------------
  app.get('/api/security-events', async (req) => {
    requireUser(req, 'security.read');
    return querySecurityEvents(securityQuerySchema.parse(req.query));
  });
  app.get('/api/security-events/summary', async (req) => {
    requireUser(req, 'security.read');
    return securitySummary();
  });
  // Detection rules and their thresholds (part 2): changing them weakens or strengthens monitoring, so step-up and a reason.
  app.get('/api/admin/security-alerting', async (req) => {
    requireUser(req, 'security.read');
    return alertingStatus();
  });
  app.put('/api/admin/security-alerting', async (req) => {
    requireUser(req, 'mfa.policy');
    await requireStepUp(req);
    const { reason, ...value } = alertingSchema.extend({ reason: z.string().max(1000).optional() }).parse(req.body);
    return saveAlertingSettings(alertingSchema.parse(value), requireReason(reason));
  });
  app.get('/api/admin/privacy', async (req) => {
    requireUser(req, 'security.read');
    return privacySettings();
  });
  app.put('/api/admin/privacy', async (req) => {
    requireUser(req, 'mfa.policy');
    await requireStepUp(req);
    const { reason, ...value } = privacySchema.extend({ reason: z.string().max(1000).optional() }).parse(req.body);
    return savePrivacySettings(value, requireReason(reason));
  });
}
