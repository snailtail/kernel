/** ITIL 4 terms in plain words, with Kernel examples (#37). Linked wherever the terms appear. */
export const GLOSSARY: Record<string, { term: string; text: string }> = {
  event: { term: 'Event', text: 'Something monitoring noticed: a check failed or a threshold was crossed. Most events need no one; some become incidents.' },
  incident: { term: 'Incident', text: 'An unplanned interruption or reduced quality of a service. The goal is to restore service quickly, not to find the cause.' },
  problem: { term: 'Problem', text: 'The cause, or potential cause, of one or more incidents. Problem management finds and removes causes.' },
  known_error: { term: 'Known error', text: 'A problem whose cause is known but not yet removed. It usually has a workaround and waits for a decision: fix, accept or defer.' },
  workaround: { term: 'Workaround', text: 'A way to reduce or remove the impact while the cause remains, e.g. "restart the service". Shown on incidents for the same CI.' },
  root_cause: { term: 'Root cause', text: 'The underlying cause that, if removed, stops the problem from recurring – often a process or design gap, not a person.' },
  change: { term: 'Change', text: 'Adding, modifying or removing anything that could affect services. Assessed, authorised and scheduled to make it succeed.' },
  standard_change: { term: 'Standard change', text: 'A low-risk, repeatable change from a pre-approved template, e.g. a routine deployment. No authorisation needed each time.' },
  emergency_change: { term: 'Emergency change', text: 'A change that cannot wait for normal scheduling, e.g. to stop an outage. Still approved, and always reviewed afterwards.' },
  impact: { term: 'Impact', text: 'How much harm it causes: how many users, which services, what it costs. Together with urgency it gives the priority.' },
  urgency: { term: 'Urgency', text: 'How quickly it must be dealt with. A high-impact issue can have low urgency if a workaround holds.' },
  priority: { term: 'Priority', text: 'Impact × urgency, from P1 (critical) to P5 (planning). It decides what is worked on first.' },
  ci: { term: 'Configuration item (CI)', text: 'Something we operate and want to track: a server, a database, an application. CIs are pointers to where they really live.' },
  service: { term: 'Service', text: 'What users actually get, e.g. "Webshop". Built from CIs; the CMDB shows which services a failing CI affects.' },
  criticality: { term: 'Criticality', text: 'How important a CI or service is, 1 (business critical) to 4 (low). It drives risk, impact hints and SLA choice.' },
  sla: { term: 'SLA', text: 'Service level agreement: the response and resolution targets incidents are measured against, in business hours.' },
  risk: { term: 'Risk', text: 'For a change: how much could go wrong, from the most critical service it touches. High risk needs two approvals.' },
  major: { term: 'Major incident / problem', text: 'One with severe business impact. Major incidents get stakeholder communication; major problems a review before closing.' },
};

/**
 * A term with its plain-language explanation on hover and keyboard focus. Not a link: terms sit inside form labels,
 * where clicking must focus the field. The full glossary is on the guide page.
 */
export function Term({ id, children }: { id: keyof typeof GLOSSARY; children?: React.ReactNode }) {
  const g = GLOSSARY[id];
  return (
    <span className="term" title={g.text} tabIndex={0} aria-label={`${g.term}: ${g.text}`}>
      {children ?? g.term}
    </span>
  );
}

export function GlossaryList() {
  return (
    <dl className="glossary">
      {Object.entries(GLOSSARY).map(([id, g]) => (
        <div key={id} id={`term-${id}`}>
          <dt>{g.term}</dt>
          <dd>{g.text}</dd>
        </div>
      ))}
    </dl>
  );
}
