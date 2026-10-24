import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireReason } from '../security/audit.js';
import { requireUser } from '../security/auth.js';
import { requireStepUp } from '../security/mfa.js';
import * as vis from '../security/visibility.js';

type Ref = { Params: { ref: string } };

export async function visibilityRoutes(app: FastifyInstance) {
  app.put<Ref>('/api/records/:ref/visibility', async (req) => {
    const user = requireUser(req, 'record.restrict');
    const body = vis.visibilitySchema.parse(req.body);
    return vis.setVisibility(user, req.params.ref, body, requireReason(body.reason));
  });
  app.post<Ref>('/api/records/:ref/break-glass', async (req) => {
    const user = requireUser(req, 'record.break_glass');
    await requireStepUp(req);
    return vis.breakGlass(user, req.params.ref, requireReason(z.object({ reason: z.string().max(1000).optional() }).parse(req.body ?? {}).reason));
  });
  app.get('/api/admin/visibility', async (req) => {
    requireUser(req, 'mfa.policy');
    const s = await vis.refreshVisibility();
    return { team_scoped: s.team_scoped, restricted_categories: s.restricted_categories, break_glass: await vis.activeBreakGlass() };
  });
  app.put('/api/admin/visibility', async (req) => {
    const admin = requireUser(req, 'mfa.policy');
    await requireStepUp(req);
    const body = z.object({
      team_scoped: z.object({ incident: z.boolean(), problem: z.boolean(), change: z.boolean(), work_item: z.boolean().optional() }),
      restricted_categories: z.array(z.number().int()).max(100),
      reason: z.string().max(1000).optional(),
    }).parse(req.body);
    return vis.saveVisibilitySettings(admin, { team_scoped: body.team_scoped, restricted_categories: body.restricted_categories }, requireReason(body.reason));
  });
}
