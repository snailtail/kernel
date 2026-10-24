import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../security/auth.js';
import * as wi from '../development/work-items.js';

type RefParams = { Params: { ref: string } };
type TeamParams = { Params: { id: string } };

export async function developmentRoutes(app: FastifyInstance) {
  app.get('/api/work-items', async (req) => wi.listWorkItems(requireUser(req), wi.listWorkItemsSchema.parse(req.query)));
  app.post('/api/work-items', { config: { idempotent: 'work.write' } }, async (req, reply) => {
    const created = await wi.createWorkItem(requireUser(req), wi.createWorkItemSchema.parse(req.body));
    reply.code(201);
    return created;
  });
  app.get<RefParams>('/api/work-items/:ref', async (req) => wi.getWorkItem(requireUser(req), req.params.ref));
  app.patch<RefParams>('/api/work-items/:ref', async (req) => wi.updateWorkItem(requireUser(req), req.params.ref, wi.updateWorkItemSchema.parse(req.body)));
  app.post<RefParams>('/api/work-items/:ref/transition', async (req) => wi.transitionWorkItem(requireUser(req), req.params.ref, wi.transitionWorkItemSchema.parse(req.body)));
  app.post<RefParams>('/api/work-items/:ref/move', async (req) => wi.moveWorkItem(requireUser(req), req.params.ref, wi.moveWorkItemSchema.parse(req.body)));
  app.post<RefParams>('/api/work-items/:ref/comments', { config: { idempotent: 'work.write' } }, async (req) =>
    wi.addWorkItemComment(requireUser(req), req.params.ref, z.object({ body: z.string().max(20000) }).parse(req.body).body),
  );
  app.post<RefParams>('/api/work-items/:ref/links', async (req) => wi.addWorkItemLink(requireUser(req), req.params.ref, wi.workItemLinkSchema.parse(req.body)));
  app.delete<{ Params: { ref: string; id: string } }>('/api/work-items/:ref/links/:id', async (req) => wi.removeWorkItemLink(requireUser(req), req.params.ref, Number(req.params.id)));
  app.get<TeamParams>('/api/teams/:id/work-definitions', async (req) => wi.getWorkDefinitions(requireUser(req), Number(req.params.id)));
  app.put<TeamParams>('/api/teams/:id/work-definitions', async (req) => wi.saveWorkDefinitions(requireUser(req), Number(req.params.id), wi.workDefinitionsSchema.parse(req.body)));
}
