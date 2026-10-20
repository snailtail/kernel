import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import * as im from '../improvements.js';

type RefParams = { Params: { ref: string } };

export async function improvementRoutes(app: FastifyInstance) {
  app.get('/api/improvements', async (req) => im.listImprovements(requireUser(req), im.listImprovementsSchema.parse(req.query)));
  app.get('/api/improvements/model', async (req) => {
    requireUser(req, 'improvement.read');
    return { steps: im.IMPROVEMENT_MODEL };
  });
  app.post('/api/improvements', { config: { idempotent: 'improvement.write' } }, async (req, reply) => {
    const created = await im.createImprovement(requireUser(req), im.createImprovementSchema.parse(req.body));
    reply.code(201);
    return created;
  });
  app.get<RefParams>('/api/improvements/:ref', async (req) => im.getImprovement(requireUser(req), req.params.ref));
  app.patch<RefParams>('/api/improvements/:ref', async (req) => im.updateImprovement(requireUser(req), req.params.ref, im.updateImprovementSchema.parse(req.body)));
  app.post<RefParams>('/api/improvements/:ref/transition', async (req) => im.transitionImprovement(requireUser(req), req.params.ref, im.transitionImprovementSchema.parse(req.body)));
  app.post<RefParams>('/api/improvements/:ref/comments', { config: { idempotent: 'improvement.write' } }, async (req) =>
    im.addImprovementComment(requireUser(req), req.params.ref, z.object({ body: z.string().max(20000) }).parse(req.body).body),
  );
  app.post<RefParams>('/api/improvements/:ref/links', async (req) => im.addImprovementLink(requireUser(req), req.params.ref, im.improvementLinkSchema.parse(req.body)));
  app.delete<{ Params: { ref: string; id: string } }>('/api/improvements/:ref/links/:id', async (req) => im.removeImprovementLink(requireUser(req), req.params.ref, Number(req.params.id)));
  app.post<RefParams>('/api/problems/:ref/improvement', async (req, reply) => {
    reply.code(201);
    return im.improvementFromProblem(requireUser(req), req.params.ref, im.fromProblemSchema.parse(req.body));
  });
}
