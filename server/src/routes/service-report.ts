import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import * as kpi from '../kpis.js';
import * as schedules from '../report-schedules.js';
import * as sr from '../service-report.js';

type Ref = { Params: { ref: string } };

export async function serviceReportRoutes(app: FastifyInstance) {
  app.get<Ref>('/api/services/:ref/report', async (req) => sr.serviceReport(requireUser(req), req.params.ref, sr.serviceReportSchema.parse(req.query)));
  app.get<Ref>('/api/services/:ref/report.md', async (req, reply) => {
    const r = await sr.serviceReport(requireUser(req), req.params.ref, sr.serviceReportSchema.parse(req.query), { exported: true });
    reply.header('Content-Disposition', `attachment; filename="service-report-${r.service.ref}-${r.period.from}-${r.period.to}.md"`);
    return reply.type('text/markdown; charset=utf-8').send(sr.serviceReportMarkdown(r));
  });
  app.get('/api/reports/service.csv', async (req, reply) => {
    const { service, ...period } = z.object({ service: z.string().trim().min(1).max(30), from: z.string().optional(), to: z.string().optional() }).parse(req.query);
    const p = sr.serviceReportSchema.parse(period);
    const csv = await sr.serviceReportCsv(requireUser(req), service, p);
    reply.header('Content-Disposition', `attachment; filename="service-report-${service.toUpperCase().replace(/[^\w-]/g, '')}-${p.from}-${p.to}.csv"`);
    return reply.type('text/csv; charset=utf-8').send(csv);
  });

  // The cross-practice dashboard (#54).
  app.get('/api/dashboard/kpis', async (req) => kpi.kpis(requireUser(req), kpi.kpiSchema.parse(req.query)));

  // Scheduled service reports (#54).
  app.get('/api/report-schedules', async (req) => schedules.listSchedules(requireUser(req), z.object({ service: z.string().max(30).optional() }).parse(req.query).service));
  app.post('/api/report-schedules', async (req, reply) => {
    reply.code(201);
    return schedules.createSchedule(requireUser(req), schedules.scheduleSchema.parse(req.body));
  });
  app.delete<{ Params: { id: string } }>('/api/report-schedules/:id', async (req) => {
    await schedules.deleteSchedule(requireUser(req), Number(req.params.id));
    return { ok: true };
  });
}
