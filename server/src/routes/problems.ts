import type { FastifyInstance } from 'fastify';
import { hiddenRecordsExist } from '../visibility.js';
import { z } from 'zod';
import { modules } from '../modules.js';
import * as flow from '../flow.js';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { notFound } from '../errors.js';
import { query } from '../db.js';
import * as actions from '../actions.js';
import * as analyses from '../analyses.js';
import * as approvals from '../approvals.js';
import * as generic from '../generic.js';
import { GUIDES, guideById, guideMarkdown } from '../methods.js';
import { problemContext } from '../problem-context.js';
import * as problems from '../problems.js';
import * as reports from '../reports.js';
import { problemMarkdown } from '../export.js';
import { securityEvent } from '../security-events.js';
import * as review from '../review.js';
import { CLOSURE_CODES, EC_DECISIONS, ROLES, STATUSES, TRANSITIONS, WORKAROUND_EFFECTIVENESS } from '../workflow.js';

type RefParams = { Params: { ref: string } };

export async function problemRoutes(app: FastifyInstance) {
  app.get('/api/meta', async (req) => {
    requireUser(req, 'meta.read');
    const [categories, users] = await Promise.all([
      query('SELECT id, name, active FROM categories ORDER BY name'),
      query("SELECT id, display_name, role FROM users WHERE active AND role NOT IN ('viewer', 'integration') ORDER BY display_name"),
    ]);
    const { rows: setupRows } = await query("SELECT value FROM settings WHERE key = 'setup'");
    return {
      modules: modules(),
      setup_completed: !!setupRows[0]?.value?.completed,
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
      // Managers' numbers leave out restricted records they cannot see; the UI says so (a yes/no, never a count).
      hidden_records: ['admin', 'problem_manager'].includes(req.user!.role) ? await hiddenRecordsExist() : false,
    };
  });

  app.get('/api/dashboard', async (req) => problems.dashboard(requireUser(req, 'problem.read')));

  app.get('/api/problems', async (req) => {
    requireUser(req, 'problem.read');
    return problems.listProblems(problems.listSchema.parse(req.query));
  });

  app.post('/api/problems', { config: { idempotent: 'problem.create' } }, async (req, reply) => {
    const created = await problems.createProblem(requireUser(req), problems.createProblemSchema.parse(req.body));
    reply.code(201);
    return created;
  });

  app.get('/api/problems/similar', async (req) => {
    const user = requireUser(req, 'problem.read');
    const q = z.object({ text: z.string().max(5000), exclude: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(20).default(5) }).parse(req.query);
    return problems.findSimilar(user, q.text, q.exclude, q.limit);
  });

  app.post<RefParams>('/api/problems/:ref/duplicate', async (req) => {
    const body = z.object({ of: z.string().trim().min(1) }).parse(req.body);
    return problems.markDuplicate(requireUser(req), req.params.ref, body.of);
  });

  app.get<RefParams>('/api/problems/:ref', async (req) => {
    requireUser(req, 'problem.read');
    return problems.getProblem(req.params.ref);
  });

  app.get<RefParams>('/api/problems/:ref/export.md', async (req, reply) => {
    requireUser(req, 'problem.read');
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

  app.put<RefParams>('/api/problems/:ref/watch', async (req) => problems.setWatching(requireUser(req), req.params.ref, true));
  app.delete<RefParams>('/api/problems/:ref/watch', async (req) => problems.setWatching(requireUser(req), req.params.ref, false));

  app.post<RefParams>('/api/problems/:ref/comments', { config: { idempotent: 'problem.comment' } }, async (req) => {
    const body = z.object({ body: z.string().max(20000) }).parse(req.body);
    return problems.addComment(requireUser(req), req.params.ref, body.body);
  });

  app.post<RefParams>('/api/problems/:ref/links', { config: { idempotent: 'problem.link' } }, async (req) =>
    problems.addLink(requireUser(req), req.params.ref, problems.linkSchema.parse(req.body)),
  );

  app.delete<{ Params: { ref: string; id: string } }>('/api/problems/:ref/links/:id', async (req) =>
    problems.removeLink(requireUser(req), req.params.ref, Number(req.params.id)),
  );

  app.get('/api/actions', async (req) => {
    requireUser(req, 'problem.read');
    return actions.listActions(actions.listActionsSchema.parse(req.query));
  });

  app.post<RefParams>('/api/problems/:ref/actions', { config: { idempotent: 'action.write' } }, async (req, reply) => {
    const result = await actions.createAction(requireUser(req), req.params.ref, actions.createActionSchema.parse(req.body));
    reply.code(201);
    return result;
  });

  app.patch<{ Params: { ref: string; id: string } }>('/api/problems/:ref/actions/:id', async (req) =>
    actions.updateAction(requireUser(req), req.params.ref, Number(req.params.id), actions.updateActionSchema.parse(req.body)),
  );

  app.post<RefParams>('/api/problems/:ref/analyses', { config: { idempotent: 'analysis.write' } }, async (req, reply) => {
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
    requireUser(req, 'report.read');
    return reports.report(reports.reportSchema.parse(req.query));
  });

  app.get('/api/reports/problems.csv', async (req, reply) => {
    requireUser(req, 'report.read');
    const params = reports.reportSchema.parse(req.query);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="kernel-problems-${params.from}-${params.to}.csv"`);
    const csv = await reports.problemsCsv(params);
    // A bulk read of records is a security event (#64).
    securityEvent({ action: 'data.export', category: 'data_access', outcome: 'success', message: 'Problems exported as CSV', target: 'problems.csv', detail: { from: params.from, to: params.to, rows: Math.max(0, csv.split('\r\n').filter(Boolean).length - 1) } }, req);
    return csv;
  });

  app.get('/api/review', async (req) => {
    requireUser(req, 'review.read');
    return review.reviewAgenda(review.agendaSchema.parse(req.query));
  });

  app.get('/api/review/agenda.md', async (req, reply) => {
    requireUser(req, 'review.read');
    const agenda = await review.reviewAgenda(review.agendaSchema.parse(req.query));
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="problem-review-${agenda.generated_at.slice(0, 10)}.md"`);
    return review.agendaMarkdown(agenda);
  });

  // ---- Cross-practice (see docs/api-conventions.md) ----
  app.get('/api/search', async (req) => generic.search(requireUser(req, 'meta.read'), generic.searchSchema.parse(req.query)));
  app.get<RefParams>('/api/records/:ref', async (req) => generic.getRecord(requireUser(req), req.params.ref));
  app.get<RefParams>('/api/records/:ref/next-steps', async (req) => generic.nextSteps(requireUser(req), req.params.ref));
  app.get<RefParams>('/api/records/:ref/history', async (req) =>
    generic.recordHistory(requireUser(req), req.params.ref, z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query).limit));
  app.get<RefParams>('/api/records/:ref/impact', async (req) => generic.getImpact(requireUser(req), req.params.ref, z.object({ max_depth: z.coerce.number().int().optional() }).parse(req.query)));
  app.post<RefParams>('/api/records/:ref/comments', { config: { idempotent: 'problem.comment' } }, async (req, reply) => {
    await generic.addComment(requireUser(req), req.params.ref, z.object({ body: z.string().max(20000) }).parse(req.body).body);
    return reply.code(201).send({ ok: true });
  });
  app.post<RefParams>('/api/records/:ref/links', { config: { idempotent: 'problem.link' } }, async (req) => {
    const body = generic.linkBodySchema.parse(req.body);
    return generic.linkRecords(requireUser(req), req.params.ref, body.to, body);
  });
  app.get('/api/flow', async (req) => flow.processMap(requireUser(req, 'meta.read')));
  app.get('/api/health-tips', async (req) => flow.healthTips(requireUser(req, 'meta.read')));
  app.get('/api/my-work', async (req) => generic.myWork(requireUser(req, 'problem.read')));
  app.get('/api/nav/counts', async (req) => generic.navCounts(requireUser(req, 'meta.read')));

  app.get('/api/guides', async (req) => {
    requireUser(req, 'meta.read');
    return GUIDES;
  });
  app.get<{ Params: { id: string } }>('/api/guides/:id', async (req) => {
    requireUser(req, 'meta.read');
    const g = guideById(req.params.id);
    if (!g) throw notFound('No such guide');
    return { ...g, markdown: guideMarkdown(g) };
  });
  app.get<RefParams>('/api/problems/:ref/context', async (req) => problemContext(requireUser(req), req.params.ref));
  app.get<{ Params: { ref: string; id: string } }>('/api/problems/:ref/analyses/:id/check', async (req) =>
    analyses.checkProblemAnalysis(requireUser(req), req.params.ref, Number(req.params.id)),
  );
  app.post<{ Params: { ref: string; id: string } }>('/api/problems/:ref/analyses/:id/confirm', async (req) =>
    analyses.confirmAnalysis(requireUser(req), req.params.ref, Number(req.params.id)),
  );
  app.post<RefParams>('/api/problems/:ref/confirm', async (req) => {
    const body = z.object({ fields: z.array(z.enum(problems.PROPOSABLE as [string, ...string[]])).min(1) }).parse(req.body);
    return problems.confirmProposals(requireUser(req), req.params.ref, body.fields);
  });

  app.get('/api/approvals', async (req) => {
    requireUser(req, 'problem.read');
    return approvals.listApprovals();
  });
  app.post<{ Params: { id: string } }>('/api/approvals/:id/approve', async (req) =>
    approvals.decideApproval(req, requireUser(req), Number(req.params.id), true, approvals.decisionSchema.parse(req.body ?? {}).note),
  );
  app.post<{ Params: { id: string } }>('/api/approvals/:id/reject', async (req) =>
    approvals.decideApproval(req, requireUser(req), Number(req.params.id), false, approvals.decisionSchema.parse(req.body ?? {}).note),
  );

  app.get('/api/kedb', async (req) => {
    requireUser(req, 'kedb.read');
    const q = z.object({ q: z.string().max(200).optional(), include_resolved: z.enum(['true', 'false']).optional() }).parse(req.query);
    return problems.searchKnownErrors(q.q, q.include_resolved === 'true');
  });
}
