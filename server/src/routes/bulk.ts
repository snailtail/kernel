import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import * as bulk from '../bulk.js';

export async function bulkRoutes(app: FastifyInstance) {
  // One endpoint per practice list (#110): POST /api/incidents/bulk, /api/problems/bulk, …
  for (const practice of bulk.PRACTICES) {
    app.post(`/api/${practice}/bulk`, { config: { idempotent: bulk.readActionOf(practice) } }, async (req) =>
      bulk.bulk(requireUser(req), practice, bulk.bulkSchema.parse(req.body)),
    );
  }
}
