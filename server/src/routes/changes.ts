import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../security/auth.js';
import * as ch from '../changes/changes.js';
import { forbidden } from '../core/errors.js';

type RefParams = { Params: { ref: string } };
type Id = { Params: { id: string } };

export async function changeRoutes(app: FastifyInstance) {
  app.get('/api/changes', async (req) => ch.listChanges(requireUser(req), ch.listChangesSchema.parse(req.query)));
  app.get('/api/changes/schedule', async (req) => ch.changeSchedule(requireUser(req), ch.scheduleSchema.parse(req.query)));
  app.post('/api/changes', { config: { idempotent: 'change.create' } }, async (req, reply) => {
    const created = await ch.createChange(requireUser(req), ch.createChangeSchema.parse(req.body));
    reply.code(201);
    return created;
  });
  app.post('/api/changes/register', { config: { idempotent: 'change.register' } }, async (req, reply) => {
    reply.code(201);
    return ch.registerStandardChange(requireUser(req), ch.registerSchema.parse(req.body));
  });
  app.get<RefParams>('/api/changes/:ref', async (req) => ch.getChange(requireUser(req), req.params.ref));
  app.patch<RefParams>('/api/changes/:ref', async (req) => ch.updateChange(requireUser(req), req.params.ref, ch.updateChangeSchema.parse(req.body)));
  app.post<RefParams>('/api/changes/:ref/transition', async (req) => ch.transitionChange(requireUser(req), req.params.ref, ch.transitionChangeSchema.parse(req.body)));
  app.post<RefParams>('/api/changes/:ref/votes', async (req) => {
    // Authorising a change is a person's decision: never through an API token or MCP.
    if (req.headers.authorization) throw forbidden('Changes are approved by a person in the web UI');
    return ch.voteOnChange(requireUser(req), req.params.ref, ch.voteSchema.parse(req.body));
  });
  app.post<RefParams>('/api/changes/:ref/comments', { config: { idempotent: 'change.update' } }, async (req) =>
    ch.addChangeComment(requireUser(req), req.params.ref, z.object({ body: z.string().max(20000) }).parse(req.body).body),
  );
  app.post<RefParams>('/api/changes/:ref/links', async (req) => ch.addChangeLink(requireUser(req), req.params.ref, ch.changeLinkSchema.parse(req.body)));
  app.post<RefParams>('/api/changes/:ref/cis', async (req) => ch.setChangeCi(requireUser(req), req.params.ref, z.object({ ci: z.string().max(30) }).parse(req.body).ci, true));
  app.delete<{ Params: { ref: string; ci: string } }>('/api/changes/:ref/cis/:ci', async (req) => ch.setChangeCi(requireUser(req), req.params.ref, req.params.ci, false));
  app.post<RefParams>('/api/problems/:ref/change', async (req, reply) => {
    reply.code(201);
    return ch.raiseChangeForProblem(requireUser(req), req.params.ref, ch.createChangeSchema.partial().parse(req.body ?? {}));
  });

  app.get('/api/change-templates', async (req) => ch.listTemplates(requireUser(req)));
  app.post('/api/change-templates', async (req, reply) => {
    reply.code(201);
    return ch.saveTemplate(requireUser(req), null, ch.templateSchema.parse(req.body));
  });
  app.put<Id>('/api/change-templates/:id', async (req) => ch.saveTemplate(requireUser(req), Number(req.params.id), ch.templateSchema.parse(req.body)));
  app.get('/api/change-freezes', async (req) => ch.listFreezes(requireUser(req)));
  app.post('/api/change-freezes', async (req, reply) => {
    reply.code(201);
    return ch.addFreeze(requireUser(req), ch.freezeSchema.parse(req.body));
  });
  app.delete<Id>('/api/change-freezes/:id', async (req) => {
    await ch.deleteFreeze(requireUser(req), Number(req.params.id));
    return { ok: true };
  });
}
