import type { FastifyInstance } from 'fastify';
import { requireUser } from '../security/auth.js';
import * as teams from '../people/teams.js';

type Id = { Params: { id: string } };

export async function teamRoutes(app: FastifyInstance) {
  app.get('/api/teams', async (req) => teams.listTeams(requireUser(req)));
  app.post('/api/teams', async (req, reply) => {
    reply.code(201);
    return teams.saveTeam(requireUser(req), null, teams.teamSchema.parse(req.body));
  });
  app.put<Id>('/api/teams/:id', async (req) => teams.saveTeam(requireUser(req), Number(req.params.id), teams.teamSchema.parse(req.body)));
  app.delete<Id>('/api/teams/:id', async (req) => teams.deleteTeam(requireUser(req), Number(req.params.id)));
  app.put<Id>('/api/teams/:id/members', async (req) => teams.setMembers(requireUser(req), Number(req.params.id), teams.membersSchema.parse(req.body)));
  app.get<Id>('/api/teams/:id/queue', async (req) => teams.teamQueue(requireUser(req), Number(req.params.id)));
}
