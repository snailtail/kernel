import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../security/auth.js';
import * as cmdb from '../cmdb/cmdb.js';
import * as graph from '../cmdb/cmdb-graph.js';
import * as retire from '../cmdb/ci-retire.js';
import * as problemCis from '../problems/problem-cis.js';

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
  app.get('/api/cis/retire-proposals', async (req) => retire.retireProposals(requireUser(req)));
  app.post('/api/cis/retire', async (req) => retire.retireCis(requireUser(req), retire.retireSchema.parse(req.body)));
  app.get<RefParams>('/api/cis/:ref', async (req) => cmdb.getCi(requireUser(req), req.params.ref));
  app.patch<RefParams>('/api/cis/:ref', async (req) => cmdb.updateCi(requireUser(req), req.params.ref, cmdb.updateCiSchema.parse(req.body)));
  app.post<RefParams>('/api/cis/:ref/transition', async (req) => cmdb.transitionCi(requireUser(req), req.params.ref, cmdb.transitionCiSchema.parse(req.body)));
  app.post<RefParams>('/api/cis/:ref/comments', { config: { idempotent: 'ci.annotate' } }, async (req) =>
    cmdb.addCiComment(requireUser(req), req.params.ref, z.object({ body: z.string().max(20000) }).parse(req.body).body),
  );
  app.post<RefParams>('/api/cis/:ref/links', { config: { idempotent: 'ci.annotate' } }, async (req) =>
    cmdb.addCiLink(requireUser(req), req.params.ref, cmdb.ciLinkSchema.parse(req.body)),
  );
  app.get('/api/ci-relationship-types', async (req) => {
    requireUser(req, 'ci.read');
    return graph.relationshipTypes();
  });
  app.post<RefParams>('/api/cis/:ref/relationships', async (req) => graph.addRelationship(requireUser(req), req.params.ref, graph.relationshipSchema.parse(req.body)));
  app.delete<{ Params: { ref: string; id: string } }>('/api/cis/:ref/relationships/:id', async (req) =>
    graph.removeRelationship(requireUser(req), req.params.ref, Number(req.params.id)),
  );
  app.post('/api/ci-relationships/sync', { bodyLimit: 4 * 1024 * 1024 }, async (req) => graph.syncRelationships(requireUser(req), graph.syncSchema.parse(req.body)));
  app.get<RefParams>('/api/cis/:ref/impact', async (req) => graph.impact(requireUser(req), req.params.ref, graph.impactSchema.parse(req.query)));

  // Problems ↔ CIs (#26)
  app.post<RefParams>('/api/problems/:ref/cis', async (req) => problemCis.linkCiToProblem(requireUser(req), req.params.ref, problemCis.linkCiSchema.parse(req.body).ci));
  app.delete<{ Params: { ref: string; ci: string } }>('/api/problems/:ref/cis/:ci', async (req) => problemCis.unlinkCiFromProblem(requireUser(req), req.params.ref, req.params.ci));

  type GroupParams = { Params: { id: string } };
  app.get('/api/ci-groups', async (req) => graph.listGroups(requireUser(req)));
  app.post('/api/ci-groups', async (req, reply) => {
    const g = await graph.saveGroup(requireUser(req), null, graph.groupSchema.parse(req.body));
    reply.code(201);
    return g;
  });
  app.get<GroupParams>('/api/ci-groups/:id', async (req) => graph.getGroup(requireUser(req), Number(req.params.id)));
  app.put<GroupParams>('/api/ci-groups/:id', async (req) => graph.saveGroup(requireUser(req), Number(req.params.id), graph.groupSchema.parse(req.body)));
  app.delete<GroupParams>('/api/ci-groups/:id', async (req) => {
    await graph.deleteGroup(requireUser(req), Number(req.params.id));
    return { ok: true };
  });
  app.put<{ Params: { id: string; ref: string } }>('/api/ci-groups/:id/members/:ref', async (req) => graph.setMember(requireUser(req), Number(req.params.id), req.params.ref, true));
  app.delete<{ Params: { id: string; ref: string } }>('/api/ci-groups/:id/members/:ref', async (req) => graph.setMember(requireUser(req), Number(req.params.id), req.params.ref, false));

  app.delete<{ Params: { ref: string; id: string } }>('/api/cis/:ref/links/:id', async (req) => cmdb.removeCiLink(requireUser(req), req.params.ref, Number(req.params.id)));
}
