// The big picture (#37): the process map event → incident → problem → known error → change → resolution, with live
// counts from the user's own data, and gentle health tips. Only practices whose module is on, and only what the
// caller may read, are included – for people in the UI and for agents over MCP.
import { REVIEW_GUIDE } from './reviews.js';
import type { User } from './auth.js';
import { query } from './db.js';
import { moduleEnabled, type Module } from './modules.js';
import { can, type Action } from './policy.js';
import { listCandidates, RULES } from './candidates.js';

interface Count { label: string; value: number; link: string }
interface Node {
  id: string;
  label: string;
  module: Module | null;
  purpose: string;
  concepts: string[];
  hands_over: { to: string; when: string }[];
  counts: Count[];
  /** How problems are found (#31): each candidate rule that is on, with its open candidates. */
  found_by?: { rule: string; label: string; proactive: boolean; count: number; link: string }[];
}

/** All counts in one round trip (each is a small indexed count). */
// TODO(#53): when access scoping arrives, these counts must be limited to what the viewer may read.
const COUNTS_SQL = `SELECT (SELECT count(*) FROM configuration_items WHERE status = 'missing')::int AS cmissing,
    (SELECT count(*) FROM ci_retire_due WHERE proposed_at <= now())::int AS cretire,
    (SELECT count(*) FROM alerts WHERE status = 'open' AND suppressed = '')::int AS c0,
    (SELECT count(*) FROM alerts WHERE status = 'open' AND suppressed = '' AND incident_id IS NULL)::int AS c1,
    (SELECT count(*) FROM incidents WHERE status NOT IN ('resolved', 'closed'))::int AS c2,
    (SELECT count(*) FROM incidents WHERE problem_id IS NULL AND (reopen_count > 0 OR is_major) AND status <> 'closed')::int AS c3,
    (SELECT count(*) FROM incidents WHERE status NOT IN ('resolved', 'closed') AND (resolution_breached_at IS NOT NULL OR resolution_due_at < now() + interval '1 hour'))::int AS c4,
    (SELECT count(*) FROM problems WHERE status = 'new')::int AS c5,
    (SELECT count(*) FROM problems WHERE status = 'analysis')::int AS c6,
    (SELECT count(*) FROM problems WHERE status = 'known_error')::int AS c8,
    (SELECT count(*) FROM problems WHERE status = 'known_error' AND coalesce(ec_decision, 'pending') = 'pending')::int AS c9,
    (SELECT count(*) FROM problems p WHERE status = 'known_error' AND ec_decision = 'fix' AND NOT EXISTS (SELECT 1 FROM changes c WHERE c.problem_id = p.id))::int AS c10,
    (SELECT count(*) FROM changes WHERE status = 'authorize')::int AS c11,
    (SELECT count(*) FROM changes WHERE status = 'scheduled')::int AS c12,
    (SELECT count(*) FROM changes WHERE status IN ('implementing', 'review'))::int AS c13,
    (SELECT count(*) FROM problems WHERE status = 'resolved')::int AS c14,
    (SELECT count(*) FROM problems WHERE status = 'known_error' AND coalesce(ec_decision, 'pending') = 'pending' AND known_error_at < now() - interval '14 days')::int AS c15,
    (SELECT count(*) FROM problems WHERE assignee_id IS NULL AND status IN ('new', 'analysis'))::int AS c16,
    (SELECT count(*) FROM actions WHERE status = 'open' AND due_date < current_date)::int AS c17,
    (SELECT count(*) FROM incidents WHERE category_id IS NULL AND status NOT IN ('resolved', 'closed'))::int AS c18,
    (SELECT count(*) FROM incidents i WHERE priority <= 2 AND status NOT IN ('resolved', 'closed') AND NOT EXISTS (SELECT 1 FROM incident_cis x WHERE x.incident_id = i.id))::int AS c19,
    (SELECT count(*) FROM incident_reviews WHERE status IN ('scheduled', 'draft'))::int AS c21,
    (SELECT count(*) FROM incident_reviews WHERE status IN ('scheduled', 'draft') AND due < current_date)::int AS c22,
    (SELECT count(*) FROM incidents i WHERE i.is_major AND i.status IN ('resolved', 'closed')
       AND NOT EXISTS (SELECT 1 FROM incident_reviews r WHERE r.incident_id = i.id AND r.status IN ('published', 'waived')))::int AS c23,
    (SELECT count(DISTINCT ci_id) FROM ci_sources s JOIN configuration_items c ON c.id = s.ci_id WHERE c.status = 'active' AND s.last_seen_at < now() - interval '30 days')::int AS c20`;
async function counts(): Promise<Record<string, number>> {
  return (await query(COUNTS_SQL)).rows[0];
}

export async function processMap(user: User) {
  const c = await counts();
  const found = await listCandidates();
  const candidates = found.candidates.length;
  const readable = (a: Action) => can(user.role, a);
  const nodes: Node[] = [];
  if (moduleEnabled('event') && readable('event.read')) {
    nodes.push({
      id: 'event', label: 'Event', module: 'event',
      purpose: 'Monitoring notices something: a check fails, a threshold is crossed. Most events need no one; some become incidents.',
      concepts: ['Alerts are deduplicated per CI and check', 'Rules open incidents', 'Maintenance suppresses alerts'],
      hands_over: [{ to: 'incident', when: 'An event rule matches, or someone opens an incident from an alert' }, { to: 'problem', when: 'Alerts recur, flap, rise, fill up or clear themselves (problem candidates)' }],
      counts: [
        { label: 'open alerts', value: c.c0, link: '/events' },
        { label: 'without an incident', value: c.c1, link: '/events' },
      ],
    });
  }
  if (moduleEnabled('incident') && readable('incident.read')) {
    nodes.push({
      id: 'incident', label: 'Incident', module: 'incident',
      purpose: 'Something is broken for someone. Restore service as quickly as possible – a known workaround is often the fastest way.',
      concepts: ['Impact × urgency = priority', 'SLA response and resolution targets', 'Major incidents need a problem'],
      hands_over: [
        { to: 'review', when: 'A major incident is resolved: it gets a post-incident review' },
        { to: 'problem', when: 'It recurs, it is major, or the cause is unknown' },
        { to: 'known_error', when: 'A known error on its CI already has a workaround' },
      ],
      counts: [
        { label: 'open', value: c.c2, link: '/incidents' },
        { label: 'recurring or major without a problem', value: c.c3, link: '/incidents?status=all' },
        ...(moduleEnabled('sla') ? [{ label: 'breaching or breached', value: c.c4, link: '/incidents?breaching_within=60' }] : []),
      ],
    });
  }
  if (moduleEnabled('incident') && readable('incident.read')) {
    nodes.push({
      id: 'review', label: 'Post-incident review', module: 'incident',
      purpose: `${REVIEW_GUIDE.purpose.split('. ')[0]}. It starts from the timeline and impact, and its contributing factors become problems.`,
      concepts: ['Blameless: actions and conditions, not people', 'Contributing factor → problem', 'Follow-up → action'],
      hands_over: [{ to: 'problem', when: 'A contributing factor needs its root cause found' }],
      counts: [
        { label: 'due', value: c.c21, link: '/incident-reviews' },
        { label: 'overdue', value: c.c22, link: '/incident-reviews' },
        { label: 'major incidents resolved, review not published or waived', value: c.c23, link: '/incident-reviews' },
      ],
    });
  }
  nodes.push({
    id: 'problem', label: 'Problem', module: null,
    purpose: 'The underlying cause of one or more incidents. Find the root cause, and a workaround meanwhile.',
    concepts: ['Reactive (from incidents) or proactive (from trends)', 'Root cause analysis: 5 Whys, Ishikawa, Kepner-Tregoe, timeline'],
    hands_over: [{ to: 'known_error', when: 'The root cause is documented' }],
    counts: [
      { label: 'new', value: c.c5, link: '/problems?status=new' },
      { label: 'under analysis', value: c.c6, link: '/problems?status=analysis' },
      { label: 'problem candidates', value: candidates, link: '/candidates' },
    ],
    found_by: found.rules.filter((r) => r.enabled).map((r) => ({ rule: r.rule, label: r.label, proactive: RULES[r.rule].proactive, count: r.count, link: `/candidates?rule=${r.rule}` })),
  });
  nodes.push({
    id: 'known_error', label: 'Known error', module: null,
    purpose: 'The cause is known. Keep the workaround working, weigh the risk against the cost of a fix, and decide: fix, accept or defer.',
    concepts: ['Known error database', 'Workaround effectiveness', 'Error control decision'],
    hands_over: [{ to: 'change', when: 'The decision is to fix it' }, { to: 'resolution', when: 'The fix is already in place' }],
    counts: [
      { label: 'known errors', value: c.c8, link: '/kedb' },
      { label: 'awaiting a decision', value: c.c9, link: '/review' },
      ...(moduleEnabled('change')
        ? [{ label: 'to fix, without a change', value: c.c10, link: '/kedb' }]
        : []),
    ],
  });
  if (moduleEnabled('change') && readable('change.read')) {
    nodes.push({
      id: 'change', label: 'Change', module: 'change',
      purpose: 'Implement the fix safely: assess the risk, authorise, schedule without collisions or freezes, and review.',
      concepts: ['Standard, normal and emergency changes', 'Change authority', 'Backout plan'],
      hands_over: [{ to: 'resolution', when: 'The change succeeded' }, { to: 'incident', when: 'Incidents follow it (possibly change-related)' }, { to: 'problem', when: 'Changes on a CI keep failing or are followed by incidents (problem candidates)' }],
      counts: [
        { label: 'waiting for authorisation', value: c.c11, link: '/changes?status=authorize' },
        { label: 'scheduled', value: c.c12, link: '/changes?tab=schedule' },
        { label: 'in implementation or review', value: c.c13, link: '/changes' },
      ],
    });
  }
  nodes.push({
    id: 'resolution', label: 'Resolved', module: null,
    purpose: 'The permanent fix is in place. Verify that the incidents stopped, then close – and learn from major problems.',
    concepts: ['Verify before closing', 'Major problem review', 'Continual improvement'],
    hands_over: [{ to: 'problem', when: 'It recurs: reopen the analysis' }],
    counts: [{ label: 'resolved, awaiting verification', value: c.c14, link: '/problems?status=resolved' }],
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
  const c = await counts();
  const tips: { id: string; text: string; count: number; link: string }[] = [];
  const add = (id: string, count: number, text: string, link: string) => count > 0 && tips.push({ id, count, text, link });
  add('ke_no_decision', c.c15,
    'known errors have waited more than two weeks for a fix/accept/defer decision.', '/review');
  add('no_owner', c.c16, 'open problems have no owner.', '/problems?assignee=none');
  add('overdue_actions', c.c17, 'follow-up actions are overdue.', '/actions');
  if (moduleEnabled('incident') && can(user.role, 'incident.read')) {
    add('incident_no_category', c.c18, 'open incidents have no category, which hides them from trend reports.', '/incidents');
    if (moduleEnabled('cmdb')) add('p1_no_ci', c.c19, 'P1/P2 incidents have no CI: linking one shows impact and known workarounds.', '/incidents?priority=1');
  }
  if (moduleEnabled('cmdb') && can(user.role, 'ci.read')) {
    add('ci_not_seen', c.c20, 'active CIs have not been seen by their source for 30 days – retired, or a broken sync?', '/cis');
    add('ci_missing', c.cmissing - c.cretire, 'CIs are missing from every source that reported them: a broken sync, or gone for good?', '/cis?status=missing');
    add('ci_retire', c.cretire, 'CIs have been missing long enough to be proposed for retirement: retire them, or fix the sync.', '/cis/retire');
  }
  return tips;
}
