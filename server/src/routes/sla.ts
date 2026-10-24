import type { FastifyInstance } from 'fastify';
import { requireUser } from '../security/auth.js';
import * as sla from '../reporting/sla.js';

type Id = { Params: { id: string } };

export async function slaRoutes(app: FastifyInstance) {
  app.get('/api/slas', async (req) => sla.listSlas(requireUser(req)));
  app.post('/api/slas', async (req, reply) => {
    reply.code(201);
    return sla.saveSla(requireUser(req), null, sla.slaSchema.parse(req.body));
  });
  app.put<Id>('/api/slas/:id', async (req) => sla.saveSla(requireUser(req), Number(req.params.id), sla.slaSchema.parse(req.body)));
  app.get('/api/calendars', async (req) => sla.listCalendars(requireUser(req)));
  app.post('/api/calendars', async (req, reply) => {
    reply.code(201);
    return sla.saveCalendar(requireUser(req), null, sla.calendarSchema.parse(req.body));
  });
  app.put<Id>('/api/calendars/:id', async (req) => sla.saveCalendar(requireUser(req), Number(req.params.id), sla.calendarSchema.parse(req.body)));
  app.get('/api/service-catalogue', async (req) => sla.serviceCatalogue(requireUser(req)));
}
