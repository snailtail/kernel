import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import * as sr from '../service-report.js';

type Ref = { Params: { ref: string } };

export async function serviceReportRoutes(app: FastifyInstance) {
  app.get<Ref>('/api/services/:ref/report', async (req) => sr.serviceReport(requireUser(req), req.params.ref, sr.serviceReportSchema.parse(req.query)));
  app.get<Ref>('/api/services/:ref/report.md', async (req, reply) => {
    const r = await sr.serviceReport(requireUser(req), req.params.ref, sr.serviceReportSchema.parse(req.query));
    reply.header('Content-Disposition', `attachment; filename="service-report-${r.service.ref}-${r.period.from}-${r.period.to}.md"`);
    return reply.type('text/markdown; charset=utf-8').send(sr.serviceReportMarkdown(r));
  });
}
