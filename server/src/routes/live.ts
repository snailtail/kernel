import type { FastifyInstance } from 'fastify';
import { requireUser } from '../security/auth.js';
import { openStream, subscribe, subscribeSchema } from '../reporting/live.js';

export async function liveRoutes(app: FastifyInstance) {
  // Server-Sent Events (#70): change notices for what the page shows, and who else has a record open.
  app.get('/api/live', async (req, reply) => openStream(req, reply, requireUser(req)));
  app.put<{ Params: { id: string } }>('/api/live/:id', async (req) => subscribe(req, requireUser(req), req.params.id, subscribeSchema.parse(req.body)));
}
