import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../security/auth.js';
import * as sp from '../development/sprints.js';
import * as wi from '../development/work-items.js';

type RefParams = { Params: { ref: string } };
type TeamParams = { Params: { id: string } };
type SprintParams = { Params: { id: string } };
type RetroParams = { Params: { id: string; itemId: string } };

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
  app.get<TeamParams>('/api/teams/:id/board', async (req) => sp.getBoard(requireUser(req), Number(req.params.id), sp.boardSchema.parse(req.query)));

  // Sprints (#166).
  app.get('/api/sprints', async (req) => sp.listSprints(requireUser(req), sp.listSprintsSchema.parse(req.query)));
  app.post('/api/sprints', async (req, reply) => {
    const created = await sp.createSprint(requireUser(req), sp.createSprintSchema.parse(req.body));
    reply.code(201);
    return created;
  });
  app.get<SprintParams>('/api/sprints/:id', async (req) => sp.getSprint(requireUser(req), Number(req.params.id)));
  app.patch<SprintParams>('/api/sprints/:id', async (req) => sp.updateSprint(requireUser(req), Number(req.params.id), sp.updateSprintSchema.parse(req.body)));
  app.post<SprintParams>('/api/sprints/:id/items', async (req) => sp.planSprint(requireUser(req), Number(req.params.id), sp.sprintItemsSchema.parse(req.body)));
  app.post<SprintParams>('/api/sprints/:id/start', async (req) => sp.startSprint(requireUser(req), Number(req.params.id)));
  app.post<SprintParams>('/api/sprints/:id/complete', async (req) => sp.completeSprint(requireUser(req), Number(req.params.id), sp.completeSprintSchema.parse(req.body ?? {})));
  app.post<SprintParams>('/api/sprints/:id/retro', async (req) => sp.addRetroItem(requireUser(req), Number(req.params.id), sp.retroItemSchema.parse(req.body)));
  app.delete<RetroParams>('/api/sprints/:id/retro/:itemId', async (req) => sp.removeRetroItem(requireUser(req), Number(req.params.id), Number(req.params.itemId)));
  app.post<RetroParams>('/api/sprints/:id/retro/:itemId/improvement', async (req) =>
    sp.retroItemToImprovement(requireUser(req), Number(req.params.id), Number(req.params.itemId), sp.retroImprovementSchema.parse(req.body ?? {})),
  );
}
