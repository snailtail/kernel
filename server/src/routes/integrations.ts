import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, requireUser } from '../auth.js';
import * as integrations from '../integrations.js';
import { createProblemSchema } from '../problems.js';

export async function integrationRoutes(app: FastifyInstance) {
  app.get('/api/systems', async (req) => {
    requireUser(req);
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
  app.post('/api/integrations/records', async (req) => integrations.ingestRecords(requireUser(req), integrations.ingestSchema.parse(req.body)));

  app.get('/api/candidates', async (req) => {
    requireUser(req);
    return integrations.listCandidates();
  });
  app.put('/api/candidates/rule', async (req) => integrations.setRule(requireRole(req, 'admin', 'problem_manager'), integrations.ruleSchema.parse(req.body)));
  app.post('/api/candidates/create', async (req, reply) => {
    const body = integrations.candidateActionSchema.extend({ problem: createProblemSchema }).parse(req.body);
    const created = await integrations.createFromCandidate(requireUser(req), body);
    reply.code(201);
    return created;
  });
  app.post('/api/candidates/link', async (req) => {
    const body = integrations.candidateActionSchema.extend({ ref: z.string() }).parse(req.body);
    return integrations.linkCandidate(requireUser(req), body.ref, body.record_ids);
  });
  app.post('/api/candidates/dismiss', async (req) =>
    integrations.dismissRecords(requireUser(req), integrations.candidateActionSchema.parse(req.body).record_ids),
  );
}
