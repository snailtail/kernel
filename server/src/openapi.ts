// OpenAPI 3.1 description of the REST API, generated from the zod schemas the routes validate with.
// A test checks that every registered /api route is listed here.
import { z } from 'zod';
import * as actions from './actions.js';
import * as cmdb from './cmdb.js';
import { MODULE_TAGS, moduleEnabled } from './modules.js';
import * as graph from './cmdb-graph.js';
import * as conn from './connectors.js';
import * as retire from './ci-retire.js';
import * as problemCis from './problem-cis.js';
import * as inc from './incidents.js';
import * as inbound from './inbound-mail.js';
import * as majorInc from './major-incidents.js';
import * as reviewsMod from './reviews.js';
import * as oc from './oncall.js';
import * as events from './events.js';
import * as ch from './changes.js';
import * as slaMod from './sla.js';
import * as notif from './notifications.js';
import * as setupMod from './setup.js';
import * as ppl from './people.js';
import * as kb from './knowledge.js';
import * as tm from './teams.js';
import * as vw from './views.js';
import * as bulkMod from './bulk.js';
import * as dv from './dev.js';
import * as aiMod from './ai.js';
import * as st from './status.js';
import * as subs from './status-subscriptions.js';
import * as srMod from './service-report.js';
import * as ssoMod from './sso.js';
import * as hooks from './event-hooks.js';
import { privacySchema, securityQuerySchema } from './security-events.js';
import { alertingSchema } from './security-alerts.js';
import { auditQuerySchema } from './audit.js';
import { searchSchema } from './generic.js';
import * as analyses from './analyses.js';
import * as candidates from './candidates.js';
import * as config from './candidate-config.js';
import * as integrations from './integrations.js';
import * as problems from './problems.js';
import * as reports from './reports.js';
import * as review from './review.js';
import * as webhooks from './webhooks.js';
import { ROLES } from './workflow.js';

interface Op {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string; // Fastify style, e.g. /api/problems/:ref
  tag: string;
  summary: string;
  query?: z.ZodType;
  body?: z.ZodType;
  produces?: string; // non-JSON response type
  public?: boolean;
}

const user = z.object({
  username: z.string().trim().min(2).max(50),
  display_name: z.string().trim().min(1).max(100),
  email: z.string().max(200).optional(),
  role: z.enum(ROLES),
  active: z.boolean().optional(),
  password: z.string().min(10),
});
const ids = candidates.candidateIdsSchema.extend({ key: z.string().optional() });

const BULK_TAG: Record<bulkMod.Practice, string> = { incidents: 'Incidents', problems: 'Problems', changes: 'Changes', alerts: 'Events', actions: 'Actions', articles: 'Knowledge', cis: 'CMDB' };

export const OPERATIONS: Op[] = [
  { method: 'post', path: '/api/auth/login', tag: 'Authentication', summary: 'Sign in with username and password (sets a session cookie)', body: z.object({ username: z.string(), password: z.string() }), public: true },
  { method: 'post', path: '/api/auth/logout', tag: 'Authentication', summary: 'Sign out' },
  { method: 'get', path: '/api/auth/me', tag: 'Authentication', summary: 'The signed-in user, with preferences' },
  { method: 'post', path: '/api/auth/password', tag: 'Authentication', summary: 'Change your password', body: z.object({ current: z.string(), password: z.string().min(12), revoke_tokens: z.boolean().optional(), code: z.string().optional() }) },
  { method: 'put', path: '/api/auth/preferences', tag: 'Authentication', summary: 'Update your preferences (merged)', body: z.object({ theme: z.enum(['system', 'light', 'dark']).optional(), guided: z.boolean().optional(), intro_seen: z.boolean().optional() }) },
  { method: 'post', path: '/api/auth/login/mfa', tag: 'Authentication', summary: 'Second sign-in step: TOTP or recovery code for the mfa_token from login', body: z.object({ mfa_token: z.string(), code: z.string() }), public: true },
  { method: 'post', path: '/api/auth/reauth', tag: 'Authentication', summary: 'Confirm it is you (password + code) before sensitive actions', body: z.object({ password: z.string(), code: z.string().optional() }) },
  { method: 'get', path: '/api/auth/mfa', tag: 'Authentication', summary: 'Your two-factor authentication status' },
  { method: 'post', path: '/api/auth/mfa/setup', tag: 'Authentication', summary: 'Start TOTP enrolment (secret, otpauth URL, QR code)' },
  { method: 'post', path: '/api/auth/mfa/enable', tag: 'Authentication', summary: 'Confirm enrolment with a code; returns recovery codes once', body: z.object({ code: z.string() }) },
  { method: 'post', path: '/api/auth/mfa/disable', tag: 'Authentication', summary: 'Turn off two-factor authentication' },
  { method: 'post', path: '/api/auth/mfa/recovery-codes', tag: 'Authentication', summary: 'Replace recovery codes (returned once)' },
  { method: 'get', path: '/api/admin/mfa-policy', tag: 'Administration', summary: 'Roles that must use two-factor authentication' },
  { method: 'put', path: '/api/admin/mfa-policy', tag: 'Administration', summary: 'Set the roles that must use two-factor authentication', body: z.object({ required_roles: z.array(z.enum(ROLES)), reason: z.string() }) },
  { method: 'post', path: '/api/users/:id/mfa/reset', tag: 'Administration', summary: "Reset a user's two-factor authentication (admins; reason required)", body: z.object({ reason: z.string() }) },
  { method: 'get', path: '/api/auth/sessions', tag: 'Authentication', summary: 'Your active sessions' },
  { method: 'delete', path: '/api/auth/sessions/:id', tag: 'Authentication', summary: 'Sign out a session' },
  { method: 'post', path: '/api/auth/sessions/revoke-others', tag: 'Authentication', summary: 'Sign out all other sessions' },
  { method: 'get', path: '/api/tokens', tag: 'Authentication', summary: 'Your personal API tokens' },
  { method: 'post', path: '/api/tokens', tag: 'Authentication', summary: 'Create a personal API token (returned once). Scopes: read, write, mcp, ingest', body: z.object({ name: z.string().min(1).max(100), expires_in_days: z.number().int().min(1).max(3650).optional(), scopes: z.array(z.enum(['read', 'write', 'mcp', 'ingest'])).optional() }) },
  { method: 'delete', path: '/api/tokens/:id', tag: 'Authentication', summary: 'Revoke a token' },

  { method: 'get', path: '/api/meta', tag: 'Reference data', summary: 'Statuses, transitions, closure codes, categories, assignees and other reference data' },
  { method: 'get', path: '/api/dashboard', tag: 'Reference data', summary: 'Backlog summary for the dashboard' },

  { method: 'get', path: '/api/problems', tag: 'Problems', summary: 'Search problems', query: problems.listSchema },
  { method: 'post', path: '/api/problems', tag: 'Problems', summary: 'Log a problem', body: problems.createProblemSchema },
  { method: 'get', path: '/api/problems/similar', tag: 'Problems', summary: 'Problems similar to a text (duplicate check)', query: z.object({ text: z.string(), exclude: z.string().optional(), limit: z.number().int().optional() }) },
  { method: 'get', path: '/api/problems/:ref', tag: 'Problems', summary: 'A problem with links, activity, actions, analyses, watchers and next_steps' },
  { method: 'patch', path: '/api/problems/:ref', tag: 'Problems', summary: 'Update problem fields', body: problems.updateProblemSchema },
  { method: 'post', path: '/api/problems/:ref/transition', tag: 'Problems', summary: 'Change status (with the fields the target status requires)', body: problems.transitionSchema },
  { method: 'put', path: '/api/problems/:ref/assessment', tag: 'Problems', summary: 'Error control assessment and decision for a known error', body: problems.assessmentSchema },
  { method: 'post', path: '/api/problems/:ref/comments', tag: 'Problems', summary: 'Add a work note', body: z.object({ body: z.string().max(20000) }) },
  { method: 'post', path: '/api/problems/:ref/links', tag: 'Problems', summary: 'Link an incident, event, change or problem', body: problems.linkSchema },
  { method: 'delete', path: '/api/problems/:ref/links/:id', tag: 'Problems', summary: 'Remove a link' },
  { method: 'post', path: '/api/problems/:ref/duplicate', tag: 'Problems', summary: 'Close as duplicate of another problem (problem managers)', body: z.object({ of: z.string() }) },
  { method: 'put', path: '/api/problems/:ref/watch', tag: 'Problems', summary: 'Watch a problem' },
  { method: 'delete', path: '/api/problems/:ref/watch', tag: 'Problems', summary: 'Stop watching a problem' },
  { method: 'get', path: '/api/problems/:ref/export.md', tag: 'Problems', summary: 'Export a problem as Markdown', produces: 'text/markdown' },

  { method: 'post', path: '/api/problems/:ref/actions', tag: 'Actions', summary: 'Add a follow-up action', body: actions.createActionSchema },
  { method: 'patch', path: '/api/problems/:ref/actions/:id', tag: 'Actions', summary: 'Update, complete, cancel or reopen an action', body: actions.updateActionSchema },
  { method: 'get', path: '/api/actions', tag: 'Actions', summary: 'Actions across problems', query: actions.listActionsSchema },

  { method: 'post', path: '/api/problems/:ref/analyses', tag: 'Analyses', summary: 'Start a root cause analysis (five_whys, ishikawa, kepner_tregoe, timeline)', body: analyses.createAnalysisSchema },
  { method: 'patch', path: '/api/problems/:ref/analyses/:id', tag: 'Analyses', summary: 'Update an analysis (data replaces the whole structure)', body: analyses.updateAnalysisSchema },
  { method: 'delete', path: '/api/problems/:ref/analyses/:id', tag: 'Analyses', summary: 'Remove an analysis' },

  { method: 'get', path: '/api/search', tag: 'Records', summary: 'Search all record types you may read', query: searchSchema },
  { method: 'get', path: '/api/records/:ref', tag: 'Records', summary: 'Any record by ref (the prefix selects the type)' },
  { method: 'get', path: '/api/records/:ref/next-steps', tag: 'Records', summary: 'Process phase and remaining steps for a record' },
  { method: 'post', path: '/api/records/:ref/links', tag: 'Records', summary: 'Link a record to another record or an external reference', body: z.object({ to: z.string(), kind: z.string().optional(), system: z.string().optional(), url: z.string().optional(), note: z.string().optional() }) },
  { method: 'get', path: '/api/records/:ref/history', tag: 'Records', summary: 'Who changed what on any record, newest first, from the audit trail (read access and visibility apply)', query: z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }) },
  { method: 'get', path: '/api/records/:ref/impact', tag: 'Records', summary: 'What is affected if a CI or service is down (other record types give 400)', query: z.object({ max_depth: z.coerce.number().int().optional() }) },
  { method: 'post', path: '/api/records/:ref/comments', tag: 'Records', summary: 'Add a work note to any record. Supports Idempotency-Key', body: z.object({ body: z.string() }) },
  { method: 'get', path: '/api/my-work', tag: 'Records', summary: 'Your open problems and actions, and changes on what you watch' },
  { method: 'get', path: '/api/guides', tag: 'Guidance', summary: 'Method guides for investigation and process flows (5 Whys, Ishikawa, KT, timeline, error control…)' },
  { method: 'get', path: '/api/guides/:id', tag: 'Guidance', summary: 'One method guide, with a Markdown rendering' },
  { method: 'get', path: '/api/problems/:ref/context', tag: 'Guidance', summary: 'Everything needed to investigate a problem, in one size-limited response' },
  { method: 'get', path: '/api/problems/:ref/analyses/:id/check', tag: 'Analyses', summary: 'Quality check of an analysis against its method' },
  { method: 'post', path: '/api/problems/:ref/analyses/:id/confirm', tag: 'Analyses', summary: 'Confirm an analysis proposed via MCP (people only)' },
  { method: 'post', path: '/api/problems/:ref/confirm', tag: 'Problems', summary: 'Confirm text fields proposed via MCP (people only)', body: z.object({ fields: z.array(z.string()) }) },
  { method: 'get', path: '/api/approvals', tag: 'Problems', summary: 'Decisions requested through MCP, waiting for a person' },
  { method: 'post', path: '/api/approvals/:id/approve', tag: 'Problems', summary: 'Approve and carry out a requested decision (web UI only)', body: z.object({ note: z.string().optional() }) },
  { method: 'post', path: '/api/approvals/:id/reject', tag: 'Problems', summary: 'Reject a requested decision (web UI only)', body: z.object({ note: z.string().optional() }) },
  { method: 'get', path: '/api/admin/mcp-approvals', tag: 'Administration', summary: 'Whether decisions through MCP need approval in the web UI' },
  { method: 'put', path: '/api/admin/mcp-approvals', tag: 'Administration', summary: 'Require (or not) approval of MCP decisions; reason required', body: z.object({ required: z.boolean(), reason: z.string() }) },
  { method: 'get', path: '/api/ci-types', tag: 'CMDB', summary: 'CI and service types with their attribute schemas' },
  { method: 'put', path: '/api/ci-types', tag: 'CMDB', summary: 'Create or update a CI type (problem managers)', body: cmdb.typeSchema },
  { method: 'get', path: '/api/cis', tag: 'CMDB', summary: 'Search configuration items and services', query: cmdb.listCisSchema },
  { method: 'post', path: '/api/cis', tag: 'CMDB', summary: 'Create a CI or service (problem managers)', body: cmdb.createCiSchema },
  { method: 'post', path: '/api/cis/upsert', tag: 'CMDB', summary: 'Upsert CIs from a source system (connectors/integrations), matched by source_system + source_id', body: cmdb.upsertSchema },
  { method: 'get', path: '/api/cis/retire-proposals', tag: 'CMDB', summary: 'CIs missing for their sources\' retire_after_days, proposed for retirement: sources, last seen, relationships and open records that name them' },
  { method: 'post', path: '/api/cis/retire', tag: 'CMDB', summary: 'Retire missing CIs (administrators, CMDB managers or the owner); open records that name one need acknowledge_open. Never deletes', body: retire.retireSchema },
  { method: 'get', path: '/api/cis/:ref', tag: 'CMDB', summary: 'A CI or service with sources, links, relationships and history' },
  { method: 'patch', path: '/api/cis/:ref', tag: 'CMDB', summary: 'Update a CI or service', body: cmdb.updateCiSchema },
  { method: 'post', path: '/api/cis/:ref/transition', tag: 'CMDB', summary: 'Change status (planned, active, maintenance, retired, missing)', body: cmdb.transitionCiSchema },
  { method: 'post', path: '/api/cis/:ref/comments', tag: 'CMDB', summary: 'Add a note', body: z.object({ body: z.string() }) },
  { method: 'post', path: '/api/cis/:ref/links', tag: 'CMDB', summary: 'Link a problem, incident, event, change or document', body: cmdb.ciLinkSchema },
  { method: 'delete', path: '/api/cis/:ref/links/:id', tag: 'CMDB', summary: 'Remove a link' },
  { method: 'post', path: '/api/users/:id/erase', tag: 'Administration', summary: 'Erase (anonymise) a user account with a reason; the audit trail stays valid (ADR 0001)' },
  { method: 'get', path: '/api/admin/modules', tag: 'Administration', summary: 'Modules (practices) and whether they are on' },
  { method: 'put', path: '/api/admin/modules', tag: 'Administration', summary: 'Switch modules on or off (administrators); nothing is deleted', body: setupMod.modulesSchema },
  { method: 'get', path: '/api/setup', tag: 'Administration', summary: 'First-run setup state' },
  { method: 'post', path: '/api/setup', tag: 'Administration', summary: 'Apply the setup wizard (modules, support hours, first event source, demo data); safe to repeat', body: setupMod.setupSchema },
  { method: 'post', path: '/api/setup/demo/remove', tag: 'Administration', summary: 'Remove all demo data in one action' },
  { method: 'get', path: '/api/templates', tag: 'Reference data', summary: 'Templates for new incidents and problems' },
  { method: 'post', path: '/api/templates', tag: 'Reference data', summary: 'Create a template (problem managers)', body: setupMod.templateSchema },
  { method: 'put', path: '/api/templates/:id', tag: 'Reference data', summary: 'Update a template', body: setupMod.templateSchema },
  { method: 'get', path: '/api/ai/status', tag: 'AI', summary: 'Which AI tasks are set up (all off until an administrator configures a provider)' },
  { method: 'post', path: '/api/ai/summarize', tag: 'AI', summary: 'Catch me up: a labelled AI summary of a record (state, timeline, next steps); never saved by itself' },
  { method: 'post', path: '/api/ai/review-wording', tag: 'AI', summary: 'AI hints on blameful wording in a post-incident review (opt-in; changes nothing)' },
  { method: 'post', path: '/api/ai/analyze-log', tag: 'AI', summary: 'AI analysis of a text attachment (errors, timeline, probable cause), pre-filtered and with secrets redacted' },
  { method: 'get', path: '/api/admin/ai/providers', tag: 'AI', summary: 'Model providers, routing per task and usage this month' },
  { method: 'post', path: '/api/admin/ai/providers', tag: 'AI', summary: 'Add a provider (OpenAI-compatible such as Ollama or vLLM, Anthropic, OpenAI, Google) with its location and allowed data classes', body: aiMod.providerSchema },
  { method: 'put', path: '/api/admin/ai/providers/:id', tag: 'AI', summary: 'Update a provider (the key is write-only)', body: aiMod.providerSchema },
  { method: 'delete', path: '/api/admin/ai/providers/:id', tag: 'AI', summary: 'Remove a provider (and its routes)' },
  { method: 'post', path: '/api/admin/ai/providers/:id/test', tag: 'AI', summary: 'Test connection with a fixed prompt (no data)' },
  { method: 'put', path: '/api/admin/ai/routing', tag: 'AI', summary: 'Choose the provider and model per task (with a reason)' },
  { method: 'get', path: '/api/auth/mfa-pending', tag: 'Authentication', summary: 'Whether a second-factor step is waiting after single sign-on' },
  { method: 'post', path: '/api/auth/passkey/options', tag: 'Authentication', summary: 'Options for signing in with a passkey (or, with mfa_token, for the second factor)' },
  { method: 'post', path: '/api/auth/passkey/login', tag: 'Authentication', summary: 'Sign in with a passkey (user verification required; counts as two factors)' },
  { method: 'get', path: '/api/auth/passkeys', tag: 'Authentication', summary: "The signed-in user's passkeys" },
  { method: 'post', path: '/api/auth/passkeys/options', tag: 'Authentication', summary: 'Options for adding a passkey (after step-up)' },
  { method: 'post', path: '/api/auth/passkeys', tag: 'Authentication', summary: 'Add a passkey (after step-up)' },
  { method: 'delete', path: '/api/auth/passkeys/:id', tag: 'Authentication', summary: 'Remove a passkey (after step-up)' },
  { method: 'post', path: '/api/auth/reauth/passkey/options', tag: 'Authentication', summary: 'Options for confirming a sensitive action with a passkey' },
  { method: 'post', path: '/api/auth/reauth/passkey', tag: 'Authentication', summary: 'Confirm a sensitive action (step-up) with a passkey' },
  { method: 'post', path: '/api/tokens/:id/rotate', tag: 'Authentication', summary: 'Rotate an API token: a successor with the same scopes; the old one keeps working for 24 hours' },
  { method: 'get', path: '/api/live', tag: 'Authentication', summary: 'Live updates for the web UI (Server-Sent Events; session cookie only): change notices and presence' },
  { method: 'put', path: '/api/live/:id', tag: 'Authentication', summary: 'Choose what a live stream follows (record and list topics) and what you are editing' },
  { method: 'post', path: '/api/records/:ref/redact', tag: 'Records', summary: 'Remove secrets or a given text from a record and its history (managers; step-up and a reason; audited without the text)' },
  { method: 'put', path: '/api/records/:ref/classification', tag: 'Records', summary: 'Mark a record confidential (free text masked except for its people) or normal again; a reason is required' },
  { method: 'post', path: '/api/records/:ref/reveal', tag: 'Records', summary: 'Show a confidential record\'s text to yourself for 15 minutes (step-up and a reason; audited)' },
  { method: 'post', path: '/api/sensitive/check', tag: 'Records', summary: 'What the sensitive-data scanner finds in a text (kinds only; nothing stored)' },
  { method: 'get', path: '/api/admin/sensitive-data', tag: 'Administration', summary: 'Sensitive-data policy: redact or refuse secrets, flag personal data' },
  { method: 'put', path: '/api/admin/sensitive-data', tag: 'Administration', summary: 'Change the sensitive-data policy (step-up and a reason)' },
  { method: 'get', path: '/api/nav/counts', tag: 'Records', summary: 'Counts for the menu badges: my open work, open alerts without an incident, my teams\' unassigned incidents, known errors awaiting a decision, overdue actions, overdue post-incident reviews for me or my teams' },
  { method: 'get', path: '/api/auth/options', tag: 'Authentication', summary: 'Sign-in options for the login page (SSO, Cloudflare Access, local)' },
  { method: 'get', path: '/api/auth/sso/start', tag: 'Authentication', summary: 'Start OpenID Connect sign-in (authorization code with PKCE)' },
  { method: 'get', path: '/api/auth/sso/callback', tag: 'Authentication', summary: 'OpenID Connect redirect URI' },
  { method: 'post', path: '/api/auth/access', tag: 'Authentication', summary: 'Sign in with the Cloudflare Access token (Cf-Access-Jwt-Assertion)' },
  { method: 'get', path: '/api/admin/sso', tag: 'Authentication', summary: 'Single sign-on and Cloudflare Access settings (secrets are never shown)' },
  { method: 'put', path: '/api/admin/sso', tag: 'Authentication', summary: 'Configure OpenID Connect: issuer, client, group-to-role and group-to-team mapping, local sign-in (with a reason)', body: ssoMod.ssoSchema },
  { method: 'put', path: '/api/admin/cf-access', tag: 'Authentication', summary: 'Configure Cloudflare Access sign-in (team domain, audience tag)', body: ssoMod.cfAccessSchema },
  { method: 'get', path: '/api/services/:ref/report', tag: 'Reports', summary: 'Service report for a period (?from=&to=): availability against the SLA target, incidents, SLA compliance, MTTR, changes, open problems and known errors', query: srMod.serviceReportSchema },
  { method: 'get', path: '/api/services/:ref/report.md', tag: 'Reports', summary: 'The service report as Markdown, for the service review' },
  { method: 'get', path: '/api/status', tag: 'Status', summary: 'Service status board: set and suggested status per service (from incidents, maintenance, changes), updates, planned maintenance' },
  { method: 'put', path: '/api/status/:ref', tag: 'Status', summary: 'Set a service status (publish: also on the public page)', body: st.setStatusSchema },
  { method: 'put', path: '/api/status/:ref/public', tag: 'Status', summary: 'Show a service on the public page under a curated name and description', body: st.publicServiceSchema },
  { method: 'post', path: '/api/status/updates', tag: 'Status', summary: 'Post a status update (investigating → identified → monitoring → resolved); public updates need a problem manager', body: st.updateSchema },
  { method: 'post', path: '/api/status/updates/:id/retract', tag: 'Status', summary: 'Retract a published update: it leaves the public page and mail not yet sent is stopped (reason in the body)', body: z.object({ reason: z.string() }) },
  { method: 'delete', path: '/api/status/updates/:id', tag: 'Status', summary: 'Deprecated: answers 400 pointing to POST /api/status/updates/:id/retract (the reason no longer goes in the query string)' },
  { method: 'put', path: '/api/status/:ref/follow', tag: 'Status', summary: 'Follow a service (or stop): its status updates reach you by your notification settings', body: z.object({ follow: z.boolean() }) },
  { method: 'put', path: '/api/admin/status-page', tag: 'Status', summary: 'Turn the public status page on or off and set its title (with a reason)' },
  { method: 'get', path: '/api/public/status', tag: 'Status', summary: 'The public status page as JSON (no authentication; published data only; cacheable)' },
  { method: 'post', path: '/status/subscribe', tag: 'Status', summary: 'Sign up for email about public services (no authentication; a form or JSON). The same answer whether or not the address is subscribed; a confirmation mail follows', body: subs.signUpSchema },
  { method: 'get', path: '/status/confirm', tag: 'Status', summary: 'Shows what a confirmation link confirms (?s=&token=); changes nothing' },
  { method: 'post', path: '/status/confirm', tag: 'Status', summary: 'Confirms an email subscription (the link works once and expires in 48 hours)' },
  { method: 'get', path: '/status/unsubscribe', tag: 'Status', summary: 'Shows the unsubscribe confirmation for a signed link (?s= or ?p=, &token=)' },
  { method: 'post', path: '/status/unsubscribe', tag: 'Status', summary: 'One-click unsubscribe from status email (RFC 8058)' },
  { method: 'get', path: '/api/records/:ref/dev-links', tag: 'Dev platforms', summary: 'Pull requests, issues, commits, workflow runs and releases linked to a problem, change or incident, with their status' },
  { method: 'post', path: '/api/records/:ref/dev-links', tag: 'Dev platforms', summary: 'Link a GitHub, GitLab or Azure DevOps URL (pull request or merge request, issue or work item, commit, pipeline run or release)' },
  { method: 'delete', path: '/api/records/:ref/dev-links/:id', tag: 'Dev platforms', summary: 'Remove a dev link' },
  { method: 'post', path: '/api/dev-hooks/:id', tag: 'Dev platforms', summary: 'Dev platform webhook: keeps items current and links PRs, commits and runs that mention Kernel refs. GitHub signs with X-Hub-Signature-256 (HMAC); GitLab sends the secret in X-Gitlab-Token; Azure DevOps sends it as the Basic auth password, HTTPS only (weaker: no signature over the body)' },
  { method: 'get', path: '/api/dev-sources', tag: 'Dev platforms', summary: 'Dev platform sources (webhook URL, accepted repositories or projects, counters)' },
  { method: 'post', path: '/api/dev-sources', tag: 'Dev platforms', summary: 'Add a GitHub, GitLab or Azure DevOps source; the webhook secret is shown once', body: dv.sourceSchema },
  { method: 'patch', path: '/api/dev-sources/:id', tag: 'Dev platforms', summary: 'Change repositories, token, private network ranges, CA certificate, the status token and opt-in for posting the change status on pull requests, or enabled' },
  { method: 'post', path: '/api/dev-sources/:id/rotate', tag: 'Dev platforms', summary: 'Rotate the webhook secret (shown once)' },
  { method: 'get', path: '/api/dev-sources/:id/targets', tag: 'Dev platforms', summary: 'Deployment targets: (repository, environment) → CIs and services, production, and whether a deploy registers a standard change' },
  { method: 'post', path: '/api/dev-sources/:id/targets', tag: 'Dev platforms', summary: 'Map a deployment target; registering standard changes needs production, a template and CIs', body: dv.targetSchema },
  { method: 'delete', path: '/api/dev-targets/:id', tag: 'Dev platforms', summary: 'Remove a deployment target' },
  { method: 'delete', path: '/api/dev-sources/:id', tag: 'Dev platforms', summary: 'Remove a dev platform source' },
  { method: 'put', path: '/api/records/:ref/visibility', tag: 'Visibility', summary: 'Restrict a problem, incident or change to its assignee, creator and named teams (or open it again); reason required' },
  { method: 'post', path: '/api/records/:ref/break-glass', tag: 'Visibility', summary: 'Administrators: open a restricted record for an hour with a reason (audited; the people on it are told)' },
  { method: 'get', path: '/api/admin/visibility', tag: 'Visibility', summary: 'Team scoping per practice, categories that start restricted, and active break-glass sessions' },
  { method: 'put', path: '/api/admin/visibility', tag: 'Visibility', summary: 'Change team scoping and restricted categories (with a reason)' },
  { method: 'get', path: '/api/teams', tag: 'Teams', summary: 'Teams with members, the services and CIs they support, and their open work' },
  { method: 'post', path: '/api/teams', tag: 'Teams', summary: 'Create a team (administrators)', body: tm.teamSchema },
  { method: 'put', path: '/api/teams/:id', tag: 'Teams', summary: 'Update a team; deactivating needs its open work reassigned first', body: tm.teamSchema },
  { method: 'delete', path: '/api/teams/:id', tag: 'Teams', summary: 'Remove a team without open work' },
  { method: 'put', path: '/api/teams/:id/members', tag: 'Teams', summary: 'Set the members and leads (administrators, or the team lead)', body: tm.membersSchema },
  { method: 'get', path: '/api/on-call', tag: 'Teams', summary: 'Who is on call per team (?team=): from PagerDuty or Opsgenie when configured, else the built-in rotation; cached a minute, and a tool that cannot be reached says so' },
  { method: 'get', path: '/api/teams/:id/paging', tag: 'Teams', summary: "The team's paging target (no secrets), rotation and upcoming overrides" },
  { method: 'put', path: '/api/teams/:id/paging', tag: 'Teams', summary: 'Set the paging target (PagerDuty, Opsgenie, Grafana OnCall, signed webhook or rotation) and when incidents page it; credentials are write-only (administrators, step-up)', body: oc.targetSchema },
  { method: 'delete', path: '/api/teams/:id/paging', tag: 'Teams', summary: 'Remove the paging target' },
  { method: 'put', path: '/api/teams/:id/rotation', tag: 'Teams', summary: 'The built-in weekly rotation: members in turn and the handover (administrators or the team lead)', body: oc.rotationSchema },
  { method: 'post', path: '/api/teams/:id/rotation/overrides', tag: 'Teams', summary: 'Take a shift (or, as lead, give one)', body: oc.overrideSchema },
  { method: 'delete', path: '/api/teams/:id/rotation/overrides/:override', tag: 'Teams', summary: 'Remove a shift' },
  { method: 'post', path: '/api/paging/:id/inbound', tag: 'Teams', summary: "The paging tool's webhook (Authorization: Bearer or X-Kernel-Token, or a PagerDuty v3 signature): acknowledged by X becomes the first response of an incident this target paged; resolved is recorded" },
  { method: 'get', path: '/api/views', tag: 'Views', summary: "A list's saved views (?list=incidents): built-in, mine, my teams' and everyone's, with my default", query: vw.listSchema },
  { method: 'post', path: '/api/views', tag: 'Views', summary: 'Save a view: filters and sort as a query string, and visible columns; personal, shared with a team (its leads) or with everyone (problem managers)', body: vw.viewSchema },
  { method: 'patch', path: '/api/views/:id', tag: 'Views', summary: 'Change a view (the owner, the team leads, or problem managers for shared views)', body: vw.updateViewSchema },
  { method: 'delete', path: '/api/views/:id', tag: 'Views', summary: 'Remove a view' },
  { method: 'put', path: '/api/views/default', tag: 'Views', summary: 'Pin a view (an id or builtin:<key>) as my default for a list; null clears it', body: vw.defaultSchema },
  { method: 'get', path: '/api/teams/:id/queue', tag: 'Teams', summary: "A team's queue: unassigned, mine and at risk of breaching" },
  { method: 'get', path: '/api/articles', tag: 'Knowledge', summary: 'Search knowledge articles (published by default; drafts for roles that write articles)', query: kb.listArticlesSchema },
  { method: 'post', path: '/api/articles', tag: 'Knowledge', summary: 'Draft an article', body: kb.createArticleSchema },
  { method: 'get', path: '/api/articles/:ref', tag: 'Knowledge', summary: 'An article with its CIs, history, feedback and where it was used' },
  { method: 'patch', path: '/api/articles/:ref', tag: 'Knowledge', summary: 'Update an article (articles that follow a known error change with the problem)', body: kb.updateArticleSchema },
  { method: 'post', path: '/api/articles/:ref/transition', tag: 'Knowledge', summary: 'Publish, retire or return an article to draft', body: kb.transitionArticleSchema },
  { method: 'post', path: '/api/articles/:ref/comments', tag: 'Knowledge', summary: 'Add a note to an article' },
  { method: 'post', path: '/api/articles/:ref/links', tag: 'Knowledge', summary: 'Say which CI or service the article applies to' },
  { method: 'delete', path: '/api/articles/:ref/links/:ci', tag: 'Knowledge', summary: 'Remove a CI or service from an article' },
  { method: 'post', path: '/api/articles/:ref/feedback', tag: 'Knowledge', summary: 'Was this helpful? (once per person; can be changed)' },
  { method: 'get', path: '/api/knowledge/suggest', tag: 'Knowledge', summary: 'Published articles that fit an incident being logged (?text=&cis=)' },
  { method: 'post', path: '/api/problems/:ref/article', tag: 'Knowledge', summary: 'Publish a known error as an article that follows the problem and retires when it is resolved' },
  { method: 'post', path: '/api/incidents/:ref/article', tag: 'Knowledge', summary: "Draft a troubleshooting article from an incident's resolution" },
  { method: 'post', path: '/api/incidents/:ref/articles-used', tag: 'Knowledge', summary: 'Record that an article was used to resolve the incident' },
  { method: 'get', path: '/api/admin/ai-data', tag: 'Administration', summary: 'What attachments may be sent to AI agents through MCP' },
  { method: 'put', path: '/api/admin/ai-data', tag: 'Administration', summary: 'Allow or refuse images and flagged text for AI agents (with a reason)' },
  { method: 'get', path: '/api/records/:ref/attachments', tag: 'Attachments', summary: 'Attachments of a record (problem, incident, change, CI)' },
  { method: 'post', path: '/api/records/:ref/attachments', tag: 'Attachments', summary: 'Attach a file: the raw bytes as application/octet-stream, the name in ?filename=. Images are re-encoded (metadata removed); the type is detected from the content' },
  { method: 'get', path: '/api/attachments/:id', tag: 'Attachments', summary: 'Download an attachment (?inline=1 shows images and PDFs in place)' },
  { method: 'get', path: '/api/attachments/:id/preview', tag: 'Attachments', summary: 'An image preview (at most 1600 px, WebP)' },
  { method: 'get', path: '/api/attachments/:id/thumb', tag: 'Attachments', summary: 'An image thumbnail (WebP)' },
  { method: 'get', path: '/api/attachments/:id/text', tag: 'Attachments', summary: 'A text attachment as lines (?from=&limit=), with the first error line' },
  { method: 'delete', path: '/api/attachments/:id', tag: 'Attachments', summary: 'Remove an attachment (uploader or manager); the bytes are deleted' },
  { method: 'get', path: '/api/people', tag: 'People', summary: 'Search contacts (name, email, department)', query: ppl.listPeopleSchema },
  { method: 'post', path: '/api/people', tag: 'People', summary: 'Add a contact (no login needed)', body: ppl.createPersonSchema },
  { method: 'get', path: '/api/people/:id', tag: 'People', summary: 'A contact with their incidents, services consumed and what they own' },
  { method: 'patch', path: '/api/people/:id', tag: 'People', summary: 'Update a contact (VIP flag: problem managers)', body: ppl.updatePersonSchema },
  { method: 'post', path: '/api/people/:id/erase', tag: 'People', summary: 'Erase (anonymise) a contact with a reason; incidents keep the reference' },
  { method: 'get', path: '/api/organisations', tag: 'People', summary: 'Organisations (departments, customers) and the services they consume' },
  { method: 'post', path: '/api/organisations', tag: 'People', summary: 'Create an organisation (problem managers)', body: ppl.organisationSchema },
  { method: 'put', path: '/api/organisations/:id', tag: 'People', summary: 'Update an organisation', body: ppl.organisationSchema },
  { method: 'post', path: '/api/incidents/:ref/people', tag: 'Incidents', summary: 'Add an affected person (by id, or by email/name, created if new)', body: ppl.personRefSchema },
  { method: 'delete', path: '/api/incidents/:ref/people/:id', tag: 'Incidents', summary: 'Remove an affected person' },
  { method: 'get', path: '/api/flow', tag: 'Guidance', summary: 'The process map (event → incident → problem → known error → change → resolution) with live counts' },
  { method: 'get', path: '/api/health-tips', tag: 'Guidance', summary: 'Gentle health tips: things worth a look this week' },
  { method: 'get', path: '/api/notifications', tag: 'Notifications', summary: 'My notifications (newest first) and the unread count' },
  { method: 'post', path: '/api/notifications/read', tag: 'Notifications', summary: 'Mark notifications as read (ids, or all)' },
  { method: 'get', path: '/api/notifications/settings', tag: 'Notifications', summary: 'My notification settings: email, digest, events, chat webhook' },
  { method: 'put', path: '/api/notifications/settings', tag: 'Notifications', summary: 'Update my notification settings', body: notif.settingsSchema },
  { method: 'get', path: '/api/notifications/unsubscribe', tag: 'Notifications', summary: 'One-click unsubscribe from a signed email link (no login)' },
  { method: 'post', path: '/api/notifications/unsubscribe', tag: 'Notifications', summary: 'One-click unsubscribe (RFC 8058 List-Unsubscribe-Post)' },
  { method: 'get', path: '/api/public/approval-links', tag: 'Notifications', summary: 'The page behind an approval link from email or chat: shows the request and a form, changes nothing (no login; the token is the credential)', public: true },
  { method: 'post', path: '/api/public/approval-links', tag: 'Notifications', summary: 'Approve or reject through an approval link: single use, as the approver, from the form on that page', public: true },
  { method: 'get', path: '/api/slas', tag: 'Service levels', summary: 'SLAs with targets per priority' },
  { method: 'post', path: '/api/slas', tag: 'Service levels', summary: 'Create an SLA (problem managers)', body: slaMod.slaSchema },
  { method: 'put', path: '/api/slas/:id', tag: 'Service levels', summary: 'Update an SLA', body: slaMod.slaSchema },
  { method: 'get', path: '/api/calendars', tag: 'Service levels', summary: 'Business-hours calendars with holidays' },
  { method: 'post', path: '/api/calendars', tag: 'Service levels', summary: 'Create a calendar', body: slaMod.calendarSchema },
  { method: 'put', path: '/api/calendars/:id', tag: 'Service levels', summary: 'Update a calendar', body: slaMod.calendarSchema },
  { method: 'get', path: '/api/service-catalogue', tag: 'Service levels', summary: 'Services with SLA, support hours and how to get help' },
  { method: 'get', path: '/api/changes', tag: 'Changes', summary: 'List changes (open by default)', query: ch.listChangesSchema },
  { method: 'get', path: '/api/changes/schedule', tag: 'Changes', summary: 'Change schedule: planned changes, freezes and collisions', query: ch.scheduleSchema },
  { method: 'post', path: '/api/changes', tag: 'Changes', summary: 'Request a change (standard changes from a template); supports Idempotency-Key', body: ch.createChangeSchema },
  { method: 'post', path: '/api/changes/register', tag: 'Changes', summary: 'Register a standard change carried out by automation (deployment pipelines); token with ingest scope or an integration account', body: ch.registerSchema },
  { method: 'get', path: '/api/changes/:ref', tag: 'Changes', summary: 'A change with risk, approvals, affected CIs and services, collisions, freezes and related incidents' },
  { method: 'patch', path: '/api/changes/:ref', tag: 'Changes', summary: 'Update a change; send base to detect conflicting edits', body: ch.updateChangeSchema },
  { method: 'post', path: '/api/changes/:ref/transition', tag: 'Changes', summary: 'Move a change through its lifecycle', body: ch.transitionChangeSchema },
  { method: 'post', path: '/api/changes/:ref/votes', tag: 'Changes', summary: 'Approve or reject (change authority, web UI session only)', body: ch.voteSchema },
  { method: 'post', path: '/api/changes/:ref/comments', tag: 'Changes', summary: 'Add a note', body: z.object({ body: z.string() }) },
  { method: 'post', path: '/api/changes/:ref/links', tag: 'Changes', summary: 'Link a pull request, pipeline run, document, incident or external change', body: ch.changeLinkSchema },
  { method: 'post', path: '/api/changes/:ref/cis', tag: 'Changes', summary: 'Link an affected CI or service', body: problemCis.linkCiSchema },
  { method: 'delete', path: '/api/changes/:ref/cis/:ci', tag: 'Changes', summary: 'Unlink a CI or service' },
  { method: 'post', path: '/api/problems/:ref/change', tag: 'Changes', summary: 'Raise a change for the fix of a problem (prefilled, linked)' },
  { method: 'get', path: '/api/change-templates', tag: 'Changes', summary: 'Standard change templates' },
  { method: 'post', path: '/api/change-templates', tag: 'Changes', summary: 'Create a standard change template (change authority)', body: ch.templateSchema },
  { method: 'put', path: '/api/change-templates/:id', tag: 'Changes', summary: 'Update a template', body: ch.templateSchema },
  { method: 'get', path: '/api/change-freezes', tag: 'Changes', summary: 'Change freezes' },
  { method: 'post', path: '/api/change-freezes', tag: 'Changes', summary: 'Add a change freeze (change authority)', body: ch.freezeSchema },
  { method: 'delete', path: '/api/change-freezes/:id', tag: 'Changes', summary: 'Remove a change freeze' },
  { method: 'post', path: '/api/events', tag: 'Events', summary: 'Report normalised events (token with ingest scope, or a session); deduplicated into alerts', body: events.reportEventsSchema },
  { method: 'post', path: '/api/event-hooks/:id', tag: 'Events', summary: "Inbound webhook for a configured event source (Alertmanager, Uptime Kuma, Azure Monitor, OP5, generic). Authenticate with the source token (Authorization: Bearer, X-Kernel-Token, or ?token=); a signed generic source also needs Standard Webhooks headers" },
  { method: 'get', path: '/api/alerts', tag: 'Events', summary: 'Alerts (open by default), most severe first', query: events.listAlertsSchema },
  { method: 'get', path: '/api/alerts/:id', tag: 'Events', summary: 'An alert with its recent events' },
  { method: 'post', path: '/api/alerts/:id/ack', tag: 'Events', summary: 'Acknowledge an alert' },
  { method: 'post', path: '/api/alerts/:id/close', tag: 'Events', summary: 'Close an alert by hand; a new event for it opens it again' },
  { method: 'get', path: '/api/event-rules', tag: 'Events', summary: 'Rules that open or group incidents from alerts' },
  { method: 'post', path: '/api/event-rules', tag: 'Events', summary: 'Create a rule (problem managers)', body: events.ruleSchema },
  { method: 'put', path: '/api/event-rules/:id', tag: 'Events', summary: 'Update a rule', body: events.ruleSchema },
  { method: 'delete', path: '/api/event-rules/:id', tag: 'Events', summary: 'Delete a rule' },
  { method: 'get', path: '/api/maintenance-windows', tag: 'Events', summary: 'Current and upcoming maintenance windows (alerts on those CIs are suppressed)' },
  { method: 'post', path: '/api/maintenance-windows', tag: 'Events', summary: 'Schedule a maintenance window on a CI', body: events.maintenanceSchema },
  { method: 'delete', path: '/api/maintenance-windows/:id', tag: 'Events', summary: 'Remove a maintenance window' },
  { method: 'get', path: '/api/event-sources', tag: 'Events', summary: 'Inbound event sources (administrators)' },
  { method: 'post', path: '/api/event-sources', tag: 'Events', summary: 'Create a source; returns its URL, token and optional signing secret once', body: hooks.sourceSchema },
  { method: 'post', path: '/api/event-sources/:id/rotate', tag: 'Events', summary: "Rotate a source's token" },
  { method: 'patch', path: '/api/event-sources/:id', tag: 'Events', summary: 'Enable/disable a source or change its CMDB source system' },
  { method: 'delete', path: '/api/event-sources/:id', tag: 'Events', summary: 'Delete a source' },
  { method: 'get', path: '/api/inbound-mail', tag: 'Incidents', summary: 'Inbound email waiting for review: replies that could not be added on their own, with why (#48)' },
  { method: 'post', path: '/api/inbound-mail/:id/decide', tag: 'Incidents', summary: 'Decide a held email: a new incident, a comment on an incident, or discard', body: inbound.inboundDecisionSchema },
  { method: 'get', path: '/api/incidents', tag: 'Incidents', summary: 'List incidents (open by default)', query: inc.listIncidentsSchema },
  { method: 'post', path: '/api/incidents', tag: 'Incidents', summary: 'Log an incident (optionally with affected CIs); supports Idempotency-Key', body: inc.createIncidentSchema },
  { method: 'get', path: '/api/incidents/:ref', tag: 'Incidents', summary: 'An incident with affected CIs and services, known errors with workarounds, activity and next steps' },
  { method: 'patch', path: '/api/incidents/:ref', tag: 'Incidents', summary: 'Update fields; send base to detect conflicting edits', body: inc.updateIncidentSchema },
  { method: 'post', path: '/api/incidents/:ref/transition', tag: 'Incidents', summary: 'Change status: new, in_progress, on_hold (with reason), resolved (with code and resolution), closed', body: inc.transitionIncidentSchema },
  { method: 'post', path: '/api/incidents/:ref/comments', tag: 'Incidents', summary: 'Add a work note, or a communication update on a major incident', body: inc.incidentCommentSchema },
  { method: 'post', path: '/api/incidents/:ref/major', tag: 'Incidents', summary: 'Declare a major incident: lead (default: you), communications lead, bridge and update cadence (problem managers)', body: majorInc.declareMajorSchema },
  { method: 'patch', path: '/api/incidents/:ref/major', tag: 'Incidents', summary: 'Change the major incident team, bridge or update cadence (the lead or a manager)', body: majorInc.majorRolesSchema },
  { method: 'post', path: '/api/incidents/:ref/communications', tag: 'Incidents', summary: 'Post a stakeholder update on a major incident; restarts the update countdown', body: majorInc.communicationSchema },
  { method: 'post', path: '/api/incidents/:ref/children', tag: 'Incidents', summary: 'Relate an incident (the same outage reported again) to this one; it is resolved with it unless resolve_with_parent is false', body: majorInc.childSchema },
  { method: 'delete', path: '/api/incidents/:ref/children/:child', tag: 'Incidents', summary: 'Unrelate an incident' },
  { method: 'get', path: '/api/incidents/:ref/timeline', tag: 'Incidents', summary: 'Key moments, oldest first (?format=md for Markdown): declared, first response, updates, status, linked changes and events, marked entries' },
  { method: 'put', path: '/api/incidents/:ref/activity/:id/key-moment', tag: 'Incidents', summary: 'Mark or unmark an activity entry as a key moment for the timeline', body: majorInc.keyMomentSchema },
  { method: 'get', path: '/api/reviews', tag: 'Incidents', summary: 'Post-incident reviews as a record type (the same list as /api/incident-reviews)', query: reviewsMod.listReviewsSchema },
  { method: 'post', path: '/api/reviews', tag: 'Incidents', summary: 'Schedule a post-incident review for an incident. Supports Idempotency-Key', body: reviewsMod.createReviewSchema.extend({ incident: z.string() }) },
  { method: 'get', path: '/api/reviews/:ref', tag: 'Incidents', summary: 'A post-incident review by its ref (PIR000012) or its incident\'s, with next_steps' },
  { method: 'patch', path: '/api/reviews/:ref', tag: 'Incidents', summary: 'Edit the review: owner, due date, attendees and the template sections', body: reviewsMod.updateReviewSchema },
  { method: 'post', path: '/api/reviews/:ref/transition', tag: 'Incidents', summary: 'Publish the review, or waive it with a reason (managers)', body: reviewsMod.transitionReviewSchema },
  { method: 'post', path: '/api/reviews/:ref/links', tag: 'Incidents', summary: "Link the review's incident to another record or an external reference", body: z.object({ to: z.string(), kind: z.string().optional(), system: z.string().optional(), url: z.string().optional(), note: z.string().optional() }) },
  { method: 'post', path: '/api/reviews/:ref/comments', tag: 'Incidents', summary: 'Add a work note to the review (kept in the incident activity). Supports Idempotency-Key', body: z.object({ body: z.string() }) },
  { method: 'get', path: '/api/incident-reviews', tag: 'Incidents', summary: 'Post-incident reviews: due (overdue first), published or waived; by owner (me or an id) and team (mine or an id)', query: reviewsMod.listReviewsSchema },
  { method: 'get', path: '/api/incidents/:ref/review', tag: 'Incidents', summary: 'The post-incident review with its items, the timeline and impact as context, and the blameless guide (filled in from what Kernel knows when first opened)' },
  { method: 'post', path: '/api/incidents/:ref/review', tag: 'Incidents', summary: 'Schedule a post-incident review for any incident (major incidents get one when resolved)', body: reviewsMod.createReviewSchema },
  { method: 'patch', path: '/api/incidents/:ref/review', tag: 'Incidents', summary: 'Edit the review: owner, due date, attendees and the template sections', body: reviewsMod.updateReviewSchema },
  { method: 'post', path: '/api/incidents/:ref/review/items', tag: 'Incidents', summary: 'Add a contributing factor, follow-up or detection/response gap', body: reviewsMod.itemSchema },
  { method: 'delete', path: '/api/incidents/:ref/review/items/:id', tag: 'Incidents', summary: 'Remove an item that has not become a problem or action' },
  { method: 'post', path: '/api/incidents/:ref/review/items/:id/problem', tag: 'Incidents', summary: 'Contributing factor → a new problem (the factor as its statement) or an existing one, linked both ways', body: reviewsMod.itemProblemSchema },
  { method: 'post', path: '/api/incidents/:ref/review/items/:id/action', tag: 'Incidents', summary: "Follow-up → an action with owner and due date, on the named problem, the factor's or the incident's", body: reviewsMod.itemActionSchema },
  { method: 'post', path: '/api/incidents/:ref/review/publish', tag: 'Incidents', summary: 'Publish the review (owner, incident lead or manager)' },
  { method: 'post', path: '/api/incidents/:ref/review/waive', tag: 'Incidents', summary: 'Waive the review with a reason (managers; audited)', body: reviewsMod.waiveSchema },
  { method: 'post', path: '/api/incidents/:ref/review/article', tag: 'Knowledge', summary: 'Draft a knowledge article from the lessons of the review' },
  { method: 'get', path: '/api/incidents/:ref/review/export.md', tag: 'Incidents', summary: 'The review as Markdown' },
  { method: 'post', path: '/api/incidents/:ref/links', tag: 'Incidents', summary: 'Link an external incident, event, change or document', body: inc.incidentLinkSchema },
  { method: 'delete', path: '/api/incidents/:ref/links/:id', tag: 'Incidents', summary: 'Remove a link' },
  { method: 'post', path: '/api/incidents/:ref/cis', tag: 'Incidents', summary: 'Link an affected CI or service', body: problemCis.linkCiSchema },
  { method: 'delete', path: '/api/incidents/:ref/cis/:ci', tag: 'Incidents', summary: 'Unlink a CI or service' },
  { method: 'put', path: '/api/incidents/:ref/problem', tag: 'Incidents', summary: 'Link the incident to a problem (empty problem unlinks)', body: z.object({ problem: z.string() }) },
  { method: 'post', path: '/api/incidents/:ref/problem', tag: 'Incidents', summary: 'Log a problem prefilled from the incident and link it', body: inc.problemFromIncidentSchema },
  { method: 'post', path: '/api/problems/:ref/resolve-incidents', tag: 'Incidents', summary: "Resolve a problem's open incidents with resolution code problem_fixed", body: inc.resolveLinkedSchema },
  { method: 'post', path: '/api/problems/:ref/cis', tag: 'CMDB', summary: 'Link an affected CI or service to a problem', body: problemCis.linkCiSchema },
  { method: 'delete', path: '/api/problems/:ref/cis/:ci', tag: 'CMDB', summary: 'Unlink a CI or service from a problem' },
  { method: 'post', path: '/api/cmdb/ci-batch', tag: 'CMDB', summary: 'Push contract: CIs and relationships from one source; full_sync marks what the source no longer reports (a sharply shrunk snapshot is refused)', body: conn.ciBatchSchema },
  { method: 'get', path: '/api/connectors', tag: 'CMDB', summary: 'Pull connectors and their last run (administrators)' },
  { method: 'post', path: '/api/connectors', tag: 'CMDB', summary: 'Create a connector; credentials are encrypted and never returned', body: conn.connectorSchema },
  { method: 'put', path: '/api/connectors/:id', tag: 'CMDB', summary: 'Update a connector (omit secret to keep the credentials)', body: conn.connectorSchema },
  { method: 'delete', path: '/api/connectors/:id', tag: 'CMDB', summary: 'Delete a connector' },
  { method: 'get', path: '/api/connectors/types/:type/setup', tag: 'CMDB', summary: 'Setup text for a connector type from the form settings, e.g. the Kubernetes least-privilege RBAC manifest (cluster_name, sync_events)' },
  { method: 'post', path: '/api/connectors/:id/test', tag: 'CMDB', summary: 'Test the connection' },
  { method: 'post', path: '/api/connectors/:id/run', tag: 'CMDB', summary: 'Run now (never overlaps a running sync)' },
  { method: 'get', path: '/api/connectors/:id/runs', tag: 'CMDB', summary: 'The run log: counts, errors, duration' },
  { method: 'get', path: '/api/ci-relationship-types', tag: 'CMDB', summary: 'Relationship types with direction, inverse label and how outages propagate' },
  { method: 'post', path: '/api/cis/:ref/relationships', tag: 'CMDB', summary: 'Add a manual relationship (problem managers)', body: graph.relationshipSchema },
  { method: 'delete', path: '/api/cis/:ref/relationships/:id', tag: 'CMDB', summary: 'Remove a manual relationship (discovered ones are owned by their source)' },
  { method: 'post', path: '/api/ci-relationships/sync', tag: 'CMDB', summary: 'Report relationships from a source system by its ids; full sync removes what it no longer reports', body: graph.syncSchema },
  { method: 'get', path: '/api/cis/:ref/impact', tag: 'CMDB', summary: 'Impact (up: what is affected if this is down) or dependencies (down); bounded depth and size', query: graph.impactSchema },
  { method: 'get', path: '/api/ci-groups', tag: 'CMDB', summary: 'CI groups (services, flows, billing, monitoring…)' },
  { method: 'post', path: '/api/ci-groups', tag: 'CMDB', summary: 'Create a group with optional membership rules', body: graph.groupSchema },
  { method: 'get', path: '/api/ci-groups/:id', tag: 'CMDB', summary: 'A group with its manual and rule-matched members' },
  { method: 'put', path: '/api/ci-groups/:id', tag: 'CMDB', summary: 'Update a group', body: graph.groupSchema },
  { method: 'delete', path: '/api/ci-groups/:id', tag: 'CMDB', summary: 'Delete a group' },
  { method: 'put', path: '/api/ci-groups/:id/members/:ref', tag: 'CMDB', summary: 'Add a CI to a group by hand' },
  { method: 'delete', path: '/api/ci-groups/:id/members/:ref', tag: 'CMDB', summary: 'Remove a manually added CI from a group' },
  { method: 'get', path: '/api/kedb', tag: 'Known errors', summary: 'Search the known error database', query: z.object({ q: z.string().optional(), include_resolved: z.enum(['true', 'false']).optional() }) },

  { method: 'get', path: '/api/reports', tag: 'Reports', summary: 'KPIs and trends for a period', query: reports.reportSchema },
  { method: 'get', path: '/api/reports/problems.csv', tag: 'Reports', summary: 'Problems active in a period as CSV', query: reports.reportSchema, produces: 'text/csv' },
  { method: 'get', path: '/api/review', tag: 'Reports', summary: 'Problem review meeting agenda', query: review.agendaSchema },
  { method: 'get', path: '/api/review/agenda.md', tag: 'Reports', summary: 'Review agenda as Markdown', query: review.agendaSchema, produces: 'text/markdown' },

  { method: 'post', path: '/api/integrations/records', tag: 'Integrations', summary: 'Report incidents/events from other systems (idempotent; optional problem_ref links them)', body: integrations.ingestSchema },
  { method: 'get', path: '/api/candidates', tag: 'Problem candidates', summary: 'Problem candidates with their rule, reason and evidence, and the rules', query: candidates.listQuerySchema },
  { method: 'put', path: '/api/candidates/rules/:rule', tag: 'Problem candidates', summary: 'Turn a rule on or off or change its thresholds (problem managers)', body: candidates.ruleUpdateSchema },
  { method: 'get', path: '/api/candidates/draft', tag: 'Problem candidates', summary: 'The problem a candidate suggests, prefilled from its evidence', query: z.object({ key: z.string() }) },
  { method: 'post', path: '/api/candidates/create', tag: 'Problem candidates', summary: 'Log a problem from a candidate (by key, prefilled) or from records', body: ids.extend({ problem: candidates.problemOverridesSchema.optional() }) },
  { method: 'post', path: '/api/candidates/link', tag: 'Problem candidates', summary: 'Link a candidate or its records to a problem', body: ids.extend({ ref: z.string() }) },
  { method: 'post', path: '/api/candidates/dismiss', tag: 'Problem candidates', summary: 'Dismiss a candidate, or snooze it with until (reason required)', body: candidates.decisionSchema },
  { method: 'post', path: '/api/candidates/restore', tag: 'Problem candidates', summary: 'Undo a dismissal or snooze', body: z.object({ key: z.string() }) },
  { method: 'get', path: '/api/candidates/eol', tag: 'Problem candidates', summary: 'The end-of-life table (product + version → date) behind the eol_versions rule' },
  { method: 'post', path: '/api/candidates/eol', tag: 'Problem candidates', summary: 'Add an end-of-life row (problem managers)', body: config.eolSchema },
  { method: 'put', path: '/api/candidates/eol/:id', tag: 'Problem candidates', summary: 'Change an end-of-life row (problem managers)', body: config.eolSchema },
  { method: 'delete', path: '/api/candidates/eol/:id', tag: 'Problem candidates', summary: 'Remove an end-of-life row (problem managers)' },
  { method: 'post', path: '/api/candidates/report', tag: 'Problem candidates', summary: 'Report a candidate from external analysis (idempotent on source + external_key; ingest scope)', body: candidates.reportSchema },
  { method: 'get', path: '/api/systems', tag: 'Integrations', summary: 'External systems and their URL templates' },
  { method: 'post', path: '/api/systems', tag: 'Integrations', summary: 'Add an external system (problem managers)', body: integrations.systemSchema },
  { method: 'put', path: '/api/systems/:id', tag: 'Integrations', summary: 'Update an external system', body: integrations.systemSchema },

  { method: 'get', path: '/api/users', tag: 'Administration', summary: 'Users (admins)' },
  { method: 'post', path: '/api/users', tag: 'Administration', summary: 'Create a user (admins)', body: user },
  { method: 'patch', path: '/api/users/:id', tag: 'Administration', summary: "Update a user (admins); a reason is required to change someone's role, status or password", body: user.partial().omit({ username: true }).extend({ reason: z.string().optional() }) },
  { method: 'post', path: '/api/categories', tag: 'Administration', summary: 'Add a category', body: z.object({ name: z.string().min(1).max(100) }) },
  { method: 'patch', path: '/api/categories/:id', tag: 'Administration', summary: 'Rename or (de)activate a category', body: z.object({ name: z.string().optional(), active: z.boolean().optional() }) },
  { method: 'get', path: '/api/admin/security', tag: 'Administration', summary: 'Security configuration checklist (admins)' },
  { method: 'post', path: '/api/csp-report', tag: 'Reference data', summary: 'Content Security Policy violation reports (browsers)', public: true },
  { method: 'get', path: '/api/audit', tag: 'Administration', summary: 'Audit trail: who did what, when, how and why (admins)', query: auditQuerySchema },
  { method: 'get', path: '/api/audit.csv', tag: 'Administration', summary: 'Audit trail as CSV (the export itself is audited)', query: auditQuerySchema, produces: 'text/csv' },
  { method: 'get', path: '/api/audit/verify', tag: 'Administration', summary: 'Verify the audit trail hash chain' },
  { method: 'get', path: '/api/security-events', tag: 'Administration', summary: 'Security events: sign-ins, failures, denials, token use from new addresses, admin changes, exports (admins)', query: securityQuerySchema },
  { method: 'get', path: '/api/security-events/summary', tag: 'Administration', summary: 'Security events of the last 24 hours, by outcome and most frequent non-success actions' },
  { method: 'get', path: '/api/admin/security-alerting', tag: 'Administration', summary: 'Security alerting: detection rules and thresholds, the event rule for security incidents, open security alerts' },
  { method: 'put', path: '/api/admin/security-alerting', tag: 'Administration', summary: 'Change the detection rules and thresholds (step-up and a reason)', body: alertingSchema.extend({ reason: z.string() }) },
  { method: 'get', path: '/api/admin/privacy', tag: 'Administration', summary: 'Retention of network context in the audit trail and of security events' },
  { method: 'put', path: '/api/admin/privacy', tag: 'Administration', summary: 'Set the retention of audit context and security events (30 to 3650 days; step-up and a reason)', body: privacySchema.extend({ reason: z.string() }) },
  { method: 'get', path: '/api/admin/backups', tag: 'Administration', summary: 'Backup health and dumps' },
  { method: 'get', path: '/api/webhooks', tag: 'Administration', summary: 'Webhooks, available events and formats (admins)' },
  { method: 'post', path: '/api/webhooks', tag: 'Administration', summary: 'Create a webhook (secret returned once)', body: webhooks.webhookSchema },
  { method: 'put', path: '/api/webhooks/:id', tag: 'Administration', summary: 'Update a webhook', body: webhooks.webhookSchema },
  { method: 'delete', path: '/api/webhooks/:id', tag: 'Administration', summary: 'Delete a webhook (reason required as ?reason=)', query: z.object({ reason: z.string() }) },
  { method: 'post', path: '/api/webhooks/:id/rotate', tag: 'Administration', summary: 'Replace the signing secret (new secret returned once)' },
  { method: 'get', path: '/api/webhooks/:id/deliveries', tag: 'Administration', summary: 'Recent deliveries' },
  { method: 'post', path: '/api/webhooks/:id/ping', tag: 'Administration', summary: 'Send a test delivery' },

  { method: 'get', path: '/api/openapi.json', tag: 'Reference data', summary: 'This document', public: true },
  // Bulk actions (#110): one per practice list.
  ...bulkMod.PRACTICES.map((p): Op => ({
    method: 'post', path: `/api/${p}/bulk`, tag: BULK_TAG[p], body: bulkMod.bulkSchema,
    summary: `Apply one operation (${bulkMod.operationsFor(p).join(', ')}) to many ${p} by ids or the list filter (at most ${bulkMod.BULK_LIMIT}), through the same rules as single edits; dry_run previews. Returns an outcome per record and, when reversible, an undo body. Supports Idempotency-Key`,
  })),
];

const toSchema = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Record<string, any>;

export function openApiDocument(serverUrl?: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    // Switched-off modules are not part of the API (#36).
    if (MODULE_TAGS[op.tag] && !moduleEnabled(MODULE_TAGS[op.tag])) continue;
    const path = op.path.replace(/:(\w+)/g, '{$1}');
    const params = [...op.path.matchAll(/:(\w+)/g)].map(([, name]) => ({ name, in: 'path', required: true, schema: { type: name === 'ref' ? 'string' : 'integer' } }));
    if (op.query) {
      const q = toSchema(op.query);
      for (const [name, schema] of Object.entries<any>(q.properties ?? {})) {
        params.push({ name, in: 'query', required: (q.required ?? []).includes(name) && schema.default === undefined, schema } as any);
      }
    }
    (paths[path] ??= {})[op.method] = {
      tags: [op.tag],
      summary: op.summary,
      operationId: `${op.method}_${op.path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
      ...(params.length ? { parameters: params } : {}),
      ...(op.body ? { requestBody: { required: true, content: { 'application/json': { schema: toSchema(op.body) } } } } : {}),
      responses: {
        '200': { description: 'OK', content: { [op.produces ?? 'application/json']: {} } },
        '400': { description: 'Invalid input', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        ...(op.public ? {} : { '401': { description: 'Not authenticated' }, '403': { description: 'Not allowed for your role' } }),
        '404': { description: 'Not found' },
        '409': { description: 'Conflicts with the current state, e.g. a workflow rule', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
      ...(op.public ? { security: [] } : {}),
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Kernel API',
      version: '1',
      description:
        'Problem management (ITIL 4). Authenticate with `Authorization: Bearer krn_…` (personal API token, see Settings) or the session cookie; ' +
        'cookie-authenticated changes must send `X-Kernel-Request: 1`. Business rules (workflow, roles) are enforced server-side and reported as 409/403 with an `error` message. ' +
        'Record-creating requests accept an `Idempotency-Key` header: a retry with the same key and body returns the original response. ' +
        'Every record has a `ref` (e.g. PRB000012), a `type` and a `url` to the web UI; see docs/api-conventions.md. ' +
        'An MCP server with the same capabilities is available at /mcp.',
    },
    ...(serverUrl ? { servers: [{ url: serverUrl }] } : {}),
    security: [{ bearer: [] }, { cookie: [] }],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'Personal API token (krn_…)' },
        cookie: { type: 'apiKey', in: 'cookie', name: 'kernel_session' },
      },
      schemas: { Error: { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] } },
    },
    paths,
  };
}
