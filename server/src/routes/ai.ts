import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as ai from '../ai.js';
import { requireReason } from '../audit.js';
import { requireUser } from '../auth.js';
import { requireStepUp } from '../mfa.js';

type Id = { Params: { id: string } };

export async function aiRoutes(app: FastifyInstance) {
  app.get('/api/ai/status', async (req) => {
    requireUser(req, 'meta.read');
    return ai.aiStatus();
  });
  app.post('/api/ai/summarize', async (req) => ai.summarize(requireUser(req, 'meta.read'), z.object({ ref: z.string().max(30) }).parse(req.body).ref));
  app.post('/api/ai/review-wording', async (req) => ai.reviewWording(requireUser(req, 'incident.read'), z.object({ ref: z.string().max(20) }).parse(req.body).ref));
  app.post('/api/ai/analyze-log', async (req) => ai.analyzeLog(requireUser(req, 'meta.read'), z.object({ attachment_id: z.number().int() }).parse(req.body).attachment_id));

  app.get('/api/admin/ai/providers', async (req) => ai.listProviders(requireUser(req, 'mfa.policy')));
  app.post('/api/admin/ai/providers', async (req, reply) => {
    const user = requireUser(req, 'mfa.policy');
    await requireStepUp(req);
    reply.code(201);
    return ai.saveProvider(user, null, ai.providerSchema.parse(req.body));
  });
  app.put<Id>('/api/admin/ai/providers/:id', async (req) => {
    const user = requireUser(req, 'mfa.policy');
    await requireStepUp(req);
    return ai.saveProvider(user, Number(req.params.id), ai.providerSchema.parse(req.body));
  });
  app.delete<Id>('/api/admin/ai/providers/:id', async (req) => {
    const user = requireUser(req, 'mfa.policy');
    await requireStepUp(req);
    return ai.deleteProvider(user, Number(req.params.id));
  });
  app.post<Id>('/api/admin/ai/providers/:id/test', async (req) => ai.testProvider(requireUser(req, 'mfa.policy'), Number(req.params.id), z.object({ model: z.string().max(200).optional() }).parse(req.body ?? {}).model));
  app.put('/api/admin/ai/routing', async (req) => {
    const user = requireUser(req, 'mfa.policy');
    await requireStepUp(req);
    const body = z.object({ routing: ai.routingSchema, reason: z.string().max(1000).optional() }).parse(req.body);
    return ai.saveRouting(user, body.routing, requireReason(body.reason));
  });
}
