// The one authorisation layer: what each role may do, deny by default. Routes, services and MCP all ask can() /
// authorize(); there are no ad hoc role checks elsewhere. Object-level scoping (teams, restricted records) comes
// with #53 and will extend can() with the resource.
import { forbidden } from './errors.js';
import type { Role } from './workflow.js';

export const ACTIONS = [
  // Reading
  'meta.read', 'problem.read', 'kedb.read', 'report.read', 'review.read', 'candidate.read', 'system.read', 'ci.read',
  // Problem work
  'problem.create', 'problem.update', 'problem.transition', 'problem.comment', 'problem.link', 'problem.watch',
  'problem.assess', 'action.write', 'analysis.write', 'candidate.act', 'ci.annotate',
  // Problem management decisions
  'problem.close', 'problem.reopen_closed', 'problem.flag_major', 'problem.accept_risk', 'problem.mark_duplicate',
  'candidate.rule', 'category.manage', 'system.manage', 'backup.read', 'ci.manage',
  // Administration
  'user.manage', 'webhook.manage', 'audit.read', 'security.read', 'mfa.policy',
  // Integrations
  'record.ingest', 'ci.ingest',
] as const;
export type Action = (typeof ACTIONS)[number];

const READ: Action[] = ['meta.read', 'problem.read', 'kedb.read', 'report.read', 'review.read', 'candidate.read', 'system.read', 'ci.read'];
const WORK: Action[] = ['problem.create', 'problem.update', 'problem.transition', 'problem.comment', 'problem.link', 'problem.watch', 'problem.assess', 'action.write', 'analysis.write', 'candidate.act', 'record.ingest', 'ci.annotate'];
const MANAGE: Action[] = ['problem.close', 'problem.reopen_closed', 'problem.flag_major', 'problem.accept_risk', 'problem.mark_duplicate', 'candidate.rule', 'category.manage', 'system.manage', 'backup.read', 'ci.manage', 'ci.ingest'];
const ADMIN: Action[] = ['user.manage', 'webhook.manage', 'audit.read', 'security.read', 'mfa.policy'];

export const PERMISSIONS: Record<Role, ReadonlySet<Action>> = {
  viewer: new Set([...READ, 'problem.watch']),
  analyst: new Set([...READ, ...WORK]),
  problem_manager: new Set([...READ, ...WORK, ...MANAGE]),
  admin: new Set([...READ, ...WORK, ...MANAGE, ...ADMIN]),
  // Integration accounts report records; they cannot read the rest of Kernel.
  integration: new Set(['meta.read', 'record.ingest', 'ci.ingest']),
};

const MESSAGES: Partial<Record<Action, string>> = {
  'problem.close': 'Only a problem manager can close problems',
  'problem.reopen_closed': 'Only a problem manager can reopen a closed problem',
  'problem.flag_major': 'Only a problem manager can change the major problem flag',
  'problem.accept_risk': 'Only a problem manager can accept or defer the risk of a known error',
  'problem.mark_duplicate': 'Only a problem manager can mark duplicates (it closes the problem)',
};

export function can(role: Role, action: Action): boolean {
  return PERMISSIONS[role]?.has(action) ?? false;
}

/** Throws 403 unless the user's role allows the action. */
export function authorize(user: { role: Role }, action: Action) {
  if (!can(user.role, action)) {
    throw forbidden(MESSAGES[action] ?? (action.endsWith('.read') ? 'Your role cannot see this' : 'Your role cannot do this'));
  }
}
