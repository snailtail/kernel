import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import * as inc from '../incidents.js';
import * as inbound from '../inbound-mail.js';
import * as major from '../major-incidents.js';
import * as reviews from '../reviews.js';
import * as generic from '../generic.js';
import { z } from 'zod';

type RefParams = { Params: { ref: string } };

export async function incidentRoutes(app: FastifyInstance) {
  // Inbound email held for a person (#48): replies that could not be added on their own.
  app.get('/api/inbound-mail', async (req) => inbound.listInboundMail(requireUser(req)));
  app.post<{ Params: { id: string } }>('/api/inbound-mail/:id/decide', async (req) =>
    inbound.decideInboundMail(requireUser(req), z.coerce.number().int().parse(req.params.id), inbound.inboundDecisionSchema.parse(req.body)),
  );
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
  // Post-incident reviews (#109, #120).
  app.get('/api/incident-reviews', async (req) => reviews.listReviews(requireUser(req), reviews.listReviewsSchema.parse(req.query)));
  // The same reviews as a record type (#35), by their own ref; the incident paths below take either ref.
  app.get('/api/reviews', async (req) => reviews.listReviews(requireUser(req), reviews.listReviewsSchema.parse(req.query)));
  app.post('/api/reviews', { config: { idempotent: 'incident.update' } }, async (req, reply) => {
    const user = requireUser(req);
    const { incident, ...input } = reviews.createReviewSchema.extend({ incident: z.string().trim().min(1).max(20) }).parse(req.body);
    const created = await reviews.createReview(user, incident, input);
    reply.code(201);
    return created;
  });
  app.get<RefParams>('/api/reviews/:ref', async (req) => reviews.openReview(requireUser(req), req.params.ref));
  app.patch<RefParams>('/api/reviews/:ref', async (req) => reviews.updateReview(requireUser(req), req.params.ref, reviews.updateReviewSchema.parse(req.body)));
  app.post<RefParams>('/api/reviews/:ref/transition', async (req) => reviews.transitionReview(requireUser(req), req.params.ref, reviews.transitionReviewSchema.parse(req.body)));
  app.post<RefParams>('/api/reviews/:ref/links', { config: { idempotent: 'incident.update' } }, async (req) => {
    const user = requireUser(req);
    const body = generic.linkBodySchema.parse(req.body);
    return generic.linkRecords(user, req.params.ref, body.to, body);
  });
  app.post<RefParams>('/api/reviews/:ref/comments', { config: { idempotent: 'incident.update' } }, async (req) =>
    reviews.addReviewComment(requireUser(req), req.params.ref, z.object({ body: z.string().max(20000) }).parse(req.body).body),
  );
  type ItemParams = { Params: { ref: string; id: string } };
  app.get<RefParams>('/api/incidents/:ref/review', async (req) => reviews.openReview(requireUser(req), req.params.ref));
  app.post<RefParams>('/api/incidents/:ref/review', async (req, reply) => {
    const created = await reviews.createReview(requireUser(req), req.params.ref, reviews.createReviewSchema.parse(req.body ?? {}));
    reply.code(201);
    return created;
  });
  app.patch<RefParams>('/api/incidents/:ref/review', async (req) => reviews.updateReview(requireUser(req), req.params.ref, reviews.updateReviewSchema.parse(req.body)));
  app.post<RefParams>('/api/incidents/:ref/review/items', async (req) => reviews.addItem(requireUser(req), req.params.ref, reviews.itemSchema.parse(req.body)));
  app.delete<ItemParams>('/api/incidents/:ref/review/items/:id', async (req) => reviews.removeItem(requireUser(req), req.params.ref, Number(req.params.id)));
  app.post<ItemParams>('/api/incidents/:ref/review/items/:id/problem', async (req) =>
    reviews.itemToProblem(requireUser(req), req.params.ref, Number(req.params.id), reviews.itemProblemSchema.parse(req.body ?? {})),
  );
  app.post<ItemParams>('/api/incidents/:ref/review/items/:id/action', async (req) =>
    reviews.itemToAction(requireUser(req), req.params.ref, Number(req.params.id), reviews.itemActionSchema.parse(req.body ?? {})),
  );
  app.post<ItemParams>('/api/incidents/:ref/review/items/:id/improvement', async (req) =>
    reviews.itemToImprovement(requireUser(req), req.params.ref, Number(req.params.id), reviews.itemImprovementSchema.parse(req.body ?? {})),
  );
  app.post<RefParams>('/api/incidents/:ref/review/publish', async (req) => reviews.publishReview(requireUser(req), req.params.ref));
  app.post<RefParams>('/api/incidents/:ref/review/waive', async (req) => reviews.waiveReview(requireUser(req), req.params.ref, reviews.waiveSchema.parse(req.body)));
  app.post<RefParams>('/api/incidents/:ref/review/article', async (req, reply) => {
    const created = await reviews.reviewToArticle(requireUser(req), req.params.ref);
    reply.code(201);
    return created;
  });
  app.get<RefParams>('/api/incidents/:ref/review/export.md', async (req, reply) => {
    const md = await reviews.reviewMarkdown(requireUser(req), req.params.ref);
    reply.header('Content-Type', 'text/markdown; charset=utf-8').header('Content-Disposition', `attachment; filename="${req.params.ref.toUpperCase().replace(/[^A-Z0-9]/g, '')}-review.md"`);
    return md;
  });
  app.post<RefParams>('/api/problems/:ref/resolve-incidents', async (req) =>
    inc.resolveLinkedIncidents(requireUser(req), req.params.ref, inc.resolveLinkedSchema.parse(req.body)),
  );
}
