import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireReason } from '../security/audit.js';
import { requireUser } from '../security/auth.js';
import { requireStepUp } from '../security/mfa.js';
import * as people from '../people/people.js';

type Id = { Params: { id: string } };

export async function peopleRoutes(app: FastifyInstance) {
  app.get('/api/people', async (req) => people.listPeople(requireUser(req), people.listPeopleSchema.parse(req.query)));
  app.post('/api/people', async (req, reply) => {
    reply.code(201);
    return people.createPerson(requireUser(req), people.createPersonSchema.parse(req.body));
  });
  app.get<Id>('/api/people/:id', async (req) => people.getPerson(requireUser(req), Number(req.params.id)));
  app.patch<Id>('/api/people/:id', async (req) => people.updatePerson(requireUser(req), Number(req.params.id), people.updatePersonSchema.parse(req.body)));
  app.post<Id>('/api/people/:id/erase', async (req) => {
    const user = requireUser(req, 'user.manage');
    await requireStepUp(req);
    return people.erasePerson(user, Number(req.params.id), requireReason(z.object({ reason: z.string().max(1000).optional() }).parse(req.body ?? {}).reason));
  });
  app.get('/api/organisations', async (req) => people.listOrganisations(requireUser(req)));
  app.post('/api/organisations', async (req, reply) => {
    reply.code(201);
    return people.saveOrganisation(requireUser(req), null, people.organisationSchema.parse(req.body));
  });
  app.put<Id>('/api/organisations/:id', async (req) => people.saveOrganisation(requireUser(req), Number(req.params.id), people.organisationSchema.parse(req.body)));
  app.post<{ Params: { ref: string } }>('/api/incidents/:ref/people', async (req) => {
    const user = requireUser(req);
    await people.setAffected(user, req.params.ref, people.personRefSchema.parse(req.body), true);
    return { ok: true };
  });
  app.delete<{ Params: { ref: string; id: string } }>('/api/incidents/:ref/people/:id', async (req) => {
    const user = requireUser(req);
    await people.setAffected(user, req.params.ref, { id: Number(req.params.id) }, false);
    return { ok: true };
  });
}
