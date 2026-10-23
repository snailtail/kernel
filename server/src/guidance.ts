// Process guidance: what the current phase is for and which steps remain, derived from the record itself.
// Shown in the UI in guided mode and returned to MCP clients as next_steps.
import { moduleEnabled } from './modules.js';

interface GuidanceInput {
  status: string;
  description: string;
  detection: string;
  category_id: number | null;
  affected_service: string;
  affected_cis?: unknown[];
  assignee_id: number | null;
  is_major: boolean;
  root_cause: string;
  workaround: string;
  resolution: string;
  major_review: string;
  ec_risk_level: number | null;
  ec_decision: string | null;
  ec_review_date: string | null;
  workaround_effectiveness: string | null;
  links: { kind: string }[];
  actions: { status: string }[];
  analyses: unknown[];
  activity: { kind: string }[];
}

interface Step {
  id: string;
  label: string;
  hint: string;
  /** null for advice that cannot be checked from the record */
  done: boolean | null;
}

/** The hand-over to the next practice in the flow (#37), e.g. a known error ready for a change. */
interface Handover {
  label: string;
  hint: string;
  /** What the button does; absent for advice only. */
  action?: 'raise_change' | 'create_problem' | 'link_problem' | 'resolve_problem';
  /** The record the action concerns, e.g. the problem to link to. */
  target?: string;
}

export interface Guidance {
  phase: string;
  purpose: string;
  steps: Step[];
  next: string;
  handover?: Handover | null;
}

const has = (s: string) => s.trim().length > 0;

export function guidanceFor(p: GuidanceInput): Guidance {
  const g = phaseGuidance(p);
  return { ...g, handover: handoverFor(p) };
}

/** Where the problem hands over to another practice, given which modules are on. */
function handoverFor(p: GuidanceInput): Handover | null {
  const changes = p.links.filter((l) => l.kind === 'change').length;
  if (p.status === 'known_error' && p.ec_decision === 'fix' && changes === 0 && moduleEnabled('change')) {
    return { label: 'Ready to fix? Raise a change', hint: 'The permanent fix is implemented through a change; it is prefilled from the root cause and the affected CIs.', action: 'raise_change' };
  }
  if (p.status === 'resolved') {
    return { label: 'Verify that the incidents stopped', hint: 'Compare linked incidents and events before and after the fix before closing.' };
  }
  return null;
}

function phaseGuidance(p: GuidanceInput): Guidance {
  const count = (kind: string) => p.links.filter((l) => l.kind === kind).length;
  const openActions = p.actions.filter((a) => a.status === 'open').length;
  const triggerKind = p.detection === 'proactive' ? 'event' : 'incident';

  switch (p.status) {
    case 'new':
      return {
        phase: 'Problem identification',
        purpose: 'Recognise and record the problem so it can be managed: what is happening, how it shows itself, and why it matters.',
        steps: [
          { id: 'describe', label: 'Describe symptoms, scope and business impact', hint: 'Who is affected, how often, and what it costs. Facts, not guesses.', done: has(p.description) },
          {
            id: 'link',
            label: p.detection === 'proactive' ? 'Link the events or trend data that revealed it' : 'Link the incidents that revealed it',
            hint: 'Linked records show the impact and help confirm the fix later.',
            done: count(triggerKind) + count('incident') + count('event') > 0,
          },
          { id: 'categorise', label: 'Set category and affected CIs or service', hint: 'Needed for trend analysis, impact and finding related problems. Link the CIs and services from the CMDB when you can.', done: p.category_id !== null && (has(p.affected_service) || (p.affected_cis?.length ?? 0) > 0) },
          { id: 'owner', label: 'Assign an owner', hint: 'One person accountable for driving the analysis.', done: p.assignee_id !== null },
          { id: 'duplicates', label: 'Check for duplicates and known errors', hint: 'Search existing problems and the known error database before investing in analysis.', done: null },
        ],
        next: 'When the problem is understood well enough to investigate, start analysis.',
      };
    case 'analysis':
      return {
        phase: 'Problem control',
        purpose: 'Analyse the problem to find its root cause, and document workarounds that reduce the impact meanwhile.',
        steps: [
          {
            id: 'analyse',
            label: 'Analyse the cause',
            hint: 'Use a structured technique (5 Whys, Ishikawa, Kepner-Tregoe, timeline) and record findings as work notes.',
            done: p.analyses.length > 0 || p.activity.some((a) => a.kind === 'comment'),
          },
          { id: 'workaround', label: 'Document a workaround, if one exists', hint: 'A workaround can be documented at any stage, it does not have to wait for the root cause.', done: has(p.workaround) ? true : null },
          { id: 'root_cause', label: 'Document the root cause', hint: 'The underlying cause that, if removed, prevents recurrence.', done: has(p.root_cause) },
        ],
        next: has(p.root_cause)
          ? 'The root cause is documented: raise it as a known error, or resolve it directly if the fix is already in place.'
          : 'Keep analysing until the root cause is documented.',
      };
    case 'known_error': {
      const decided = (p.ec_decision ?? 'pending') !== 'pending';
      const steps: Step[] = [
        { id: 'workaround', label: 'Document the workaround', hint: 'So the service desk can restore service quickly; it appears in the known error database.', done: has(p.workaround) },
        { id: 'assess', label: 'Assess the risk of not fixing', hint: 'Impact if it recurs, how often, and the cost of living with the workaround.', done: p.ec_risk_level !== null },
        { id: 'effectiveness', label: 'Review how well the workaround works', hint: 'Re-assess it periodically; an ineffective workaround raises the priority of a fix.', done: p.workaround_effectiveness !== null },
        { id: 'decide', label: 'Decide: fix, accept the risk, or defer', hint: 'A permanent fix is not always worth it. Accepting the risk is a decision for the problem manager.', done: decided },
      ];
      if (p.ec_decision === 'fix') {
        steps.push({ id: 'plan', label: 'Plan the fix', hint: 'Link the change that implements it, and track remaining work as actions.', done: count('change') > 0 || p.actions.length > 0 });
      }
      if (p.ec_decision === 'accept' || p.ec_decision === 'defer') {
        steps.push({ id: 'review_date', label: 'Set a date to review the decision', hint: 'Accepted risks should be reconsidered as circumstances change.', done: p.ec_review_date !== null });
      }
      return {
        phase: 'Error control',
        purpose: 'Manage the known error: keep the workaround effective, weigh the risk against the cost of a fix, and decide what to do.',
        steps,
        next:
          p.ec_decision === 'accept'
            ? 'The risk is accepted: close the problem with closure code "No fix – risk accepted", or keep it open until the review date.'
            : 'When the permanent fix is in place, resolve the problem and document the resolution.',
      };
    }
    case 'resolved':
      return {
        phase: 'Resolution',
        purpose: 'The permanent fix is in place. Verify that it worked before closing the record.',
        steps: [
          { id: 'resolution', label: 'Document the resolution', hint: 'What was changed, and how it removes the root cause.', done: has(p.resolution) },
          { id: 'change', label: 'Link the change that implemented the fix', hint: 'Keeps the audit trail from problem to change.', done: count('change') > 0 },
          { id: 'verify', label: 'Verify that the problem does not recur', hint: 'Watch for new incidents or events before closing.', done: null },
          { id: 'actions', label: 'Complete or cancel follow-up actions', hint: 'Open actions block a clean closure.', done: openActions === 0 },
          ...(p.is_major
            ? [{ id: 'review', label: 'Hold the major problem review', hint: 'What went well, what to improve, how to prevent recurrence.', done: has(p.major_review) }]
            : []),
        ],
        next: 'When the fix is verified, a problem manager closes the problem with a closure code.',
      };
    default:
      return {
        phase: 'Closed',
        purpose: 'The problem record is closed. If the problem recurs, a problem manager can reopen it.',
        steps: [],
        next: 'Nothing left to do.',
      };
  }
}
