// The MCP tool registrar: one permission map for every tool, the wrapper that checks role and token scope and records
// each call, and the human confirmation that decisions need. Each domain's tools are in mcp/<domain>.ts.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { approvalsRequired, requestApproval, type ApprovalKind } from '../changes/approvals.js';
import { audit } from '../security/audit.js';
import type { User } from '../security/auth.js';
import { maskForViewer } from '../security/confidential.js';
import { badRequest } from '../core/errors.js';
import { traceTool } from '../core/metrics.js';
import { can, type Action } from '../security/policy.js';
import { securityEvent } from '../security/security-events.js';
import { activeUserId } from '../people/users.js';

/** Tool results are JSON text, unless a tool returns MCP content itself (an image for a multimodal model). */
const json = (value: unknown) =>
  value && typeof value === 'object' && 'mcpContent' in value ? { content: (value as { mcpContent: any[] }).mcpContent } : { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };

export async function resolveAssignee(username?: string | null) {
  if (username === undefined) return undefined;
  if (username === null || username === '') return null;
  const id = await activeUserId(username);
  if (!id) throw badRequest(`Unknown user "${username}". Use list_reference_data to see assignees.`);
  return id;
}

// Notes the requester wrote in the portal, and replies the requester was sent (#45), are marked as such.
export const portalMark = (a: any) => (a.data?.from_requester ? { from_requester: true } : a.data?.for_requester ? { to_requester: true } : {});

// Every tool maps to a policy action; tools the user's role cannot use are not listed at all.
const TOOL_ACTIONS: Record<string, Action> = {
  check_analysis: 'problem.read', get_problem_context: 'problem.read',
  search_cis: 'ci.read', get_ci: 'ci.read', list_ci_types: 'ci.read', create_ci: 'ci.manage', update_ci: 'ci.manage',
  transition_ci: 'ci.manage', upsert_cis: 'ci.ingest',
  // An owner may retire their own CIs; retireCis checks per CI.
  list_retire_proposals: 'ci.read', retire_cis: 'ci.annotate',
  list_inbound_mail: 'incident.update', decide_inbound_mail: 'incident.update',
  link_ci_to_problem: 'problem.link', unlink_ci_from_problem: 'problem.link',
  list_attachments: 'meta.read', read_attachment: 'meta.read', add_attachment: 'attachment.add',
  summarize_record: 'meta.read', analyze_log: 'meta.read',
  get_service_report: 'report.read', get_service_status: 'ci.read', post_status_update: 'status.set', follow_service: 'ci.read',
  get_on_call: 'team.read', list_teams: 'team.read',
  // Each operation checks its own permission; the tool is listed for roles that can change records (action.write is
  // in every working role and in no module, so these stay when a practice is switched off).
  bulk_update: 'action.write',
  list_views: 'meta.read', save_view: 'meta.read', delete_view: 'meta.read', set_default_view: 'meta.read', link_dev_item: 'meta.read', list_dev_links: 'meta.read',
  search_knowledge: 'article.read', get_article: 'article.read', create_article: 'article.write', update_article: 'article.write', transition_article: 'article.write', use_article: 'incident.update',
  search_people: 'person.read', get_person: 'person.read', add_affected_person: 'incident.update',
  get_process_map: 'meta.read', get_health_tips: 'meta.read',
  list_slas: 'meta.read', get_service_catalogue: 'ci.read', get_my_notifications: 'meta.read',
  list_incidents: 'incident.read', get_incident: 'incident.read', create_incident: 'incident.create', update_incident: 'incident.update',
  transition_incident: 'incident.update', resolve_incident: 'incident.update', link_incident_to_problem: 'incident.update',
  get_review: 'incident.read', list_incident_reviews: 'incident.read', create_review: 'incident.update', update_review: 'incident.update', add_review_item: 'incident.update', review_factor_to_problem: 'incident.update',
  review_follow_up_to_action: 'incident.update', publish_review: 'incident.update', waive_review: 'incident.flag_major', transition_review: 'incident.update',
  declare_major: 'incident.flag_major', set_major_roles: 'incident.update', post_communication: 'incident.update', link_child_incident: 'incident.update', get_incident_timeline: 'incident.read', mark_key_moment: 'incident.update',
  create_problem_from_incident: 'problem.create', link_ci_to_incident: 'incident.update',
  list_changes: 'change.read', get_change: 'change.read', create_change: 'change.create', update_change: 'change.update',
  transition_change: 'change.update', get_change_schedule: 'change.read', raise_change_for_problem: 'change.create',
  list_improvements: 'improvement.read', get_improvement: 'improvement.read', create_improvement: 'improvement.write', update_improvement: 'improvement.write',
  transition_improvement: 'improvement.write', review_follow_up_to_improvement: 'improvement.write',
  list_request_items: 'request.read', list_requests: 'request.read', get_request: 'request.read', create_request: 'request.write', update_request: 'request.write',
  transition_request: 'request.write', complete_request_task: 'request.write',
  register_standard_change: 'change.register', approve_change: 'change.approve', link_ci_to_change: 'change.update',
  report_event: 'event.ingest', list_alerts: 'event.read', acknowledge_alert: 'event.ack', close_alert: 'event.ack', list_event_rules: 'event.read',
  list_rules: 'rule.read', get_rule: 'rule.read', dry_run_rule: 'rule.read', propose_rule: 'rule.propose',
  get_ci_impact: 'ci.read', get_service_dependencies: 'ci.read', add_ci_relationship: 'ci.manage', remove_ci_relationship: 'ci.manage',
  sync_ci_relationships: 'ci.ingest', sync_ci_batch: 'ci.ingest', list_ci_groups: 'ci.read', get_ci_group: 'ci.read', save_ci_group: 'ci.manage',
  whoami: 'meta.read', list_reference_data: 'meta.read', search: 'meta.read', get_record: 'meta.read', next_steps: 'meta.read',
  my_work: 'action.read', link_records: 'action.write',
  search_problems: 'problem.read', get_problem: 'problem.read', get_history: 'meta.read', get_impact: 'ci.read', find_similar_problems: 'problem.read',
  export_problem: 'problem.read', list_actions: 'action.read', get_dashboard: 'report.read',
  search_known_errors: 'kedb.read', get_report: 'report.read', get_review_agenda: 'review.read',
  list_problem_candidates: 'candidate.read', query_audit_log: 'audit.read', query_security_events: 'security.read', get_security_alerting: 'security.read',
  create_problem: 'problem.create', update_problem: 'problem.update', transition_problem: 'problem.transition',
  assess_known_error: 'problem.assess', add_comment: 'action.write', link_record: 'problem.link', unlink_record: 'problem.link',
  watch_problem: 'problem.watch', mark_duplicate: 'problem.mark_duplicate',
  add_action: 'action.write', update_action: 'action.write', start_analysis: 'analysis.write', update_analysis: 'analysis.write',
  create_problem_from_candidate: 'candidate.act', link_candidate_records: 'candidate.act', dismiss_problem_candidate: 'candidate.act', list_eol_versions: 'candidate.read', save_eol_version: 'candidate.rule', report_problem_candidate: 'candidate.report', report_records: 'record.ingest',
};

/** What every domain's tools get: the server, the user it acts as, and the shared helpers. */
export type McpContext = ReturnType<typeof createContext>;

export function createContext(server: McpServer, user: User, scopes?: string[]) {
  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    readOnly: boolean,
    run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
    options: { destructive?: boolean } = {},
  ) => {
    const action = TOOL_ACTIONS[name];
    if (!action) throw new Error(`MCP tool ${name} has no policy action`);
    if (!can(user.role, action)) return;
    // Token scopes: write tools need the write scope, read tools the read scope (ingest-only tokens may report).
    const scope = action === 'record.ingest' || action === 'candidate.report' ? 'ingest' : readOnly ? 'read' : 'write';
    if (scopes && !scopes.includes(scope) && !(scope === 'ingest' && scopes.includes('write'))) return;
    server.registerTool(
      name,
      { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: !!options.destructive, idempotentHint: readOnly } },
      (async (args: any) => {
        // Every call is a security event (#64): the tool, who and which record, never the content. Reads go to the
        // log stream only; writes and failures are also stored.
        const target = typeof args?.ref === 'string' ? args.ref.slice(0, 40) : '';
        try {
          // Agents never read a confidential record's free text (#61).
          const result = json(await maskForViewer(null, await traceTool(name, () => run(args))));
          securityEvent({ action: 'mcp.tool_call', category: 'api', outcome: 'success', message: `MCP ${name}`, target, detail: { tool: name, read_only: readOnly }, store: !readOnly });
          return result;
        } catch (err) {
          const message =
            err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (err as Error).message;
          securityEvent({ action: 'mcp.tool_call', category: 'api', outcome: 'failure', message: `MCP ${name} failed`, target, detail: { tool: name, read_only: readOnly, error: message.slice(0, 200) } });
          return { isError: true, content: [{ type: 'text' as const, text: message }] };
        }
      }) as any,
    );
  };

  /**
   * Decisions made through MCP (close, accept/defer risk, mark duplicate) need the human's explicit confirmation,
   * quoted by the agent; it is recorded in the audit trail as the reason (#76, #67).
   */
  const HUMAN_CONFIRMATION = z
    .string()
    .min(3)
    .max(1000)
    .optional()
    .describe('Required for decisions: quote the person\'s explicit confirmation, e.g. "Yes, close it as resolved". Ask them first; never decide on their behalf.');
  const requireConfirmation = async (ref: string, tool: string, confirmation: string | undefined, entityType = 'problem') => {
    if (!confirmation?.trim()) {
      throw new Error(`${tool} is a decision: ask the person to confirm it, then call again with human_confirmation quoting their answer.`);
    }
    await audit(null, { entity_type: entityType, entity_ref: ref.toUpperCase(), action: 'mcp_human_confirmation', changes: { tool }, reason: confirmation.trim() });
  };
  /**
   * The agent's quote cannot prove the person agreed (it could come from a prompt injection), so by default the
   * decision becomes a pending approval that a person approves in the web UI.
   */
  const decide = async (ref: string, kind: ApprovalKind, payload: object, summary: string, confirmation: string | undefined, run: () => Promise<unknown>) => {
    await requireConfirmation(ref, summary, confirmation);
    if (await approvalsRequired()) return requestApproval(user, ref, kind, payload, summary, confirmation!.trim());
    return run();
  };

  return { server, user, tool, HUMAN_CONFIRMATION, requireConfirmation, decide };
}
