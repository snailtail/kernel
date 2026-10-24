// MCP: The dashboard and the period report: every practice's KPIs, each section while its module is on.
import { z } from 'zod';
import * as kpiMod from '../reporting/kpis.js';
import * as problems from '../problems/problems.js';
import * as reports from '../reporting/reports.js';
import { type McpContext } from './registrar.js';

export function registerReportsTools({ user, tool }: McpContext) {
  tool(
    'get_dashboard',
    'The dashboard: cross-practice KPIs with a trend over the last six periods (MTTR, SLA compliance, change success, recurring incidents, problems resolved, open major incidents; each says how it is calculated), plus, while problem management is on, the problem backlog: counts by status and priority, aging, my open problems and recent activity.',
    { period: z.enum(['month', 'week']).optional().describe('KPI trend per month (default) or per week') },
    true,
    // Extended compatibly (#54): the backlog fields stay as they were, the KPIs come in their own section; the backlog
    // only while problem management is on (#184).
    async ({ period }) => ({ ...(await problems.dashboard(user)), kpis: await kpiMod.kpis(user, kpiMod.kpiSchema.parse({ period })) }),
  );
  tool(
    'get_report',
    'Problem management KPIs for a period (with the incident, SLA and change sections of the modules that are on): flow (opened, known errors, resolved, closed per week/month), backlog over time, lead times per priority (hours), closures, reopened, proactive vs reactive, service and category hotspots, known error health and action follow-up. Use it to write monthly reports or spot trends.',
    {
      from: z.string().optional().describe('YYYY-MM-DD, default 90 days before to'),
      to: z.string().optional().describe('YYYY-MM-DD, default today'),
      bucket: z.enum(['week', 'month']).optional(),
    },
    true,
    async (args) => reports.report(reports.reportSchema.parse(args)),
  );
}
