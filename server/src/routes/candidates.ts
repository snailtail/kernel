import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import * as candidates from '../candidates.js';
import * as config from '../candidate-config.js';

export async function candidateRoutes(app: FastifyInstance) {
  app.get('/api/candidates', async (req) => {
    requireUser(req, 'candidate.read');
    return candidates.listCandidates(candidates.listQuerySchema.parse(req.query));
  });
  app.put<{ Params: { rule: string } }>('/api/candidates/rules/:rule', async (req) =>
    candidates.setRule(requireUser(req, 'candidate.rule'), req.params.rule, candidates.ruleUpdateSchema.parse(req.body)),
  );
  app.get('/api/candidates/draft', async (req) => candidates.candidateDraft(requireUser(req), z.object({ key: z.string().max(300) }).parse(req.query).key));
  app.post('/api/candidates/create', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const user = requireUser(req);
    const body = { ...candidates.candidateActionSchema.parse(req.body), ...candidates.fromCandidateSchema.parse(req.body) };
    const created = await candidates.createFromCandidate(user, body);
    reply.code(201);
    return created;
  });
  app.post('/api/candidates/link', async (req) =>
    candidates.linkCandidate(requireUser(req), z.object({ ref: z.string().max(20) }).parse(req.body).ref, candidates.candidateActionSchema.parse(req.body)),
  );
  // Dismiss for the evidence it has now, or snooze with `until`; both need a reason.
  app.post('/api/candidates/dismiss', async (req) => candidates.decideCandidate(requireUser(req), candidates.decisionSchema.parse(req.body)));
  app.post('/api/candidates/restore', async (req) => candidates.restoreCandidate(requireUser(req), z.object({ key: z.string().max(300) }).parse(req.body).key));
  // External analysis reports a candidate with its evidence (idempotent on source + external_key).
  app.post('/api/candidates/report', { bodyLimit: 256 * 1024 }, async (req, reply) => {
    const result = await candidates.reportCandidate(requireUser(req), candidates.reportSchema.parse(req.body));
    reply.code(result.created ? 201 : 200);
    return result;
  });
  // The end-of-life table behind the eol_versions rule (#31): read with the candidates, kept by problem managers.
  app.get('/api/candidates/eol', async (req) => {
    requireUser(req, 'candidate.read');
    return config.listEol();
  });
  app.post('/api/candidates/eol', async (req, reply) => {
    const row = await config.saveEol(requireUser(req), null, config.eolSchema.parse(req.body));
    reply.code(201);
    return row;
  });
  app.put<{ Params: { id: string } }>('/api/candidates/eol/:id', async (req) => config.saveEol(requireUser(req), Number(req.params.id) || 0, config.eolSchema.parse(req.body)));
  app.delete<{ Params: { id: string } }>('/api/candidates/eol/:id', async (req) => config.deleteEol(requireUser(req), Number(req.params.id) || 0));
}
