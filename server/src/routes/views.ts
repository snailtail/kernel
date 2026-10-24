import type { FastifyInstance } from 'fastify';
import { requireUser } from '../security/auth.js';
import * as views from '../reporting/views.js';

type Id = { Params: { id: string } };

export async function viewRoutes(app: FastifyInstance) {
  app.get('/api/views', async (req) => views.listViews(requireUser(req), views.listSchema.parse(req.query).list));
  app.post('/api/views', async (req, reply) => {
    reply.code(201);
    return views.createView(requireUser(req), views.viewSchema.parse(req.body));
  });
  app.put('/api/views/default', async (req) => views.setDefault(requireUser(req), views.defaultSchema.parse(req.body)));
  app.patch<Id>('/api/views/:id', async (req) => views.updateView(requireUser(req), Number(req.params.id), views.updateViewSchema.parse(req.body)));
  app.delete<Id>('/api/views/:id', async (req) => views.deleteView(requireUser(req), Number(req.params.id)));
}
