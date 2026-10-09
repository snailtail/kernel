// The one authorisation layer: what each role may do, deny by default. Routes, services and MCP all ask can() /
// authorize(); there are no ad hoc role checks elsewhere. Object-level scoping (teams, restricted records) comes
// with #53 and will extend can() with the resource.
import { forbidden, notFound } from './errors.js';
import type { Role } from './workflow.js';
import { actionEnabled, moduleEnabled, moduleOfAction, MODULES } from './modules.js';

export const ACTIONS = [
  // Reading
  'meta.read', 'problem.read', 'kedb.read', 'report.read', 'review.read', 'candidate.read', 'system.read', 'ci.read', 'incident.read', 'event.read', 'change.read', 'person.read', 'article.read', 'team.read',
  // Problem work
  'problem.create', 'problem.update', 'problem.transition', 'problem.comment', 'problem.link', 'problem.watch',
  'problem.assess', 'action.write', 'analysis.write', 'candidate.act', 'ci.annotate', 'incident.create', 'incident.update', 'event.ack', 'event.ingest', 'change.create', 'change.update', 'change.register', 'person.write', 'person.contact', 'attachment.add', 'article.write', 'article.publish', 'record.restrict',
  // Problem management decisions
  'problem.close', 'problem.reopen_closed', 'problem.flag_major', 'problem.accept_risk', 'problem.mark_duplicate',
  'candidate.rule', 'category.manage', 'system.manage', 'backup.read', 'ci.manage', 'incident.flag_major', 'event.manage', 'change.approve', 'change.manage', 'sla.manage', 'organisation.manage', 'article.publish_public',
  // Administration
  'user.manage', 'webhook.manage', 'audit.read', 'security.read', 'mfa.policy', 'team.manage', 'record.break_glass',
  // Integrations
  'record.ingest', 'ci.ingest',
] as const;
export type Action = (typeof ACTIONS)[number];

const READ: Action[] = ['meta.read', 'problem.read', 'kedb.read', 'report.read', 'review.read', 'candidate.read', 'system.read', 'ci.read', 'incident.read', 'event.read', 'change.read', 'person.read', 'article.read', 'team.read'];
const WORK: Action[] = ['problem.create', 'problem.update', 'problem.transition', 'problem.comment', 'problem.link', 'problem.watch', 'problem.assess', 'action.write', 'analysis.write', 'candidate.act', 'record.ingest', 'ci.annotate', 'incident.create', 'incident.update', 'event.ack', 'event.ingest', 'change.create', 'change.update', 'change.register', 'person.write', 'person.contact', 'attachment.add', 'article.write', 'article.publish', 'record.restrict'];
const MANAGE: Action[] = ['problem.close', 'problem.reopen_closed', 'problem.flag_major', 'problem.accept_risk', 'problem.mark_duplicate', 'candidate.rule', 'category.manage', 'system.manage', 'backup.read', 'ci.manage', 'ci.ingest', 'incident.flag_major', 'event.manage', 'change.approve', 'change.manage', 'sla.manage', 'organisation.manage', 'article.publish_public'];
const ADMIN: Action[] = ['user.manage', 'webhook.manage', 'audit.read', 'security.read', 'mfa.policy', 'team.manage', 'record.break_glass'];

export const PERMISSIONS: Record<Role, ReadonlySet<Action>> = {
  viewer: new Set([...READ, 'problem.watch']),
  analyst: new Set([...READ, ...WORK]),
  problem_manager: new Set([...READ, ...WORK, ...MANAGE]),
  admin: new Set([...READ, ...WORK, ...MANAGE, ...ADMIN]),
  // Integration accounts report records; they cannot read the rest of Kernel.
  integration: new Set(['meta.read', 'record.ingest', 'ci.ingest', 'event.ingest', 'change.register']),
};

const MESSAGES: Partial<Record<Action, string>> = {
  'problem.close': 'Only a problem manager can close problems',
  'problem.reopen_closed': 'Only a problem manager can reopen a closed problem',
  'problem.flag_major': 'Only a problem manager can change the major problem flag',
  'problem.accept_risk': 'Only a problem manager can accept or defer the risk of a known error',
  'problem.mark_duplicate': 'Only a problem manager can mark duplicates (it closes the problem)',
  'incident.flag_major': 'Only a problem manager can declare or stand down a major incident',
  'article.publish_public': 'Only a problem manager can publish articles for end users',
  'team.manage': 'Only an administrator can create, rename or remove teams',
  'change.approve': 'Only the change authority (problem managers and administrators) can approve changes',
};

export function can(role: Role, action: Action): boolean {
  return (PERMISSIONS[role]?.has(action) ?? false) && actionEnabled(action);
}

/** Throws 403 unless the user's role allows the action. */
export function authorize(user: { role: Role }, action: Action) {
  // A switched-off module does not exist for anyone (#36): 404, not 403.
  const module = moduleOfAction(action);
  if (module && !moduleEnabled(module)) throw notFound(`The ${MODULES[module].label} module is turned off`);
  if (!can(user.role, action)) {
    throw forbidden(MESSAGES[action] ?? (action.endsWith('.read') ? 'Your role cannot see this' : 'Your role cannot do this'));
  }
}
