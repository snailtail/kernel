import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireReason } from '../security/audit.js';
import { requireUser } from '../security/auth.js';
import { requireStepUp } from '../security/mfa.js';
import * as sso from '../security/sso.js';

export async function ssoRoutes(app: FastifyInstance) {
  app.get('/api/auth/options', async () => sso.loginOptions());
  app.get('/api/auth/sso/start', async (req, reply) => sso.startSso(req, reply));
  app.get('/api/auth/sso/callback', async (req, reply) => sso.finishSso(req, reply));
  app.post('/api/auth/access', async (req, reply) => sso.accessLogin(req, reply));

  app.get('/api/admin/sso', async (req) => sso.getSsoAdmin(requireUser(req, 'mfa.policy')));
  app.put('/api/admin/sso', async (req) => {
    const user = requireUser(req, 'mfa.policy');
    await requireStepUp(req);
    const body = sso.ssoSchema.extend({ reason: z.string().max(1000).optional() }).parse(req.body);
    const { reason, ...input } = body;
    return sso.saveSso(user, input, requireReason(reason));
  });
  app.put('/api/admin/cf-access', async (req) => {
    const user = requireUser(req, 'mfa.policy');
    await requireStepUp(req);
    const body = sso.cfAccessSchema.extend({ reason: z.string().max(1000).optional() }).parse(req.body);
    const { reason, ...input } = body;
    return sso.saveCfAccess(user, input, requireReason(reason));
  });
}
