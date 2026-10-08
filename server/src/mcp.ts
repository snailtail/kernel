// MCP server (Streamable HTTP, stateless) exposing Kernel to Claude and other MCP clients.
// Each request authenticates with a personal API token and acts as that user.
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { User } from './auth.js';
import { query } from './db.js';
import { badRequest, HttpError } from './errors.js';
import * as actions from './actions.js';
import * as analyses from './analyses.js';
import * as integrations from './integrations.js';
import * as problems from './problems.js';
import * as reports from './reports.js';
import { traceTool } from './metrics.js';
import { problemMarkdown } from './export.js';
import * as review from './review.js';
import { CLOSURE_CODES, EC_DECISIONS, STATUSES, TRANSITIONS, WORKAROUND_EFFECTIVENESS } from './workflow.js';

const INSTRUCTIONS = `Kernel is a problem management system following the ITIL 4 problem management practice.
Lifecycle: new (problem identification) -> analysis (problem control) -> known_error (error control) -> resolved -> closed.
A known error requires a documented root cause; resolving requires a resolution; closing requires a closure code
and, for major problems, a major problem review. Problems are identified reactively (from incidents) or proactively
(from events, trends). Link incidents, events and changes in external systems with link_record.
Impact and urgency are 1 (high) to 3 (low); priority = impact + urgency - 1 (1 critical .. 5 planning).
In error control, assess each known error (risk of not fixing, cost of fixing, workaround effectiveness) and record the
decision: fix, accept the risk, defer, or pending, with a review date for accepted or deferred risks. Closing with
closure code no_fix requires an accepted risk.
Structured root cause analyses (five_whys, ishikawa, kepner_tregoe, timeline) can be attached to a problem with
start_analysis/update_analysis; when the analysis concludes, write the root cause with update_problem.
Problem candidates are services with many recent incidents/events not linked to any problem; review them with
list_problem_candidates and turn them into problems (create_problem_from_candidate) or link them to an existing one.
Track follow-up work (vendor patches, monitoring, runbook updates, review actions) as actions with an owner and due date.
get_problem returns next_steps: the current phase, its purpose and the remaining process steps. Use it to guide the
user through the process and to decide what to do next.
Before creating a problem, search existing problems and the known error database to avoid duplicates.`;

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });

async function resolveCategory(name?: string | null) {
  if (name === undefined) return undefined;
  if (name === null || name === '') return null;
  const { rows } = await query('SELECT id FROM categories WHERE lower(name) = lower($1)', [name]);
  if (!rows[0]) throw badRequest(`Unknown category "${name}". Use list_reference_data to see categories.`);
  return rows[0].id as number;
}

async function resolveAssignee(username?: string | null) {
  if (username === undefined) return undefined;
  if (username === null || username === '') return null;
  const { rows } = await query('SELECT id FROM users WHERE lower(username) = lower($1) AND active', [username]);
  if (!rows[0]) throw badRequest(`Unknown user "${username}". Use list_reference_data to see assignees.`);
  return rows[0].id as number;
}

/** Strips the activity log down for get_problem so responses stay compact. */
function compactProblem(p: Awaited<ReturnType<typeof problems.getProblem>>, activityLimit: number) {
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
  is_major: z.boolean().describe('Major problem (problem managers only)'),
  assignee: z.string().nullable().describe('Username of the problem owner/analyst'),
  root_cause: z.string().describe('Root cause analysis findings'),
  workaround: z.string().describe('Workaround that reduces or eliminates the impact'),
  resolution: z.string().describe('Permanent solution'),
  major_review: z.string().describe('Major problem review: what went well, what to improve, follow-ups'),
};

const optionalEditable = Object.fromEntries(Object.entries(editable).map(([k, v]) => [k, v.optional()])) as {
  [K in keyof typeof editable]: z.ZodOptional<(typeof editable)[K]>;
};

async function toInput(args: Partial<Record<keyof typeof editable, unknown>>) {
  const { category, assignee, ...rest } = args as any;
  const input: any = { ...rest };
  const category_id = await resolveCategory(category);
  const assignee_id = await resolveAssignee(assignee);
  if (category_id !== undefined) input.category_id = category_id;
  if (assignee_id !== undefined) input.assignee_id = assignee_id;
  return input;
}

function buildServer(user: User) {
  const server = new McpServer({ name: 'kernel', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    readOnly: boolean,
    run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  ) =>
    server.registerTool(
      name,
      { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: false } },
      (async (args: any) => {
        try {
          return json(await traceTool(name, () => run(args)));
        } catch (err) {
          const message =
            err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (err as Error).message;
          return { isError: true, content: [{ type: 'text' as const, text: message }] };
        }
      }) as any,
    );

  tool('whoami', 'Show the Kernel user this connection acts as, and its role.', {}, true, async () => user);

  tool(
    'list_reference_data',
    'List statuses, allowed transitions, closure codes, link kinds, categories and assignable users.',
    {},
    true,
    async () => {
      const [categories, users] = await Promise.all([
        query('SELECT name FROM categories WHERE active ORDER BY name'),
        query("SELECT username, display_name, role FROM users WHERE active AND role NOT IN ('viewer', 'integration') ORDER BY username"),
      ]);
      return {
        statuses: STATUSES,
        transitions: TRANSITIONS,
        closure_codes: CLOSURE_CODES,
        ec_decisions: EC_DECISIONS,
        workaround_effectiveness: WORKAROUND_EFFECTIVENESS,
        link_kinds: problems.LINK_KINDS,
        categories: categories.rows.map((r) => r.name),
        assignees: users.rows,
      };
    },
  );

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
    async ({ text, exclude_ref, limit }) => problems.findSimilar(text, exclude_ref, limit ?? 5),
  );

  tool(
    'mark_duplicate',
    'Mark a problem as a duplicate of another: links them, moves incident/event links to the original and closes the duplicate. Problem managers only.',
    { ref: z.string().describe('The duplicate'), of: z.string().describe('The original problem to keep') },
    false,
    async ({ ref, of }) => compactProblem(await problems.markDuplicate(user, ref, of), 5),
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

  tool('get_dashboard', 'Summary of the problem backlog: counts by status and priority, aging, my open problems and recent activity.', {}, true, () =>
    problems.dashboard(user),
  );

  tool(
    'list_problem_candidates',
    'Proactive problem detection: services with at least N recent incidents/events (reported by integrations) that are not linked to any problem. Includes the rule and the records.',
    {},
    true,
    () => integrations.listCandidates(),
  );

  tool(
    'create_problem_from_candidate',
    'Log a new problem from a candidate and link the given records to it.',
    { record_ids: z.array(z.number().int()).min(1), ...optionalEditable, title: editable.title },
    false,
    async ({ record_ids, ...fields }) =>
      compactProblem(await integrations.createFromCandidate(user, { record_ids, problem: problems.createProblemSchema.parse(await toInput(fields)) }), 5),
  );

  tool(
    'link_candidate_records',
    'Link candidate records (incidents/events) to an existing problem.',
    { ref: z.string(), record_ids: z.array(z.number().int()).min(1) },
    false,
    async ({ ref, record_ids }) => (await integrations.linkCandidate(user, ref, record_ids)).links,
  );

  tool(
    'report_records',
    'Report incidents or events from another system (e.g. while handling an incident). Optionally link each to a problem via problem_ref. Idempotent per system+kind+reference.',
    { records: z.array(integrations.recordSchema).min(1).max(100) },
    false,
    async (args) => integrations.ingestRecords(user, integrations.ingestSchema.parse(args)),
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
    { ...optionalEditable, title: editable.title },
    false,
    async (args) => compactProblem(await problems.createProblem(user, problems.createProblemSchema.parse(await toInput(args))), 5),
  );

  tool(
    'update_problem',
    'Update fields on a problem record. Only the fields given are changed. Use transition_problem to change status.',
    { ref: z.string(), ...optionalEditable },
    false,
    async ({ ref, ...args }) =>
      compactProblem(await problems.updateProblem(user, ref, problems.updateProblemSchema.parse(await toInput(args))), 5),
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
      root_cause: z.string().optional(),
      workaround: z.string().optional(),
      resolution: z.string().optional(),
      major_review: z.string().optional(),
    },
    false,
    async ({ ref, ...args }) => compactProblem(await problems.transitionProblem(user, ref, problems.transitionSchema.parse(args)), 5),
  );

  tool(
    'watch_problem',
    'Watch (or stop watching) a problem: watched problems appear under "Changes on problems I watch" on the dashboard.',
    { ref: z.string(), watching: z.boolean().optional().describe('Default true; false to stop watching') },
    false,
    async ({ ref, watching }) => (await problems.setWatching(user, ref, watching ?? true)).watchers,
  );

  tool(
    'add_comment',
    'Add a work note to the problem activity log (findings, analysis steps, decisions).',
    { ref: z.string(), body: z.string() },
    false,
    async ({ ref, body }) => {
      await problems.addComment(user, ref, body);
      return { ok: true };
    },
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
    'Record the error control assessment of a known error: risk of not fixing, cost of fixing, decision (fix/accept/defer/pending), rationale, review date and workaround effectiveness. Accept/defer require a problem manager.',
    {
      ref: z.string(),
      risk_level: z.number().int().min(1).max(3).nullable().optional().describe('Risk of not fixing: 1 high, 2 medium, 3 low'),
      risk: z.string().optional().describe('Impact if it recurs, how often, cost of living with the workaround'),
      fix_cost: z.string().optional().describe('Cost/effort/risk of a permanent fix'),
      decision: z.enum(EC_DECISIONS).nullable().optional(),
      decision_note: z.string().optional().describe('Rationale for the decision'),
      review_date: z.string().nullable().optional().describe('YYYY-MM-DD, when to reconsider an accepted or deferred risk'),
      workaround_effectiveness: z.enum(WORKAROUND_EFFECTIVENESS).nullable().optional(),
    },
    false,
    async ({ ref, risk_level, risk, fix_cost, decision, decision_note, review_date, workaround_effectiveness }) => {
      const p = await problems.assessProblem(
        user,
        ref,
        problems.assessmentSchema.parse({
          ec_risk_level: risk_level, ec_risk: risk, ec_fix_cost: fix_cost, ec_decision: decision,
          ec_decision_note: decision_note, ec_review_date: review_date, workaround_effectiveness,
        }),
      );
      return Object.fromEntries(Object.entries(p).filter(([k]) => k === 'ref' || k === 'status' || k.startsWith('ec_') || k.startsWith('workaround')));
    },
  );

  const ANALYSIS_FORMATS = `Data formats per technique:
- five_whys: { problem_statement, whys: [{ why, because }] }
- ishikawa: { effect, categories: [{ name, causes: [string] }] } (default categories People, Process, Technology, Supplier, Environment, Measurement)
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
    'update_analysis',
    `Update an analysis. data replaces the whole data object, so send the complete structure. Get analysis ids from get_problem.\n${ANALYSIS_FORMATS}`,
    {
      ref: z.string(),
      analysis_id: z.number().int(),
      title: z.string().optional(),
      data: z.record(z.string(), z.unknown()).optional(),
      conclusion: z.string().optional().describe('What the analysis concluded about the root cause'),
    },
    false,
    async ({ ref, analysis_id, ...input }) =>
      (await analyses.updateAnalysis(user, ref, analysis_id, analyses.updateAnalysisSchema.parse(input))).analyses.find(
        (a: { id: number }) => a.id === analysis_id,
      ),
  );

  const prompt = (name: string, title: string, description: string, body: (ref: string) => string) =>
    server.registerPrompt(name, { title, description, argsSchema: { ref: z.string().describe('Problem reference, e.g. PRB000012') } }, ({ ref }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: body(ref.toUpperCase()) } }],
    }));

  prompt('five_whys', '5 Whys analysis', 'Facilitate a 5 Whys root cause analysis on a problem, recording it in Kernel.', (ref) =>
    `Facilitate a 5 Whys root cause analysis for problem ${ref} in Kernel.
1. Read the problem with get_problem, including links, notes and any existing analyses.
2. Agree a precise problem statement with me, then start a five_whys analysis with start_analysis.
3. Ask one "why?" at a time. Propose a likely "because" based on the evidence, but let me confirm or correct it. Record each step with update_analysis.
4. Stop when we reach a cause that, if removed, would prevent recurrence and is within our control (usually 4–6 steps). Watch for branches; note them as separate analyses if needed.
5. Write the conclusion on the analysis, and when I agree, update the problem root cause with update_problem. Suggest follow-up actions with add_action.`);

  prompt('kepner_tregoe', 'Kepner-Tregoe problem analysis', 'Run a Kepner-Tregoe problem analysis (IS / IS NOT) on a problem.', (ref) =>
    `Run a Kepner-Tregoe problem analysis for problem ${ref} in Kernel.
1. Read the problem with get_problem, and linked incidents/events/changes.
2. Start a kepner_tregoe analysis with start_analysis. Work through WHAT, WHERE, WHEN and EXTENT with me: what IS affected, what could be but IS NOT, and the distinctions between them. Record answers with update_analysis as we go.
3. List changes related to the distinctions, derive possible causes, and for each define a test: does it explain both the IS and the IS NOT? Mark results.
4. Conclude with the most probable cause and how to verify it. Record the conclusion, update the root cause when I agree, and propose verification steps as actions.`);

  prompt('triage_problem', 'Triage a new problem', 'Check a newly logged problem for duplicates, priority, category and ownership.', (ref) =>
    `Triage problem ${ref} in Kernel as a problem manager would.
1. Read it with get_problem.
2. Search for duplicates and related known errors (search_problems with status "all", search_known_errors) using its key terms.
3. Assess impact and urgency against the evidence and the ITIL 4 priority matrix; check category, affected service, and detection (reactive/proactive).
4. Recommend: duplicate or not, priority, category, owner (list_reference_data for users), and first analysis steps. Ask me before changing anything, then apply agreed changes with update_problem and move it to analysis with transition_problem.`);

  prompt('major_problem_review', 'Draft a major problem review', 'Draft the major problem review from the problem record and its history.', (ref) =>
    `Draft a major problem review for problem ${ref} in Kernel.
Read it with get_problem (use a large activity_limit), including analyses, actions, links and notes. Write a concise review covering:
what happened and the business impact; timeline; root cause; what went well; what could be improved; how recurrence is prevented;
follow-up actions with owners and due dates (existing ones and new ones you recommend).
Show me the draft first. When I approve it, save it with update_problem (major_review) and create any new actions with add_action.`);

  const actionShape = {
    title: z.string().describe('What needs to be done'),
    description: z.string().optional(),
    owner: z.string().nullable().optional().describe('Username of the person responsible'),
    due_date: z.string().nullable().optional().describe('YYYY-MM-DD'),
    change_ref: z.string().optional().describe('Change implementing the action, e.g. CHG0042'),
  };
  const actionInput = async ({ owner, ...rest }: { owner?: string | null; [k: string]: unknown }) => {
    const owner_id = await resolveAssignee(owner);
    return owner_id === undefined ? rest : { ...rest, owner_id };
  };

  tool(
    'list_actions',
    'List follow-up actions across all problems, e.g. my open actions or everything overdue.',
    {
      status: z.enum([...actions.ACTION_STATUSES, 'all']).optional().describe('Default "open"'),
      owner: z.string().optional().describe('Username'),
      overdue: z.boolean().optional(),
      q: z.string().optional().describe('Matches action title, problem ref or problem title'),
    },
    true,
    async ({ owner, ...args }) =>
      actions.listActions(actions.listActionsSchema.parse({ ...args, owner_id: (await resolveAssignee(owner)) ?? undefined, limit: 100 })),
  );

  tool(
    'add_action',
    'Add a follow-up action to a problem, with an owner and due date.',
    { ref: z.string(), ...actionShape },
    false,
    async ({ ref, ...args }) => (await actions.createAction(user, ref, actions.createActionSchema.parse(await actionInput(args)))).actions,
  );

  tool(
    'update_action',
    'Update a follow-up action, or complete/cancel/reopen it via status. Get the action id from get_problem or list_actions.',
    {
      ref: z.string(),
      action_id: z.number().int(),
      ...actionShape,
      title: actionShape.title.optional(),
      status: z.enum(actions.ACTION_STATUSES).optional(),
    },
    false,
    async ({ ref, action_id, ...args }) =>
      (await actions.updateAction(user, ref, action_id, actions.updateActionSchema.parse(await actionInput(args)))).actions,
  );

  tool(
    'unlink_record',
    'Remove a linked record from a problem. Get the link id from get_problem.',
    { ref: z.string(), link_id: z.number().int() },
    false,
    async ({ ref, link_id }) => (await problems.removeLink(user, ref, link_id)).links,
  );

  return server;
}

export async function mcpRoutes(app: FastifyInstance) {
  app.post('/mcp', async (req, reply) => {
    if (!req.user || !req.headers.authorization) {
      reply.header('WWW-Authenticate', 'Bearer realm="kernel"');
      throw new HttpError(401, 'Send a Kernel API token as "Authorization: Bearer krn_..."');
    }
    const server = buildServer(req.user);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // Stateless server: no server-initiated streams or sessions to delete.
  const notAllowed = async (_req: unknown, reply: any) =>
    reply.code(405).header('Allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
