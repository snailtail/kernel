// MCP: Problem records, the known error database and analyses.
import { z } from 'zod';
import * as analyses from '../analyses.js';
import { badRequest } from '../errors.js';
import { problemMarkdown } from '../export.js';
import { idempotent } from '../idempotency.js';
import * as kpiMod from '../kpis.js';
import { categoryIdByName } from '../meta.js';
import { problemContext } from '../problem-context.js';
import * as problems from '../problems.js';
import * as reports from '../reports.js';
import * as review from '../review.js';
import { CLOSURE_CODES, EC_DECISIONS, STATUSES, WORKAROUND_EFFECTIVENESS } from '../workflow.js';
import { resolveAssignee, type McpContext } from './registrar.js';

async function resolveCategory(name?: string | null) {
  if (name === undefined) return undefined;
  if (name === null || name === '') return null;
  const id = await categoryIdByName(name);
  if (!id) throw badRequest(`Unknown category "${name}". Use list_reference_data to see categories.`);
  return id;
}

/** Strips the activity log down for get_problem so responses stay compact. */
export function compactProblem(p: Awaited<ReturnType<typeof problems.getProblem>>, activityLimit: number) {
  const { activity, ...rest } = p;
  return { ...rest, activity: activity.slice(0, activityLimit), activity_total: activity.length };
}

const editable = {
  title: z.string().describe('Short summary of the problem'),
  description: z.string().describe('Symptoms, scope and business impact'),
  category: z.string().nullable().describe('Category name, see list_reference_data'),
  affected_service: z.string().describe('Affected service or configuration item'),
  detection: z.enum(['reactive', 'proactive']).describe('reactive = from incidents, proactive = from events/trends'),
  impact: z.number().int().min(1).max(3).describe('1 high, 2 medium, 3 low'),
  urgency: z.number().int().min(1).max(3).describe('1 high, 2 medium, 3 low'),
  is_major: z.boolean().describe('Major problem (managers only)'),
  assignee: z.string().nullable().describe('Username of the problem owner/analyst'),
  root_cause: z.string().describe('Root cause analysis findings'),
  workaround: z.string().describe('Workaround that reduces or eliminates the impact'),
  resolution: z.string().describe('Permanent solution'),
  major_review: z.string().describe('Major problem review: what went well, what to improve, follow-ups'),
};

export const optionalEditable = Object.fromEntries(Object.entries(editable).map(([k, v]) => [k, v.optional()])) as {
  [K in keyof typeof editable]: z.ZodOptional<(typeof editable)[K]>;
};

export async function toInput(args: Partial<Record<keyof typeof editable, unknown>>) {
  const { category, assignee, ...rest } = args as any;
  const input: any = { ...rest };
  const category_id = await resolveCategory(category);
  const assignee_id = await resolveAssignee(assignee);
  if (category_id !== undefined) input.category_id = category_id;
  if (assignee_id !== undefined) input.assignee_id = assignee_id;
  return input;
}

export function registerProblemsTools({ user, tool, HUMAN_CONFIRMATION, decide }: McpContext) {
  tool(
    'search_problems',
    'Search problem records. Free text matches ref, title, description, service, root cause, workaround and resolution.',
    {
      q: z.string().optional().describe('Free text search'),
      status: z.enum([...STATUSES, 'open', 'all']).optional().describe('Default "open" (not resolved/closed)'),
      assignee: z.string().optional().describe('Username'),
      priority: z.number().int().min(1).max(5).optional(),
      is_major: z.boolean().optional(),
      needs_decision: z.boolean().optional().describe('Known errors without a fix/accept decision'),
      review_due: z.boolean().optional().describe('Known errors whose decision review date has passed'),
      sort: z.enum(['priority', 'updated', 'created', 'ref']).optional(),
      limit: z.number().int().min(1).max(100).optional().describe('Default 25'),
    },
    true,
    async ({ assignee, ...args }) => {
      const rows = await problems.listProblems(
        problems.listSchema.parse({ ...args, limit: args.limit ?? 25, assignee_id: (await resolveAssignee(assignee)) ?? undefined }),
      );
      return rows.map((p) => ({
        ref: p.ref, title: p.title, status: p.status, priority: p.priority, is_major: p.is_major,
        category: p.category, affected_service: p.affected_service, assignee: p.assignee, updated_at: p.updated_at,
      }));
    },
  );
  tool(
    'export_problem',
    'Export a problem record as a Markdown document (summary, root cause, workaround, error control, resolution, review, analyses, actions, links, timeline). Useful for sharing a major problem review or a known error article.',
    { ref: z.string() },
    true,
    async ({ ref }) => ({ markdown: await problemMarkdown(ref) }),
  );
  tool(
    'find_similar_problems',
    'Find existing problems and known errors similar to a text, e.g. an incident description or a draft problem. Use before create_problem, or while handling an incident to find a known workaround.',
    { text: z.string().describe('Symptoms, title or description'), exclude_ref: z.string().optional(), limit: z.number().int().min(1).max(20).optional() },
    true,
    async ({ text, exclude_ref, limit }) => problems.findSimilar(null, text, exclude_ref, limit ?? 5),
  );
  tool(
    'mark_duplicate',
    'Mark a problem as a duplicate of another: links them, moves incident/event links to the original and closes the duplicate. Managers only.',
    { ref: z.string().describe('The duplicate'), of: z.string().describe('The original problem to keep'), human_confirmation: HUMAN_CONFIRMATION },
    false,
    async ({ ref, of, human_confirmation }) => {
      return decide(ref, 'mark_duplicate', { of }, `Close as duplicate of ${of.toUpperCase()}`, human_confirmation, async () => compactProblem(await problems.markDuplicate(user, ref, of), 5));
    },
    { destructive: true },
  );
  tool(
    'get_problem',
    'Get a problem record with all fields, linked incidents/events/changes and recent activity.',
    { ref: z.string().describe('Problem reference, e.g. PRB000012'), activity_limit: z.number().int().min(0).max(500).optional() },
    true,
    async ({ ref, activity_limit }) => compactProblem(await problems.getProblem(ref), activity_limit ?? 20),
  );
  tool(
    'search_known_errors',
    'Search the known error database (KEDB) for known errors and their workarounds.',
    { q: z.string().optional(), include_resolved: z.boolean().optional().describe('Also include resolved/closed former known errors') },
    true,
    async ({ q, include_resolved }) =>
      (await problems.searchKnownErrors(q, include_resolved)).map((p) => ({
        ref: p.ref, title: p.title, status: p.status, priority: p.priority, affected_service: p.affected_service,
        root_cause: p.root_cause, workaround: p.workaround, known_error_at: p.known_error_at,
        workaround_effectiveness: p.workaround_effectiveness, decision: p.ec_decision, review_date: p.ec_review_date,
      })),
  );
  tool(
    'get_dashboard',
    'The dashboard: cross-practice KPIs with a trend over the last six periods (MTTR, SLA compliance, change success, recurring incidents, problems resolved, open major incidents; each says how it is calculated), plus the problem backlog: counts by status and priority, aging, my open problems and recent activity.',
    { period: z.enum(['month', 'week']).optional().describe('KPI trend per month (default) or per week') },
    true,
    // Extended compatibly (#54): the backlog fields stay as they were, the KPIs come in their own section.
    async ({ period }) => ({ ...(await problems.dashboard(user)), kpis: await kpiMod.kpis(user, kpiMod.kpiSchema.parse({ period })) }),
  );
  tool(
    'get_review_agenda',
    'Agenda for the problem review meeting: problems to triage, without owner, major problems, known errors awaiting a decision or due for review, stale problems, resolved awaiting closure, and overdue actions. Returns structured data and a Markdown version.',
    { stale_days: z.number().int().min(1).max(365).optional().describe('Days without activity to count as stale (default 14)') },
    true,
    async ({ stale_days }) => {
      const agenda = await review.reviewAgenda(review.agendaSchema.parse({ stale_days }));
      return { ...agenda, markdown: review.agendaMarkdown(agenda) };
    },
  );
  tool(
    'get_report',
    'Problem management KPIs for a period: flow (opened, known errors, resolved, closed per week/month), backlog over time, lead times per priority (hours), closures, reopened, proactive vs reactive, service and category hotspots, known error health and action follow-up. Use it to write monthly reports or spot trends.',
    {
      from: z.string().optional().describe('YYYY-MM-DD, default 90 days before to'),
      to: z.string().optional().describe('YYYY-MM-DD, default today'),
      bucket: z.enum(['week', 'month']).optional(),
    },
    true,
    async (args) => reports.report(reports.reportSchema.parse(args)),
  );
  tool(
    'create_problem',
    'Log a new problem record. Search first to avoid duplicates. Link the triggering incidents or events afterwards with link_record.',
    { ...optionalEditable, title: editable.title, idempotency_key: z.string().max(200).optional().describe('Retry-safe: the same key returns the original result instead of creating a duplicate') },
    false,
    async ({ idempotency_key, ...args }) =>
      idempotent(user.id, idempotency_key, 'create_problem', args, async () =>
        compactProblem(await problems.createProblem(user, problems.createProblemSchema.parse(await toInput(args))), 5)),
  );
  tool(
    'update_problem',
    'Update fields on a problem record. Only the fields given are changed. Use transition_problem to change status.',
    {
      ref: z.string(),
      ...optionalEditable,
      base: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Optional: the values (as returned by get_problem, e.g. {"root_cause": "..."}) your edit is based on. If someone changed them meanwhile, the update is rejected instead of overwriting their change.'),
    },
    false,
    async ({ ref, base, ...args }) =>
      compactProblem(await problems.updateProblem(user, ref, problems.updateProblemSchema.parse({ ...(await toInput(args)), base })), 5),
  );
  tool(
    'transition_problem',
    'Move a problem through its lifecycle. Required fields (root_cause, resolution, closure_code, major_review) can be supplied in the same call.',
    {
      ref: z.string(),
      to: z.enum(STATUSES),
      comment: z.string().optional().describe('Why the status changes'),
      closure_code: z.enum(CLOSURE_CODES).optional().describe('Required when closing'),
      acknowledge_open_actions: z.boolean().optional().describe('Close even though follow-up actions are still open'),
      human_confirmation: HUMAN_CONFIRMATION,
      root_cause: z.string().optional(),
      workaround: z.string().optional(),
      resolution: z.string().optional(),
      major_review: z.string().optional(),
    },
    false,
    async ({ ref, human_confirmation, ...args }) => {
      const parsed = problems.transitionSchema.parse(args);
      const run = async () => compactProblem(await problems.transitionProblem(user, ref, parsed), 5);
      if (args.to === 'closed') return decide(ref, 'close', parsed, `Close as ${args.closure_code ?? '(no closure code)'}`, human_confirmation, run);
      return run();
    },
    { destructive: true },
  );
  tool(
    'watch_problem',
    'Watch (or stop watching) a problem: watched problems appear under "Changes on problems I watch" on the dashboard.',
    { ref: z.string(), watching: z.boolean().optional().describe('Default true; false to stop watching') },
    false,
    async ({ ref, watching }) => (await problems.setWatching(user, ref, watching ?? true)).watchers,
  );
  tool(
    'link_record',
    'Link a related record, usually in an external system: an incident (reactive), event (proactive), change (implementing the fix) or another problem.',
    {
      ref: z.string().describe('Problem reference'),
      kind: z.enum(problems.LINK_KINDS),
      reference: z.string().describe('ID in the external system, e.g. INC0012345'),
      system: z.string().optional().describe('External system name, e.g. ServiceNow, Jira, Zabbix'),
      url: z.string().optional().describe('http(s) link to the record'),
      note: z.string().optional(),
    },
    false,
    async ({ ref, ...link }) => (await problems.addLink(user, ref, problems.linkSchema.parse(link))).links,
  );
  tool(
    'assess_known_error',
    'Record the error control assessment of a known error: risk of not fixing, cost of fixing, decision (fix/accept/defer/pending), rationale, review date and workaround effectiveness. Accept/defer require a manager.',
    {
      ref: z.string(),
      risk_level: z.number().int().min(1).max(3).nullable().optional().describe('Risk of not fixing: 1 high, 2 medium, 3 low'),
      risk: z.string().optional().describe('Impact if it recurs, how often, cost of living with the workaround'),
      fix_cost: z.string().optional().describe('Cost/effort/risk of a permanent fix'),
      decision: z.enum(EC_DECISIONS).nullable().optional(),
      decision_note: z.string().optional().describe('Rationale for the decision'),
      review_date: z.string().nullable().optional().describe('YYYY-MM-DD, when to reconsider an accepted or deferred risk'),
      workaround_effectiveness: z.enum(WORKAROUND_EFFECTIVENESS).nullable().optional(),
      human_confirmation: HUMAN_CONFIRMATION,
    },
    false,
    async ({ ref, risk_level, risk, fix_cost, decision, decision_note, review_date, workaround_effectiveness, human_confirmation }) => {
      const parsed = problems.assessmentSchema.parse({
          ec_risk_level: risk_level, ec_risk: risk, ec_fix_cost: fix_cost, ec_decision: decision,
          ec_decision_note: decision_note, ec_review_date: review_date, workaround_effectiveness,
      });
      const run = async () => {
        const p = await problems.assessProblem(user, ref, parsed);
        return Object.fromEntries(Object.entries(p).filter(([k]) => k === 'ref' || k === 'status' || k.startsWith('ec_') || k.startsWith('workaround')));
      };
      if (decision === 'accept' || decision === 'defer') return decide(ref, 'risk_decision', parsed, `${decision === 'accept' ? 'Accept' : 'Defer'} the risk`, human_confirmation, run);
      return run();
    },
    { destructive: true },
  );
  const ANALYSIS_FORMATS = `Data formats per technique:
- five_whys: { problem_statement, whys: [{ why, because, evidence, assumption }], root_cause_in_control }
- ishikawa: { effect, categories: [{ name, causes: [string], considered }] } (default categories People, Process, Technology, Supplier, Environment, Measurement)
- kepner_tregoe: { problem_statement, what|where|when|extent: { is, is_not, distinction }, changes, possible_causes: [{ cause, test, result: untested|explains|does_not_explain }] }
- timeline: { events: [{ at: "YYYY-MM-DDTHH:MM", kind: incident|change|deployment|alert|observation|other, description, reference }] }`;
  tool(
    'start_analysis',
    `Start a structured root cause analysis on a problem. Omit data to start from an empty template.\n${ANALYSIS_FORMATS}`,
    {
      ref: z.string(),
      technique: z.enum(analyses.TECHNIQUES),
      title: z.string().optional(),
      data: z.record(z.string(), z.unknown()).optional(),
      conclusion: z.string().optional(),
    },
    false,
    async ({ ref, ...input }) => (await analyses.createAnalysis(user, ref, analyses.createAnalysisSchema.parse(input))).analyses,
  );
  tool(
    'check_analysis',
    'Check an analysis against its method (e.g. every 5 Whys answer backed by evidence or marked as an assumption, KT causes tested against IS and IS NOT, all Ishikawa categories considered). Address every error before concluding.',
    { ref: z.string(), analysis_id: z.number().int() },
    true,
    async ({ ref, analysis_id }) => analyses.checkProblemAnalysis(user, ref, analysis_id),
  );
  tool(
    'get_problem_context',
    'Everything needed to investigate a problem in one call: the problem, next steps, linked incidents/events/changes with times, recent records for the same service, analyses with their quality check, open actions, recent work notes and similar problems/known errors.',
    { ref: z.string() },
    true,
    async ({ ref }) => problemContext(user, ref),
  );
  tool(
    'update_analysis',
    `Update an analysis. data replaces the whole data object, so send the complete structure. Get analysis ids from get_problem.\n${ANALYSIS_FORMATS}`,
    {
      ref: z.string(),
      analysis_id: z.number().int(),
      title: z.string().optional(),
      data: z.record(z.string(), z.unknown()).optional(),
      conclusion: z.string().optional().describe('What the analysis concluded about the root cause'),
      base_updated_at: z.string().optional().describe('updated_at of the analysis you read; protects against overwriting a newer save'),
    },
    false,
    async ({ ref, analysis_id, ...input }) =>
      (await analyses.updateAnalysis(user, ref, analysis_id, analyses.updateAnalysisSchema.parse(input))).analyses.find(
        (a: { id: number }) => a.id === analysis_id,
      ),
  );
  tool(
    'unlink_record',
    'Remove a linked record from a problem. Get the link id from get_problem.',
    { ref: z.string(), link_id: z.number().int() },
    false,
    async ({ ref, link_id }) => (await problems.removeLink(user, ref, link_id)).links,
    { destructive: true },
  );
}
