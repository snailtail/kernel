import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import * as rules from '../rules.js';

type Id = { Params: { id: string } };

export async function ruleRoutes(app: FastifyInstance) {
  app.get('/api/rules', async (req) => rules.listRules(requireUser(req)));
  app.post('/api/rules', async (req, reply) => {
    reply.code(201);
    return rules.saveRule(requireUser(req), null, req.body);
  });
  app.post('/api/rules/proposals', async (req, reply) => {
    reply.code(201);
    return rules.proposeRule(requireUser(req), req.body);
  });
  app.post('/api/rules/dry-run', async (req) => rules.dryRunRule(requireUser(req), req.body));
  app.get<Id>('/api/rules/:id', async (req) => rules.getRule(requireUser(req), Number(req.params.id)));
  app.put<Id>('/api/rules/:id', async (req) => rules.saveRule(requireUser(req), Number(req.params.id), req.body));
  app.put<Id>('/api/rules/:id/enabled', async (req) => rules.setRuleEnabled(requireUser(req), Number(req.params.id), rules.enableSchema.parse(req.body).enabled));
  app.delete<Id>('/api/rules/:id', async (req) => rules.deleteRule(requireUser(req), Number(req.params.id)));
}
