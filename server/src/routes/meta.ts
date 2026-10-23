// Reference data every practice reads (#171): it belongs to no single practice, so it has a route of its own.
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import { getMeta } from '../meta.js';
import * as problems from '../problems.js';

export async function metaRoutes(app: FastifyInstance) {
  app.get('/api/meta', async (req) => getMeta(requireUser(req, 'meta.read')));

  // Everyone who reads reports, on the same permission as the KPIs, not the problem one.
  app.get('/api/dashboard', async (req) => problems.dashboard(requireUser(req, 'report.read')));
}
