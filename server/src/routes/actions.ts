import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import * as actions from '../actions.js';

type IdParams = { Params: { id: string } };

// Follow-up actions on any record (#184); the parent is a ref.
export async function actionRoutes(app: FastifyInstance) {
  app.get('/api/actions', async (req) => actions.listActions(requireUser(req), actions.listActionsSchema.parse(req.query)));

  app.post('/api/actions', { config: { idempotent: 'action.write' } }, async (req, reply) => {
    const user = requireUser(req);
    const { parent, ...input } = actions.newActionSchema.parse(req.body);
    const created = await actions.createAction(user, parent, input);
    reply.code(201);
    return created;
  });

  app.get<IdParams>('/api/actions/:id', async (req) => actions.getAction(requireUser(req), Number(req.params.id)));

  app.patch<IdParams>('/api/actions/:id', async (req) =>
    actions.updateAction(requireUser(req), Number(req.params.id), actions.updateActionSchema.parse(req.body)),
  );
}
