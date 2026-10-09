import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { requireStepUp } from '../mfa.js';
import * as setup from '../setup.js';

export async function setupRoutes(app: FastifyInstance) {
  app.get('/api/admin/modules', async (req) => {
    requireUser(req, 'meta.read');
    return setup.getModules();
  });
  app.put('/api/admin/modules', async (req) => {
    const user = requireUser(req, 'user.manage');
    await requireStepUp(req);
    const body = setup.modulesSchema.extend({ reason: z.string().trim().max(1000).optional() }).parse(req.body);
    const { reason, ...modules } = body;
    return setup.setModules(user, modules, reason);
  });
  app.get('/api/setup', async (req) => {
    requireUser(req, 'user.manage');
    return setup.setupState();
  });
  app.post('/api/setup', async (req) => {
    const user = requireUser(req, 'user.manage');
    await requireStepUp(req);
    return setup.completeSetup(user, setup.setupSchema.parse(req.body));
  });
  app.post('/api/setup/demo/remove', async (req) => {
    const user = requireUser(req, 'user.manage');
    await requireStepUp(req);
    return setup.removeDemoData(user);
  });
  app.get('/api/templates', async (req) => setup.listTemplates(requireUser(req), (req.query as any)?.kind));
  app.post('/api/templates', async (req, reply) => {
    reply.code(201);
    return setup.saveTemplate(requireUser(req), null, setup.templateSchema.parse(req.body));
  });
  app.put<{ Params: { id: string } }>('/api/templates/:id', async (req) => setup.saveTemplate(requireUser(req), Number(req.params.id), setup.templateSchema.parse(req.body)));
}
