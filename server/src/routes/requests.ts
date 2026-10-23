import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import { forbidden } from '../errors.js';
import * as rq from '../requests.js';

type RefParams = { Params: { ref: string } };
type TaskParams = { Params: { ref: string; id: string } };

export async function requestRoutes(app: FastifyInstance) {
  // The catalogue.
  app.get('/api/request-items', async (req) => rq.listRequestItems(requireUser(req), rq.listItemsSchema.parse(req.query)));
  app.get('/api/request-items/options', async (req) => rq.itemOptions(requireUser(req)));
  app.get<{ Params: { id: string } }>('/api/request-items/:id', async (req) => rq.getRequestItem(requireUser(req), Number(req.params.id)));
  app.post('/api/request-items', async (req, reply) => {
    const created = await rq.saveRequestItem(requireUser(req), null, rq.requestItemSchema.parse(req.body));
    reply.code(201);
    return created;
  });
  app.put<{ Params: { id: string } }>('/api/request-items/:id', async (req) => rq.saveRequestItem(requireUser(req), Number(req.params.id), rq.requestItemSchema.parse(req.body)));

  // Requests.
  app.get('/api/requests', async (req) => rq.listRequests(requireUser(req), rq.listRequestsSchema.parse(req.query)));
  app.post('/api/requests', { config: { idempotent: 'request.write' } }, async (req, reply) => {
    const created = await rq.createRequest(requireUser(req), rq.createRequestSchema.parse(req.body));
    reply.code(201);
    return created;
  });
  app.get<RefParams>('/api/requests/:ref', async (req) => rq.getRequest(requireUser(req), req.params.ref));
  app.patch<RefParams>('/api/requests/:ref', async (req) => rq.updateRequest(requireUser(req), req.params.ref, rq.updateRequestSchema.parse(req.body)));
  app.post<RefParams>('/api/requests/:ref/transition', async (req) => {
    const user = requireUser(req);
    const input = rq.transitionRequestSchema.parse(req.body);
    // Approving and rejecting are a person's decision: never by API token.
    if (input.to !== 'cancelled' && req.headers.authorization) throw forbidden('Approvals are decided by a person in the web UI');
    return rq.transitionRequest(user, req.params.ref, input);
  });
  app.post<RefParams>('/api/requests/:ref/approval', async (req) => {
    if (req.headers.authorization) throw forbidden('Approvals are decided by a person in the web UI');
    return rq.decideRequest(requireUser(req), req.params.ref, rq.decisionSchema.parse(req.body));
  });
  app.post<TaskParams>('/api/requests/:ref/tasks/:id/complete', async (req) => {
    // A webhook task's receiver calls back with the task's token instead of signing in (#44).
    const token = req.headers['x-kernel-task-token'];
    if (!req.user && typeof token === 'string') return rq.completeTaskByToken(req, req.params.ref, Number(req.params.id), token, rq.callbackSchema.parse(req.body ?? {}));
    return rq.completeRequestTask(requireUser(req), req.params.ref, Number(req.params.id), rq.completeTaskSchema.parse(req.body ?? {}));
  });
  app.patch<TaskParams>('/api/requests/:ref/tasks/:id', async (req) => rq.assignRequestTask(requireUser(req), req.params.ref, Number(req.params.id), rq.assignTaskSchema.parse(req.body)));
  app.post<RefParams>('/api/requests/:ref/comments', { config: { idempotent: 'request.write' } }, async (req) => {
    const user = requireUser(req);
    const body = rq.requestCommentSchema.parse(req.body);
    return rq.addRequestComment(user, req.params.ref, body.body, body.to_requester);
  });
  app.post<RefParams>('/api/requests/:ref/links', async (req) => rq.addRequestLink(requireUser(req), req.params.ref, rq.requestLinkSchema.parse(req.body)));
  app.delete<TaskParams>('/api/requests/:ref/links/:id', async (req) => rq.removeRequestLink(requireUser(req), req.params.ref, Number(req.params.id)));
}
