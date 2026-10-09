import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { requireStepUp } from '../mfa.js';
import * as hooks from '../event-hooks.js';
import * as events from '../events.js';

type Id = { Params: { id: string } };

export async function eventRoutes(app: FastifyInstance) {
  // Inbound webhooks: their own scope, so the raw body is kept for signature checks (1 MB limit).
  await app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 1024 * 1024 }, (req, body, done) => {
      (req as any).rawBody = body;
      try {
        done(null, body ? JSON.parse(body as string) : {});
      } catch {
        const err = new Error('Body is not valid JSON') as Error & { statusCode: number };
        err.statusCode = 400;
        done(err, undefined);
      }
    });
    scope.post<Id>('/api/event-hooks/:id', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
      reply.code(202);
      return hooks.receiveHook(req, Number(req.params.id), (req as any).rawBody ?? '');
    });
  });

  app.post('/api/events', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    reply.code(202);
    return events.reportEvents(requireUser(req), events.reportEventsSchema.parse(req.body));
  });
  app.get('/api/alerts', async (req) => events.listAlerts(requireUser(req), events.listAlertsSchema.parse(req.query)));
  app.get<Id>('/api/alerts/:id', async (req) => events.getAlert(requireUser(req), Number(req.params.id)));
  app.post<Id>('/api/alerts/:id/ack', async (req) => events.acknowledgeAlert(requireUser(req), Number(req.params.id)));

  app.get('/api/event-rules', async (req) => events.listRules(requireUser(req)));
  app.post('/api/event-rules', async (req, reply) => {
    reply.code(201);
    return events.saveRule(requireUser(req), null, events.ruleSchema.parse(req.body));
  });
  app.put<Id>('/api/event-rules/:id', async (req) => events.saveRule(requireUser(req), Number(req.params.id), events.ruleSchema.parse(req.body)));
  app.delete<Id>('/api/event-rules/:id', async (req) => {
    await events.deleteRule(requireUser(req), Number(req.params.id));
    return { ok: true };
  });

  app.get('/api/maintenance-windows', async (req) => events.listMaintenance(requireUser(req), (req.query as any)?.past === 'true'));
  app.post('/api/maintenance-windows', async (req, reply) => {
    reply.code(201);
    return events.addMaintenance(requireUser(req), events.maintenanceSchema.parse(req.body));
  });
  app.delete<Id>('/api/maintenance-windows/:id', async (req) => {
    await events.deleteMaintenance(requireUser(req), Number(req.params.id));
    return { ok: true };
  });

  // Event sources hold credentials: administrators only, with step-up for changes.
  app.get('/api/event-sources', async (req) => hooks.listSources(requireUser(req)));
  app.post('/api/event-sources', async (req, reply) => {
    const user = requireUser(req, 'webhook.manage');
    await requireStepUp(req);
    reply.code(201);
    return hooks.createSource(user, hooks.sourceSchema.parse(req.body));
  });
  app.post<Id>('/api/event-sources/:id/rotate', async (req) => {
    const user = requireUser(req, 'webhook.manage');
    await requireStepUp(req);
    return hooks.rotateSource(user, Number(req.params.id));
  });
  app.patch<Id>('/api/event-sources/:id', async (req) =>
    hooks.updateSource(requireUser(req), Number(req.params.id), z.object({ enabled: z.boolean().optional(), ci_source_system: z.string().max(100).optional() }).parse(req.body)),
  );
  app.delete<Id>('/api/event-sources/:id', async (req) => {
    const user = requireUser(req, 'webhook.manage');
    await requireStepUp(req);
    await hooks.deleteSource(user, Number(req.params.id));
    return { ok: true };
  });
}
