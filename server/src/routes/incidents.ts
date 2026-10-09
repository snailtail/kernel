import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import * as inc from '../incidents.js';

type RefParams = { Params: { ref: string } };

export async function incidentRoutes(app: FastifyInstance) {
  app.get('/api/incidents', async (req) => inc.listIncidents(requireUser(req), inc.listIncidentsSchema.parse(req.query)));
  app.post('/api/incidents', { config: { idempotent: 'incident.create' } }, async (req, reply) => {
    const created = await inc.createIncident(requireUser(req), inc.createIncidentSchema.parse(req.body));
    reply.code(201);
    return created;
  });
  app.get<RefParams>('/api/incidents/:ref', async (req) => inc.getIncident(requireUser(req), req.params.ref));
  app.patch<RefParams>('/api/incidents/:ref', async (req) => inc.updateIncident(requireUser(req), req.params.ref, inc.updateIncidentSchema.parse(req.body)));
  app.post<RefParams>('/api/incidents/:ref/transition', async (req) => inc.transitionIncident(requireUser(req), req.params.ref, inc.transitionIncidentSchema.parse(req.body)));
  app.post<RefParams>('/api/incidents/:ref/comments', { config: { idempotent: 'incident.update' } }, async (req) =>
    inc.addIncidentComment(requireUser(req), req.params.ref, inc.incidentCommentSchema.parse(req.body)),
  );
  app.post<RefParams>('/api/incidents/:ref/links', async (req) => inc.addIncidentLink(requireUser(req), req.params.ref, inc.incidentLinkSchema.parse(req.body)));
  app.delete<{ Params: { ref: string; id: string } }>('/api/incidents/:ref/links/:id', async (req) => inc.removeIncidentLink(requireUser(req), req.params.ref, Number(req.params.id)));
  app.post<RefParams>('/api/incidents/:ref/cis', async (req) => inc.setIncidentCi(requireUser(req), req.params.ref, String((req.body as any)?.ci ?? ''), true));
  app.delete<{ Params: { ref: string; ci: string } }>('/api/incidents/:ref/cis/:ci', async (req) => inc.setIncidentCi(requireUser(req), req.params.ref, req.params.ci, false));
  app.put<RefParams>('/api/incidents/:ref/problem', async (req) =>
    inc.linkIncidentToProblem(requireUser(req), req.params.ref, String((req.body as any)?.problem ?? '') || null),
  );
  app.post<RefParams>('/api/incidents/:ref/problem', async (req, reply) => {
    const created = await inc.createProblemFromIncident(requireUser(req), req.params.ref, inc.problemFromIncidentSchema.parse(req.body ?? {}));
    reply.code(201);
    return created;
  });
  app.post<RefParams>('/api/problems/:ref/resolve-incidents', async (req) =>
    inc.resolveLinkedIncidents(requireUser(req), req.params.ref, inc.resolveLinkedSchema.parse(req.body)),
  );
}
