import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { query } from '../db.js';
import * as problems from '../problems.js';
import { CLOSURE_CODES, ROLES, STATUSES, TRANSITIONS } from '../workflow.js';

type RefParams = { Params: { ref: string } };

export async function problemRoutes(app: FastifyInstance) {
  app.get('/api/meta', async (req) => {
    requireUser(req);
    const [categories, users] = await Promise.all([
      query('SELECT id, name, active FROM categories ORDER BY name'),
      query("SELECT id, display_name, role FROM users WHERE active AND role <> 'viewer' ORDER BY display_name"),
    ]);
    return {
      statuses: STATUSES,
      transitions: TRANSITIONS,
      closure_codes: CLOSURE_CODES,
      roles: ROLES,
      link_kinds: problems.LINK_KINDS,
      categories: categories.rows,
      assignees: users.rows,
    };
  });

  app.get('/api/dashboard', async (req) => problems.dashboard(requireUser(req)));

  app.get('/api/problems', async (req) => {
    requireUser(req);
    return problems.listProblems(problems.listSchema.parse(req.query));
  });

  app.post('/api/problems', async (req, reply) => {
    const created = await problems.createProblem(requireUser(req), problems.createProblemSchema.parse(req.body));
    reply.code(201);
    return created;
  });

  app.get<RefParams>('/api/problems/:ref', async (req) => {
    requireUser(req);
    return problems.getProblem(req.params.ref);
  });

  app.patch<RefParams>('/api/problems/:ref', async (req) =>
    problems.updateProblem(requireUser(req), req.params.ref, problems.updateProblemSchema.parse(req.body)),
  );

  app.post<RefParams>('/api/problems/:ref/transition', async (req) =>
    problems.transitionProblem(requireUser(req), req.params.ref, problems.transitionSchema.parse(req.body)),
  );

  app.post<RefParams>('/api/problems/:ref/comments', async (req) => {
    const body = z.object({ body: z.string().max(20000) }).parse(req.body);
    return problems.addComment(requireUser(req), req.params.ref, body.body);
  });

  app.post<RefParams>('/api/problems/:ref/links', async (req) =>
    problems.addLink(requireUser(req), req.params.ref, problems.linkSchema.parse(req.body)),
  );

  app.delete<{ Params: { ref: string; id: string } }>('/api/problems/:ref/links/:id', async (req) =>
    problems.removeLink(requireUser(req), req.params.ref, Number(req.params.id)),
  );

  app.get('/api/kedb', async (req) => {
    requireUser(req);
    const q = z.object({ q: z.string().max(200).optional(), include_resolved: z.enum(['true', 'false']).optional() }).parse(req.query);
    return problems.searchKnownErrors(q.q, q.include_resolved === 'true');
  });
}
