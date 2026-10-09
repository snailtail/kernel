import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import { requireStepUp } from '../mfa.js';
import * as conn from '../connectors.js';

type Id = { Params: { id: string } };

export async function connectorRoutes(app: FastifyInstance) {
  // The push contract: CIs and relationships from one source, optionally as a complete snapshot.
  app.post('/api/cmdb/ci-batch', { bodyLimit: 16 * 1024 * 1024 }, async (req) => conn.ciBatch(requireUser(req), conn.ciBatchSchema.parse(req.body)));

  // Connectors hold credentials: administrators only, with step-up for changes.
  app.get('/api/connectors', async (req) => ({ types: Object.fromEntries(Object.entries(conn.CONNECTOR_TYPES).map(([k, t]) => [k, t.label])), connectors: await conn.listConnectors(requireUser(req)) }));
  app.post('/api/connectors', async (req, reply) => {
    const user = requireUser(req, 'user.manage');
    await requireStepUp(req);
    reply.code(201);
    return conn.saveConnector(user, null, conn.connectorSchema.parse(req.body));
  });
  app.put<Id>('/api/connectors/:id', async (req) => {
    const user = requireUser(req, 'user.manage');
    await requireStepUp(req);
    return conn.saveConnector(user, Number(req.params.id), conn.connectorSchema.parse(req.body));
  });
  app.delete<Id>('/api/connectors/:id', async (req) => {
    const user = requireUser(req, 'user.manage');
    await requireStepUp(req);
    await conn.deleteConnector(user, Number(req.params.id));
    return { ok: true };
  });
  app.post<Id>('/api/connectors/:id/test', async (req) => conn.testConnector(requireUser(req), Number(req.params.id)));
  app.post<Id>('/api/connectors/:id/run', async (req) => conn.runConnector(Number(req.params.id), 'manual', requireUser(req)));
  app.get<Id>('/api/connectors/:id/runs', async (req) => conn.connectorRuns(requireUser(req), Number(req.params.id)));
}
