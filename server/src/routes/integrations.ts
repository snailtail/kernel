import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import * as integrations from '../integrations.js';
import { createProblemSchema } from '../problems.js';

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

  app.get('/api/candidates', async (req) => {
    requireUser(req, 'candidate.read');
    return integrations.listCandidates();
  });
  app.put('/api/candidates/rule', async (req) => integrations.setRule(requireUser(req, 'candidate.rule'), integrations.ruleSchema.parse(req.body)));
  app.post('/api/candidates/create', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const body = { ...integrations.candidateActionSchema.parse(req.body), problem: createProblemSchema.parse((req.body as any)?.problem) };
    const created = await integrations.createFromCandidate(requireUser(req), body);
    reply.code(201);
    return created;
  });
  app.post('/api/candidates/link', async (req) => {
    const body = { ...integrations.candidateActionSchema.parse(req.body), ref: z.string().parse((req.body as any)?.ref) };
    return integrations.linkCandidate(requireUser(req), body.ref, body.record_ids, body.incident_refs, body.alert_ids);
  });
  app.post('/api/candidates/dismiss', async (req) =>
    {
      const body = integrations.candidateActionSchema.parse(req.body);
      return integrations.dismissRecords(requireUser(req), body.record_ids, body.incident_refs, body.alert_ids);
    },
  );
}
