import type { FastifyInstance } from 'fastify';
import { requireUser } from '../security/auth.js';
import { requireStepUp } from '../security/mfa.js';
import * as oncall from '../people/oncall.js';
import { rateLimit } from '../core/ratelimit.js';

type Team = { Params: { id: string } };

export async function onCallRoutes(app: FastifyInstance) {
  // Who is on call per team (cached for a minute; a tool that cannot be reached says so).
  app.get<{ Querystring: { team?: string } }>('/api/on-call', async (req) =>
    oncall.onCall(requireUser(req), req.query.team ? [Number(req.query.team)] : undefined),
  );
  app.get<Team>('/api/teams/:id/paging', async (req) => oncall.getPaging(requireUser(req), Number(req.params.id)));
  // Paging targets hold credentials: administrators, with step-up.
  app.put<Team>('/api/teams/:id/paging', async (req) => {
    const user = requireUser(req, 'team.manage');
    await requireStepUp(req);
    return oncall.savePaging(user, Number(req.params.id), oncall.targetSchema.parse(req.body));
  });
  app.delete<Team>('/api/teams/:id/paging', async (req) => {
    const user = requireUser(req, 'team.manage');
    await requireStepUp(req);
    await oncall.deletePaging(user, Number(req.params.id));
    return { ok: true };
  });
  app.put<Team>('/api/teams/:id/rotation', async (req) => oncall.saveRotation(requireUser(req), Number(req.params.id), oncall.rotationSchema.parse(req.body)));
  app.post<Team>('/api/teams/:id/rotation/overrides', async (req) => oncall.addOverride(requireUser(req), Number(req.params.id), oncall.overrideSchema.parse(req.body)));
  app.delete<{ Params: { id: string; override: string } }>('/api/teams/:id/rotation/overrides/:override', async (req) =>
    oncall.removeOverride(requireUser(req), Number(req.params.id), Number(req.params.override)),
  );
  // The paging tool's webhook: authenticated with the target's token in a header (never the URL: it would land in
  // request logs) or, for PagerDuty, its webhook signature over the raw body. Never as a user.
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 256 * 1024 }, (req, body, done) => {
      (req as any).rawBody = body;
      try { done(null, body ? JSON.parse(body as string) : {}); } catch { done(Object.assign(new Error('Body is not valid JSON'), { statusCode: 400 }), undefined); }
    });
    scope.post<Team>('/api/paging/:id/inbound', async (req, reply) => {
      rateLimit(`paging-inbound:${req.params.id}`, 120, 60_000);
      const auth = req.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : String(req.headers['x-kernel-token'] ?? '');
      reply.code(202);
      return oncall.receiveInbound(Number(req.params.id), { token, pagerDutySignature: req.headers['x-pagerduty-signature'] as string | undefined, raw: (req as any).rawBody ?? '' }, req.body ?? {});
    });
  });
}
