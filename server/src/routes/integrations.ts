import type { FastifyInstance } from 'fastify';
import { requireUser } from '../security/auth.js';
import * as integrations from '../integrations/integrations.js';

export async function integrationRoutes(app: FastifyInstance) {
  app.get('/api/systems', async (req) => {
    requireUser(req, 'system.read');
    return integrations.listSystems();
  });
  app.post('/api/systems', async (req, reply) => {
    const created = await integrations.saveSystem(requireUser(req), null, integrations.systemSchema.parse(req.body));
    reply.code(201);
    return created;
  });
  app.put<{ Params: { id: string } }>('/api/systems/:id', async (req) =>
    integrations.saveSystem(requireUser(req), Number(req.params.id), integrations.systemSchema.parse(req.body)),
  );

  // Inbound records from ITSM and monitoring tools.
  app.post('/api/integrations/records', { bodyLimit: 4 * 1024 * 1024 }, async (req) => integrations.ingestRecords(requireUser(req), integrations.ingestSchema.parse(req.body)));
}
