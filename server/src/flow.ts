// The big picture (#37): the process map event → incident → problem → known error → change → resolution, with live
// counts from the user's own data, and gentle health tips. Only practices whose module is on, and only what the
// caller may read, are included – for people in the UI and for agents over MCP.
import type { User } from './auth.js';
import { query } from './db.js';
import { moduleEnabled, type Module } from './modules.js';
import { can, type Action } from './policy.js';

interface Count { label: string; value: number; link: string }
interface Node {
  id: string;
  label: string;
  module: Module | null;
  purpose: string;
  concepts: string[];
  hands_over: { to: string; when: string }[];
  counts: Count[];
}

const n = async (sql: string, params: unknown[] = []) => Number((await query(sql, params)).rows[0].n);

export async function processMap(user: User) {
  const readable = (a: Action) => can(user.role, a);
  const nodes: Node[] = [];
  if (moduleEnabled('event') && readable('event.read')) {
    nodes.push({
      id: 'event', label: 'Event', module: 'event',
      purpose: 'Monitoring notices something: a check fails, a threshold is crossed. Most events need no one; some become incidents.',
      concepts: ['Alerts are deduplicated per CI and check', 'Rules open incidents', 'Maintenance suppresses alerts'],
      hands_over: [{ to: 'incident', when: 'An event rule matches, or someone opens an incident from an alert' }, { to: 'problem', when: 'Alerts keep recurring without an incident (problem candidates)' }],
      counts: [
        { label: 'open alerts', value: await n("SELECT count(*) AS n FROM alerts WHERE status = 'open' AND suppressed = ''"), link: '/events' },
        { label: 'without an incident', value: await n("SELECT count(*) AS n FROM alerts WHERE status = 'open' AND suppressed = '' AND incident_id IS NULL"), link: '/events' },
      ],
    });
  }
  if (moduleEnabled('incident') && readable('incident.read')) {
    nodes.push({
      id: 'incident', label: 'Incident', module: 'incident',
      purpose: 'Something is broken for someone. Restore service as quickly as possible – a known workaround is often the fastest way.',
      concepts: ['Impact × urgency = priority', 'SLA response and resolution targets', 'Major incidents need a problem'],
      hands_over: [{ to: 'problem', when: 'It recurs, it is major, or the cause is unknown' }, { to: 'known_error', when: 'A known error on its CI already has a workaround' }],
      counts: [
        { label: 'open', value: await n("SELECT count(*) AS n FROM incidents WHERE status NOT IN ('resolved', 'closed')"), link: '/incidents' },
        { label: 'recurring or major without a problem', value: await n("SELECT count(*) AS n FROM incidents WHERE problem_id IS NULL AND (reopen_count > 0 OR is_major) AND status <> 'closed'"), link: '/incidents?status=all' },
        ...(moduleEnabled('sla') ? [{ label: 'breaching or breached', value: await n("SELECT count(*) AS n FROM incidents WHERE status NOT IN ('resolved', 'closed') AND (resolution_breached_at IS NOT NULL OR resolution_due_at < now() + interval '1 hour')"), link: '/incidents?breaching_within=60' }] : []),
      ],
    });
  }
  nodes.push({
    id: 'problem', label: 'Problem', module: null,
    purpose: 'The underlying cause of one or more incidents. Find the root cause, and a workaround meanwhile.',
    concepts: ['Reactive (from incidents) or proactive (from trends)', 'Root cause analysis: 5 Whys, Ishikawa, Kepner-Tregoe, timeline'],
    hands_over: [{ to: 'known_error', when: 'The root cause is documented' }],
    counts: [
      { label: 'new', value: await n("SELECT count(*) AS n FROM problems WHERE status = 'new'"), link: '/problems?status=new' },
      { label: 'under analysis', value: await n("SELECT count(*) AS n FROM problems WHERE status = 'analysis'"), link: '/problems?status=analysis' },
      { label: 'problem candidates', value: await n("SELECT count(DISTINCT coalesce(ci_id::text, service)) AS n FROM external_records WHERE problem_id IS NULL AND NOT dismissed AND occurred_at > now() - interval '7 days'"), link: '/candidates' },
    ],
  });
  nodes.push({
    id: 'known_error', label: 'Known error', module: null,
    purpose: 'The cause is known. Keep the workaround working, weigh the risk against the cost of a fix, and decide: fix, accept or defer.',
    concepts: ['Known error database', 'Workaround effectiveness', 'Error control decision'],
    hands_over: [{ to: 'change', when: 'The decision is to fix it' }, { to: 'resolution', when: 'The fix is already in place' }],
    counts: [
      { label: 'known errors', value: await n("SELECT count(*) AS n FROM problems WHERE status = 'known_error'"), link: '/kedb' },
      { label: 'awaiting a decision', value: await n("SELECT count(*) AS n FROM problems WHERE status = 'known_error' AND coalesce(ec_decision, 'pending') = 'pending'"), link: '/review' },
      ...(moduleEnabled('change')
        ? [{ label: 'to fix, without a change', value: await n("SELECT count(*) AS n FROM problems p WHERE status = 'known_error' AND ec_decision = 'fix' AND NOT EXISTS (SELECT 1 FROM changes c WHERE c.problem_id = p.id)"), link: '/kedb' }]
        : []),
    ],
  });
  if (moduleEnabled('change') && readable('change.read')) {
    nodes.push({
      id: 'change', label: 'Change', module: 'change',
      purpose: 'Implement the fix safely: assess the risk, authorise, schedule without collisions or freezes, and review.',
      concepts: ['Standard, normal and emergency changes', 'Change authority', 'Backout plan'],
      hands_over: [{ to: 'resolution', when: 'The change succeeded' }, { to: 'incident', when: 'Incidents follow it (possibly change-related)' }],
      counts: [
        { label: 'waiting for authorisation', value: await n("SELECT count(*) AS n FROM changes WHERE status = 'authorize'"), link: '/changes?status=authorize' },
        { label: 'scheduled', value: await n("SELECT count(*) AS n FROM changes WHERE status = 'scheduled'"), link: '/changes?tab=schedule' },
        { label: 'in implementation or review', value: await n("SELECT count(*) AS n FROM changes WHERE status IN ('implementing', 'review')"), link: '/changes' },
      ],
    });
  }
  nodes.push({
    id: 'resolution', label: 'Resolved', module: null,
    purpose: 'The permanent fix is in place. Verify that the incidents stopped, then close – and learn from major problems.',
    concepts: ['Verify before closing', 'Major problem review', 'Continual improvement'],
    hands_over: [{ to: 'problem', when: 'It recurs: reopen the analysis' }],
    counts: [{ label: 'resolved, awaiting verification', value: await n("SELECT count(*) AS n FROM problems WHERE status = 'resolved'"), link: '/problems?status=resolved' }],
  });
  return {
    nodes,
    supporting: [
      ...(moduleEnabled('cmdb') ? [{ id: 'cmdb', label: 'CMDB', purpose: 'What is affected: CIs, services and how they depend on each other. Every practice uses it for impact.', link: '/cis' }] : []),
      ...(moduleEnabled('sla') ? [{ id: 'sla', label: 'Service levels', purpose: 'The targets incidents are measured against, in business hours.', link: '/services' }] : []),
    ],
  };
}

/** Gentle, dismissible coaching: things worth a look this week, never blocking anyone. */
export async function healthTips(user: User) {
  const tips: { id: string; text: string; count: number; link: string }[] = [];
  const add = (id: string, count: number, text: string, link: string) => count > 0 && tips.push({ id, count, text, link });
  add('ke_no_decision', await n("SELECT count(*) AS n FROM problems WHERE status = 'known_error' AND coalesce(ec_decision, 'pending') = 'pending' AND known_error_at < now() - interval '14 days'"),
    'known errors have waited more than two weeks for a fix/accept/defer decision.', '/review');
  add('no_owner', await n("SELECT count(*) AS n FROM problems WHERE assignee_id IS NULL AND status IN ('new', 'analysis')"), 'open problems have no owner.', '/problems?assignee=none');
  add('overdue_actions', await n("SELECT count(*) AS n FROM problem_actions WHERE status = 'open' AND due_date < current_date"), 'follow-up actions are overdue.', '/actions');
  if (moduleEnabled('incident') && can(user.role, 'incident.read')) {
    add('incident_no_category', await n("SELECT count(*) AS n FROM incidents WHERE category_id IS NULL AND status NOT IN ('resolved', 'closed')"), 'open incidents have no category, which hides them from trend reports.', '/incidents');
    if (moduleEnabled('cmdb')) add('p1_no_ci', await n("SELECT count(*) AS n FROM incidents i WHERE priority <= 2 AND status NOT IN ('resolved', 'closed') AND NOT EXISTS (SELECT 1 FROM incident_cis x WHERE x.incident_id = i.id)"), 'P1/P2 incidents have no CI: linking one shows impact and known workarounds.', '/incidents?priority=1');
  }
  if (moduleEnabled('cmdb') && can(user.role, 'ci.read')) {
    add('ci_not_seen', await n("SELECT count(DISTINCT ci_id) AS n FROM ci_sources s JOIN configuration_items c ON c.id = s.ci_id WHERE c.status = 'active' AND s.last_seen_at < now() - interval '30 days'"), 'active CIs have not been seen by their source for 30 days – retired, or a broken sync?', '/cis');
  }
  return tips;
}
