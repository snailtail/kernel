import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { query } from '../db.js';
import * as actions from '../actions.js';
import * as analyses from '../analyses.js';
import * as problems from '../problems.js';
import * as reports from '../reports.js';
import { problemMarkdown } from '../export.js';
import * as review from '../review.js';
import { CLOSURE_CODES, EC_DECISIONS, ROLES, STATUSES, TRANSITIONS, WORKAROUND_EFFECTIVENESS } from '../workflow.js';

type RefParams = { Params: { ref: string } };

export async function problemRoutes(app: FastifyInstance) {
  app.get('/api/meta', async (req) => {
    requireUser(req);
    const [categories, users] = await Promise.all([
      query('SELECT id, name, active FROM categories ORDER BY name'),
      query("SELECT id, display_name, role FROM users WHERE active AND role NOT IN ('viewer', 'integration') ORDER BY display_name"),
    ]);
    return {
      statuses: STATUSES,
      transitions: TRANSITIONS,
      closure_codes: CLOSURE_CODES,
      roles: ROLES,
      link_kinds: problems.LINK_KINDS,
      action_statuses: actions.ACTION_STATUSES,
      techniques: analyses.TECHNIQUES,
      ec_decisions: EC_DECISIONS,
      workaround_effectiveness: WORKAROUND_EFFECTIVENESS,
      mcp_url: config.mcpUrl,
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

  app.get('/api/problems/similar', async (req) => {
    requireUser(req);
    const q = z.object({ text: z.string().max(5000), exclude: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(20).default(5) }).parse(req.query);
    return problems.findSimilar(q.text, q.exclude, q.limit);
  });

  app.post<RefParams>('/api/problems/:ref/duplicate', async (req) => {
    const body = z.object({ of: z.string().trim().min(1) }).parse(req.body);
    return problems.markDuplicate(requireUser(req), req.params.ref, body.of);
  });

  app.get<RefParams>('/api/problems/:ref', async (req) => {
    requireUser(req);
    return problems.getProblem(req.params.ref);
  });

  app.get<RefParams>('/api/problems/:ref/export.md', async (req, reply) => {
    requireUser(req);
    const md = await problemMarkdown(req.params.ref);
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${req.params.ref.toUpperCase()}.md"`);
    return md;
  });

  app.patch<RefParams>('/api/problems/:ref', async (req) =>
    problems.updateProblem(requireUser(req), req.params.ref, problems.updateProblemSchema.parse(req.body)),
  );

  app.post<RefParams>('/api/problems/:ref/transition', async (req) =>
    problems.transitionProblem(requireUser(req), req.params.ref, problems.transitionSchema.parse(req.body)),
  );

  app.put<RefParams>('/api/problems/:ref/assessment', async (req) =>
    problems.assessProblem(requireUser(req), req.params.ref, problems.assessmentSchema.parse(req.body)),
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

  app.get('/api/actions', async (req) => {
    requireUser(req);
    return actions.listActions(actions.listActionsSchema.parse(req.query));
  });

  app.post<RefParams>('/api/problems/:ref/actions', async (req, reply) => {
    const result = await actions.createAction(requireUser(req), req.params.ref, actions.createActionSchema.parse(req.body));
    reply.code(201);
    return result;
  });

  app.patch<{ Params: { ref: string; id: string } }>('/api/problems/:ref/actions/:id', async (req) =>
    actions.updateAction(requireUser(req), req.params.ref, Number(req.params.id), actions.updateActionSchema.parse(req.body)),
  );

  app.post<RefParams>('/api/problems/:ref/analyses', async (req, reply) => {
    const result = await analyses.createAnalysis(requireUser(req), req.params.ref, analyses.createAnalysisSchema.parse(req.body));
    reply.code(201);
    return result;
  });

  app.patch<{ Params: { ref: string; id: string } }>('/api/problems/:ref/analyses/:id', async (req) =>
    analyses.updateAnalysis(requireUser(req), req.params.ref, Number(req.params.id), analyses.updateAnalysisSchema.parse(req.body)),
  );

  app.delete<{ Params: { ref: string; id: string } }>('/api/problems/:ref/analyses/:id', async (req) =>
    analyses.deleteAnalysis(requireUser(req), req.params.ref, Number(req.params.id)),
  );

  app.get('/api/reports', async (req) => {
    requireUser(req);
    return reports.report(reports.reportSchema.parse(req.query));
  });

  app.get('/api/reports/problems.csv', async (req, reply) => {
    requireUser(req);
    const params = reports.reportSchema.parse(req.query);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="kernel-problems-${params.from}-${params.to}.csv"`);
    return reports.problemsCsv(params);
  });

  app.get('/api/review', async (req) => {
    requireUser(req);
    return review.reviewAgenda(review.agendaSchema.parse(req.query));
  });

  app.get('/api/review/agenda.md', async (req, reply) => {
    requireUser(req);
    const agenda = await review.reviewAgenda(review.agendaSchema.parse(req.query));
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="problem-review-${agenda.generated_at.slice(0, 10)}.md"`);
    return review.agendaMarkdown(agenda);
  });

  app.get('/api/kedb', async (req) => {
    requireUser(req);
    const q = z.object({ q: z.string().max(200).optional(), include_resolved: z.enum(['true', 'false']).optional() }).parse(req.query);
    return problems.searchKnownErrors(q.q, q.include_resolved === 'true');
  });
}
