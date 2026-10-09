// OpenAPI 3.1 description of the REST API, generated from the zod schemas the routes validate with.
// A test checks that every registered /api route is listed here.
import { z } from 'zod';
import * as actions from './actions.js';
import * as cmdb from './cmdb.js';
import { MODULE_TAGS, moduleEnabled } from './modules.js';
import * as graph from './cmdb-graph.js';
import * as conn from './connectors.js';
import * as problemCis from './problem-cis.js';
import * as inc from './incidents.js';
import * as events from './events.js';
import * as ch from './changes.js';
import * as slaMod from './sla.js';
import * as notif from './notifications.js';
import * as setupMod from './setup.js';
import * as ppl from './people.js';
import * as hooks from './event-hooks.js';
import { auditQuerySchema } from './audit.js';
import { searchSchema } from './generic.js';
import * as analyses from './analyses.js';
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
const ids = integrations.candidateIdsSchema;

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
  { method: 'get', path: '/api/incidents', tag: 'Incidents', summary: 'List incidents (open by default)', query: inc.listIncidentsSchema },
  { method: 'post', path: '/api/incidents', tag: 'Incidents', summary: 'Log an incident (optionally with affected CIs); supports Idempotency-Key', body: inc.createIncidentSchema },
  { method: 'get', path: '/api/incidents/:ref', tag: 'Incidents', summary: 'An incident with affected CIs and services, known errors with workarounds, activity and next steps' },
  { method: 'patch', path: '/api/incidents/:ref', tag: 'Incidents', summary: 'Update fields; send base to detect conflicting edits', body: inc.updateIncidentSchema },
  { method: 'post', path: '/api/incidents/:ref/transition', tag: 'Incidents', summary: 'Change status: new, in_progress, on_hold (with reason), resolved (with code and resolution), closed', body: inc.transitionIncidentSchema },
  { method: 'post', path: '/api/incidents/:ref/comments', tag: 'Incidents', summary: 'Add a work note, or a communication update on a major incident', body: inc.incidentCommentSchema },
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
  { method: 'get', path: '/api/candidates', tag: 'Integrations', summary: 'Problem candidates: services with recurring unlinked records' },
  { method: 'put', path: '/api/candidates/rule', tag: 'Integrations', summary: 'Set the candidate rule (problem managers)', body: integrations.ruleSchema },
  { method: 'post', path: '/api/candidates/create', tag: 'Integrations', summary: 'Log a problem from candidate records', body: ids.extend({ problem: problems.createProblemSchema }) },
  { method: 'post', path: '/api/candidates/link', tag: 'Integrations', summary: 'Link candidate records to a problem', body: ids.extend({ ref: z.string() }) },
  { method: 'post', path: '/api/candidates/dismiss', tag: 'Integrations', summary: 'Dismiss candidate records', body: ids },
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
  { method: 'get', path: '/api/admin/backups', tag: 'Administration', summary: 'Backup health and dumps' },
  { method: 'get', path: '/api/webhooks', tag: 'Administration', summary: 'Webhooks, available events and formats (admins)' },
  { method: 'post', path: '/api/webhooks', tag: 'Administration', summary: 'Create a webhook (secret returned once)', body: webhooks.webhookSchema },
  { method: 'put', path: '/api/webhooks/:id', tag: 'Administration', summary: 'Update a webhook', body: webhooks.webhookSchema },
  { method: 'delete', path: '/api/webhooks/:id', tag: 'Administration', summary: 'Delete a webhook (reason required as ?reason=)', query: z.object({ reason: z.string() }) },
  { method: 'post', path: '/api/webhooks/:id/rotate', tag: 'Administration', summary: 'Replace the signing secret (new secret returned once)' },
  { method: 'get', path: '/api/webhooks/:id/deliveries', tag: 'Administration', summary: 'Recent deliveries' },
  { method: 'post', path: '/api/webhooks/:id/ping', tag: 'Administration', summary: 'Send a test delivery' },

  { method: 'get', path: '/api/openapi.json', tag: 'Reference data', summary: 'This document', public: true },
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
