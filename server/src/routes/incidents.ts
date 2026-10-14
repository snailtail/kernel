import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import * as inc from '../incidents.js';
import * as major from '../major-incidents.js';

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
  // Major incidents (#108): declare, the team and cadence, updates, related incidents and the timeline.
  app.post<RefParams>('/api/incidents/:ref/major', async (req) => major.declareMajor(requireUser(req), req.params.ref, major.declareMajorSchema.parse(req.body ?? {})));
  app.patch<RefParams>('/api/incidents/:ref/major', async (req) => major.setMajorRoles(requireUser(req), req.params.ref, major.majorRolesSchema.parse(req.body ?? {})));
  app.post<RefParams>('/api/incidents/:ref/communications', { config: { idempotent: 'incident.update' } }, async (req) =>
    major.postCommunication(requireUser(req), req.params.ref, major.communicationSchema.parse(req.body)),
  );
  app.post<RefParams>('/api/incidents/:ref/children', async (req) => major.linkChild(requireUser(req), req.params.ref, major.childSchema.parse(req.body)));
  app.delete<{ Params: { ref: string; child: string } }>('/api/incidents/:ref/children/:child', async (req) => major.unlinkChild(requireUser(req), req.params.ref, req.params.child));
  app.get<RefParams & { Querystring: { format?: string } }>('/api/incidents/:ref/timeline', async (req, reply) => {
    const t = await major.timeline(requireUser(req), req.params.ref);
    if (req.query.format !== 'md') return t;
    reply.header('Content-Type', 'text/markdown; charset=utf-8').header('Content-Disposition', `attachment; filename="${t.ref}-timeline.md"`);
    return major.timelineMarkdown(t);
  });
  app.put<{ Params: { ref: string; id: string } }>('/api/incidents/:ref/activity/:id/key-moment', async (req) =>
    major.setKeyMoment(requireUser(req), req.params.ref, Number(req.params.id), major.keyMomentSchema.parse(req.body).key_moment),
  );
  app.post<RefParams>('/api/problems/:ref/resolve-incidents', async (req) =>
    inc.resolveLinkedIncidents(requireUser(req), req.params.ref, inc.resolveLinkedSchema.parse(req.body)),
  );
}
