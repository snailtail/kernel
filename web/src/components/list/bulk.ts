import type { OpName, Practice } from '../../bulk';
import { ACTION_STATUS, ARTICLE_STATUS, CHANGE_STATUS, CI_STATUS, IMPROVEMENT_STATUS, INCIDENT_STATUS, PROBLEM_STATUS } from '../../statuses';

export interface BulkSpec {
  practice: Practice;
  /** "incident", "incidents". */
  noun: [string, string];
  ops: OpName[];
  statuses?: Record<string, string>;
  /** "Owner" for actions and articles; teams only where records have one. */
  owner?: 'assignee' | 'owner';
  teams?: boolean;
}


/** What each list can do in bulk; the server checks the same per operation and role. */
export const BULK: Record<string, BulkSpec> = {
  incidents: { practice: 'incidents', noun: ['incident', 'incidents'], ops: ['assign', 'status', 'priority', 'link_problem', 'set_parent'], statuses: INCIDENT_STATUS, owner: 'assignee', teams: true },
  problems: { practice: 'problems', noun: ['problem', 'problems'], ops: ['assign', 'status', 'priority'], statuses: PROBLEM_STATUS, owner: 'assignee', teams: true },
  known_errors: { practice: 'problems', noun: ['known error', 'known errors'], ops: ['assign', 'status', 'priority'], statuses: PROBLEM_STATUS, owner: 'assignee', teams: true },
  changes: { practice: 'changes', noun: ['change', 'changes'], ops: ['assign', 'status'], statuses: CHANGE_STATUS, owner: 'assignee', teams: true },
  alerts: { practice: 'alerts', noun: ['alert', 'alerts'], ops: ['acknowledge', 'close'] },
  actions: { practice: 'actions', noun: ['action', 'actions'], ops: ['assign', 'status'], statuses: ACTION_STATUS, owner: 'owner' },
  knowledge: { practice: 'articles', noun: ['article', 'articles'], ops: ['assign', 'status'], statuses: ARTICLE_STATUS, owner: 'owner' },
  improvements: { practice: 'improvements', noun: ['improvement', 'improvements'], ops: ['assign', 'status'], statuses: IMPROVEMENT_STATUS, owner: 'owner' },
  requests: { practice: 'requests', noun: ['request', 'requests'], ops: ['status'], statuses: { cancelled: 'Cancelled' } },
  cis: { practice: 'cis', noun: ['CI', 'CIs'], ops: ['tags', 'status'], statuses: CI_STATUS },
};

export const OP_LABEL: Record<OpName, string> = {
  assign: 'Assign', status: 'Status', priority: 'Priority', tags: 'Tags', link_problem: 'Link to problem', set_parent: 'Relate to incident', acknowledge: 'Acknowledge', close: 'Close',
};

export const UNDO_SECONDS = 30;
