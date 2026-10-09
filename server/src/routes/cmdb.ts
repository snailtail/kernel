import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import * as cmdb from '../cmdb.js';

type RefParams = { Params: { ref: string } };

export async function cmdbRoutes(app: FastifyInstance) {
  app.get('/api/ci-types', async (req) => {
    requireUser(req, 'ci.read');
    return cmdb.listTypes();
  });
  app.put('/api/ci-types', async (req) => cmdb.saveType(requireUser(req), cmdb.typeSchema.parse(req.body)));

  app.get('/api/cis', async (req) => cmdb.listCis(requireUser(req), cmdb.listCisSchema.parse(req.query)));
  app.post('/api/cis', { config: { idempotent: 'ci.manage' } }, async (req, reply) => {
    const created = await cmdb.createCi(requireUser(req), cmdb.createCiSchema.parse(req.body));
    reply.code(201);
    return created;
  });
  app.post('/api/cis/upsert', { bodyLimit: 4 * 1024 * 1024 }, async (req) => cmdb.upsertCis(requireUser(req), cmdb.upsertSchema.parse(req.body)));
  app.get<RefParams>('/api/cis/:ref', async (req) => cmdb.getCi(requireUser(req), req.params.ref));
  app.patch<RefParams>('/api/cis/:ref', async (req) => cmdb.updateCi(requireUser(req), req.params.ref, cmdb.updateCiSchema.parse(req.body)));
  app.post<RefParams>('/api/cis/:ref/transition', async (req) => cmdb.transitionCi(requireUser(req), req.params.ref, cmdb.transitionCiSchema.parse(req.body)));
  app.post<RefParams>('/api/cis/:ref/comments', { config: { idempotent: 'ci.annotate' } }, async (req) =>
    cmdb.addCiComment(requireUser(req), req.params.ref, z.object({ body: z.string().max(20000) }).parse(req.body).body),
  );
  app.post<RefParams>('/api/cis/:ref/links', { config: { idempotent: 'ci.annotate' } }, async (req) =>
    cmdb.addCiLink(requireUser(req), req.params.ref, cmdb.ciLinkSchema.parse(req.body)),
  );
  app.delete<{ Params: { ref: string; id: string } }>('/api/cis/:ref/links/:id', async (req) => cmdb.removeCiLink(requireUser(req), req.params.ref, Number(req.params.id)));
}
