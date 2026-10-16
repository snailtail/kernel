// Method guides: one source for how each investigation or process flow is done. Shown in the UI (guided mode),
// served as MCP resources (kernel://guides/<id>) and used by the MCP prompts, so people and agents follow one method.

export interface MethodGuide {
  id: string;
  title: string;
  purpose: string;
  when: string;
  steps: string[];
  stop: string;
  pitfalls: string[];
  example?: { good: string; bad: string };
  /** The analysis technique this guide belongs to, if any. */
  technique?: 'five_whys' | 'ishikawa' | 'kepner_tregoe' | 'timeline';
}

export const GUIDES: MethodGuide[] = [
  {
    id: 'five_whys',
    technique: 'five_whys',
    title: '5 Whys',
    purpose: 'Follow one causal chain from the symptom to a cause that, if removed, prevents recurrence.',
    when: 'A fairly linear problem with one dominant chain of events. Use Ishikawa or Kepner-Tregoe when there are many possible causes.',
    steps: [
      'Write a precise problem statement: what goes wrong, where, when and how much – not a guess at the cause.',
      'Ask "why?" and answer with a fact. Record the evidence (log line, metric, change ref) for each answer, or mark it as an assumption to verify.',
      'Repeat on the answer, not on the original problem. Usually 4–6 steps.',
      'When an answer splits into several causes, follow the most important one and note the others as separate analyses.',
      'Stop at a cause that is within your control and whose removal prevents recurrence (often a process or design gap, not a person).',
      'Write the conclusion, then update the root cause and add follow-up actions for the fix and for unverified assumptions.',
    ],
    stop: 'The last cause is within our control, removing it would prevent recurrence, and every step is backed by evidence or marked as an assumption.',
    pitfalls: [
      'Stopping at a symptom ("the server was slow") or at human error ("the operator made a mistake") instead of why the system allowed it.',
      'Answers based on opinion without evidence.',
      'Jumping between chains, or answering the original question again instead of the previous answer.',
    ],
    example: {
      good: 'Why did orders time out? → The connection pool was exhausted (pool metrics at 100%, 11:02–12:40).',
      bad: 'Why did orders time out? → The database is bad.',
    },
  },
  {
    id: 'ishikawa',
    technique: 'ishikawa',
    title: 'Ishikawa (fishbone)',
    purpose: 'Map all possible contributing causes in categories before choosing which to investigate.',
    when: 'Several factors may contribute, or the team needs to see the whole picture before narrowing down.',
    steps: [
      'Put the effect (the problem statement) at the head of the fish.',
      'Go through each category – People, Process, Technology, Supplier, Environment, Measurement – and brainstorm possible causes. Write "none" when a category was considered and nothing applies.',
      'For each cause, note what evidence supports or rules it out.',
      'Mark the most likely causes and investigate them, for example with 5 Whys or a timeline.',
      'Conclude which causes contributed, and record the root cause and actions.',
    ],
    stop: 'All categories have been considered, the likely causes are supported by evidence, and the conclusion names the contributing causes.',
    pitfalls: ['Only filling in the category you already suspect.', 'Listing causes without checking them against evidence.', 'Treating the diagram as the result instead of the starting point for verification.'],
  },
  {
    id: 'kepner_tregoe',
    technique: 'kepner_tregoe',
    title: 'Kepner-Tregoe problem analysis',
    purpose: 'Find the cause by comparing what IS affected with what could be but IS NOT, and testing causes against both.',
    when: 'The problem is precise but puzzling: it affects some systems, times or users and not others.',
    steps: [
      'State the problem as object + deviation (e.g. "Order API returns 504").',
      'For WHAT, WHERE, WHEN and EXTENT, describe what IS affected and what could be but IS NOT.',
      'Note the distinctions between the IS and IS NOT sides, and the changes related to those distinctions.',
      'Derive possible causes from the distinctions and changes.',
      'Test each possible cause: does it explain both the IS and the IS NOT? Mark it explains / does not explain.',
      'The most probable cause is the one that explains everything with the fewest assumptions. Verify it before acting.',
    ],
    stop: 'Every dimension has IS and IS NOT filled in, every possible cause is tested, and one cause explains all of it.',
    pitfalls: ['Leaving IS NOT empty – the comparison is where the insight comes from.', 'Testing causes only against the IS side.', 'Accepting a cause that needs many extra assumptions.'],
  },
  {
    id: 'timeline',
    technique: 'timeline',
    title: 'Timeline',
    purpose: 'Line up what happened and what changed, to find what preceded the problem.',
    when: 'Outages and regressions, and as input to every major problem review.',
    steps: [
      'Collect the linked incidents and events with their times.',
      'Add changes and deployments around that time (change records, deploy logs, PRs).',
      'Add alerts and observations from monitoring, and the actions taken during the incident.',
      'Order by time and look for the last change before the first symptom.',
      'Conclude what triggered the problem, and what slowed detection or recovery.',
    ],
    stop: 'The events from first change to recovery are on the timeline with sources, and the trigger is identified.',
    pitfalls: ['Only recording the incident, not what changed before it.', 'Mixing time zones.', 'Missing the detection and recovery steps, which are where improvements often are.'],
  },
  {
    id: 'error_control',
    title: 'Error control (assessing a known error)',
    purpose: 'Decide what to do with a known error: fix it permanently, accept the risk, or defer – based on risk and cost.',
    when: 'A problem has been analysed and raised as a known error.',
    steps: [
      'Make sure the workaround is documented so the service desk can restore service.',
      'Assess the risk of not fixing: how often it recurs, how many are affected, the cost of applying the workaround.',
      'Assess the cost and risk of a permanent fix: effort, vendor dependency, change risk.',
      'Review how well the workaround works.',
      'Propose a decision. Accepting or deferring the risk is decided by a problem manager, with a review date.',
    ],
    stop: 'Risk, cost of fixing and workaround effectiveness are recorded, and a problem manager has decided.',
    pitfalls: ['Fixing everything regardless of value.', 'Accepting risk silently without a review date.', 'Letting a poor workaround become permanent.'],
  },
  {
    id: 'triage',
    title: 'Triage of a new problem',
    purpose: 'Confirm a newly logged problem is real, unique and correctly prioritised, and give it an owner.',
    when: 'Every new problem, ideally within a working day.',
    steps: [
      'Read the description and linked records. Ask for missing facts.',
      'Search for duplicates and known errors with the key symptoms.',
      'Check impact and urgency against the evidence; set category and affected service.',
      'Assign an owner and decide the first analysis step.',
    ],
    stop: 'The problem is unique, prioritised, categorised and owned, and analysis can start.',
    pitfalls: ['Logging duplicates instead of linking incidents to the existing problem.', 'Priority set by whoever shouts loudest instead of impact × urgency.'],
  },
  {
    id: 'major_problem_review',
    title: 'Major problem review',
    purpose: 'Learn from a major problem: what happened, why, what went well, what to improve and how recurrence is prevented.',
    when: 'Before closing a major problem.',
    steps: [
      'Summarise what happened and the business impact.',
      'Build or reuse the timeline.',
      'State the root cause and the permanent fix.',
      'Discuss what went well and what could be improved (detection, response, communication, the fix).',
      'Agree follow-up actions with owners and due dates.',
    ],
    stop: 'The review is written, shared, and every improvement has an owned action.',
    pitfalls: ['Blaming people instead of improving the system.', 'Improvements without owners or dates.'],
  },
  {
    id: 'verify_resolution',
    title: 'Verifying a resolution',
    purpose: 'Check that the fix worked before closing: the incidents and events stopped.',
    when: 'After a problem is resolved and before it is closed.',
    steps: [
      'Note when the fix was implemented (the linked change).',
      'Compare linked incidents and events before and after the fix.',
      'Check monitoring for the original symptom over a representative period.',
      'Close when the problem has not recurred; otherwise reopen analysis.',
    ],
    stop: 'No recurrence over a representative period after the fix.',
    pitfalls: ['Closing the day the change is deployed.', 'Looking only at incidents when the symptom shows in monitoring first.'],
  },
  {
    id: 'review_candidates',
    title: 'Reviewing problem candidates',
    purpose: 'Proactive problem management: decide for each candidate (found by a rule or reported by external analysis) whether it is a problem.',
    when: 'Regularly, e.g. weekly, or before the problem review meeting.',
    steps: [
      'Go through the candidates; each says which rule found it, why, and the evidence (records, CIs).',
      'For each, look for an existing problem or known error that explains them.',
      'Propose: link to an existing problem, log a new problem (prefilled from the evidence), or dismiss or snooze it with the reason.',
    ],
    stop: 'Every candidate has been linked, logged or dismissed.',
    pitfalls: ['Logging a new problem when an existing one already covers the symptoms.', 'Dismissing without a reason.'],
  },
  {
    id: 'problem_review_board',
    title: 'Problem review meeting',
    purpose: 'Keep the backlog healthy: triage, decisions, stale problems, overdue actions.',
    when: 'A regular meeting with problem managers and stakeholders.',
    steps: [
      'Prepare the agenda: new problems, unowned, major, known errors awaiting decisions or review, stale, resolved awaiting closure, overdue actions.',
      'For each item agree the next step and owner.',
      'Record decisions as notes and actions on the problems.',
    ],
    stop: 'Every agenda item has a decision or an owner with a next step.',
    pitfalls: ['Status updates instead of decisions.', 'Items that come back every meeting without progress.'],
  },
];

GUIDES.push({
  id: 'impact_analysis',
  title: 'Impact analysis',
  purpose: 'Find what is affected when a CI or service fails, and what it depends on, so priority and risk rest on facts.',
  when: 'Triaging a problem or incident, assessing a known error, or planning a change on a CI.',
  steps: [
    'Identify the CI or service that is failing or will be changed (search the CMDB by name, IP or FQDN).',
    'Walk upwards: what depends on it, up to the business services. Note the most critical service affected.',
    'Walk downwards from the affected service: what else could cause the same symptom? Those are candidate causes.',
    'Check the result is complete: a truncated or depth-limited walk, or a CI without relationships, means the picture may be missing parts.',
    'Use the affected services and their criticality for impact and priority, and record the reasoning on the record.',
  ],
  stop: 'The affected services are known with their criticality, gaps in the CMDB data are noted, and the priority reflects them.',
  pitfalls: [
    'Trusting the CMDB as complete: discovered data has gaps and stale relationships (check last seen).',
    'Treating every dependent as equally affected: redundancy (clusters, replicas) may absorb a failure.',
    'Forgetting manual relationships that no connector knows about.',
  ],
});

GUIDES.push({
  id: 'incident_triage',
  title: 'Incident triage',
  purpose: 'Restore service as quickly as possible: know what is affected, use known workarounds, prioritise and assign.',
  when: 'Every new incident.',
  steps: [
    'Confirm the symptom and who is affected; record the affected CIs or services.',
    'Look for a known error on those CIs: its workaround is often the fastest way to restore service.',
    'Set impact and urgency from the affected services; priority follows.',
    'Assign it to a person or group that can restore service.',
    'For a major incident: declare it, communicate regularly, and log a problem to find the root cause.',
    'Resolve with how service was restored and a resolution code; link recurring incidents to a problem.',
  ],
  stop: 'Service is restored, the resolution is recorded, and anything recurring or major is handed over to problem management.',
  pitfalls: [
    'Investigating the root cause while users wait: restore first, analyse in problem management.',
    'Closing a recurring incident again without a problem record.',
    'Leaving affected CIs empty, which hides known errors and impact.',
  ],
});

GUIDES.push(
  {
    id: 'change_assessment',
    title: 'Assessing and authorising a change',
    purpose: 'Make changes succeed: understand what they touch, how risky they are, how to undo them, and when to do them.',
    when: 'Every normal or emergency change; standard changes were assessed once, in their template.',
    steps: [
      'Record the CIs and services the change touches; Kernel derives the risk from the most critical service behind them.',
      'Write the implementation plan, how to test it, and the backout plan – how to undo it if it goes wrong.',
      'Choose a window outside freezes and without collisions on the same CIs; check the schedule.',
      'Submit for authorisation; the change authority approves (one approval, two for high risk), never the requester.',
      'Implement, record the outcome, and review: what went well, what to improve – required after a failure or an emergency change.',
    ],
    stop: 'The change is implemented with a recorded outcome, and reviewed when it failed or was an emergency.',
    pitfalls: ['No backout plan.', 'Changing the window after approval without re-authorising.', 'Emergency changes for work that could have been planned.'],
  },
  {
    id: 'handling_alerts',
    title: 'Handling alerts from monitoring',
    purpose: 'Turn monitoring noise into action: the alerts that matter become incidents; the ones that keep coming back become problems.',
    when: 'When alerts arrive in the event console, or when setting up event rules.',
    steps: [
      'Map alerts to CIs: by source id, host name, FQDN or IP – unmapped alerts lose impact and known workarounds.',
      'Write few, clear rules: what opens an incident (severity, environment, criticality), grouped per service so a storm becomes one incident.',
      'Schedule maintenance windows so planned work does not page anyone.',
      'Acknowledge what you look at; let clears close alerts and auto-resolve incidents after a hold-down.',
      'Review alerts that never became incidents but keep recurring: they are problem candidates.',
    ],
    stop: 'Important alerts open incidents once, noise is suppressed or tuned, and recurring alerts are reviewed as problem candidates.',
    pitfalls: ['A rule per alert type instead of grouping by service.', 'Ignoring flapping checks – they are problems waiting to happen.'],
  },
);

export const guideById = (id: string) => GUIDES.find((g) => g.id === id);

export function guideMarkdown(g: MethodGuide) {
  return [
    `# ${g.title}`,
    '',
    g.purpose,
    '',
    `**When to use:** ${g.when}`,
    '',
    '## Steps',
    ...g.steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    `**Done when:** ${g.stop}`,
    '',
    '## Pitfalls',
    ...g.pitfalls.map((p) => `- ${p}`),
    ...(g.example ? ['', '## Example', `- Good: ${g.example.good}`, `- Bad: ${g.example.bad}`] : []),
  ].join('\n');
}
