import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../security/auth.js';
import { requireStepUp } from '../security/mfa.js';
import * as dev from '../integrations/dev.js';

type Ref = { Params: { ref: string } };
type Id = { Params: { id: string } };

export async function devRoutes(app: FastifyInstance) {
  // GitHub deliveries: their own scope, so only this route keeps the raw body (signature check before parsing).
  await app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));
    scope.post<Id>('/api/dev-hooks/:id', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
      reply.code(202);
      return dev.receiveDevHook(req, Number(req.params.id), typeof req.body === 'string' ? req.body : '');
    });
  });

  app.get<Ref>('/api/records/:ref/dev-links', async (req) => dev.listDevLinks(requireUser(req), req.params.ref));
  app.post<Ref>('/api/records/:ref/dev-links', async (req) => dev.addDevLink(requireUser(req), req.params.ref, z.object({ url: z.string().max(2000) }).parse(req.body).url));
  app.delete<{ Params: { ref: string; id: string } }>('/api/records/:ref/dev-links/:id', async (req) => dev.removeDevLink(requireUser(req), req.params.ref, Number(req.params.id)));

  app.get('/api/dev-sources', async (req) => dev.listSources(requireUser(req)));
  app.post('/api/dev-sources', async (req, reply) => {
    const user = requireUser(req, 'change.manage');
    await requireStepUp(req);
    reply.code(201);
    return dev.createSource(user, dev.sourceSchema.parse(req.body));
  });
  app.patch<Id>('/api/dev-sources/:id', async (req) => {
    const user = requireUser(req, 'change.manage');
    await requireStepUp(req);
    return dev.updateSource(user, Number(req.params.id), dev.sourceSchema.partial().parse(req.body));
  });
  app.post<Id>('/api/dev-sources/:id/rotate', async (req) => {
    const user = requireUser(req, 'change.manage');
    await requireStepUp(req);
    return dev.rotateSourceSecret(user, Number(req.params.id));
  });
  app.delete<Id>('/api/dev-sources/:id', async (req) => dev.deleteSource(requireUser(req), Number(req.params.id)));

  // Deployment targets: which CIs a deploy changes, and whether a production deploy registers a standard change.
  app.get<Id>('/api/dev-sources/:id/targets', async (req) => dev.listTargets(requireUser(req), Number(req.params.id)));
  app.post<Id>('/api/dev-sources/:id/targets', async (req, reply) => {
    const user = requireUser(req, 'change.manage');
    await requireStepUp(req);
    reply.code(201);
    return dev.createTarget(user, Number(req.params.id), dev.targetSchema.parse(req.body));
  });
  app.delete<Id>('/api/dev-targets/:id', async (req) => dev.deleteTarget(requireUser(req), Number(req.params.id)));
}
