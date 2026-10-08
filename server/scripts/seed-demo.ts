// Fills an empty Kernel database with realistic demo data: users, problems in every stage,
// linked incidents/events/changes, work notes and follow-up actions.
//
//   DATABASE_URL=postgres://... npx tsx scripts/seed-demo.ts
//
// Refuses to run if the database already contains problems. Demo users get the password "demo-password".
import { hashPassword, type User } from '../src/auth.js';
import { migrate, pool, query } from '../src/db.js';
import * as actions from '../src/actions.js';
import * as analyses from '../src/analyses.js';
import * as problems from '../src/problems.js';

await migrate(console.log);
if ((await query('SELECT count(*)::int AS n FROM problems')).rows[0].n > 0) {
  console.error('Database already has problems; refusing to add demo data.');
  process.exit(1);
}

const hash = await hashPassword('demo-password');
const people = [
  ['anna', 'Anna Lindqvist', 'problem_manager'],
  ['erik', 'Erik Johansson', 'analyst'],
  ['sara', 'Sara Ahmed', 'analyst'],
  ['jonas', 'Jonas Berg', 'analyst'],
  ['lena', 'Lena Holm', 'viewer'],
] as const;
const users: Record<string, User> = {};
for (const [username, name, role] of people) {
  const { rows } = await query(
    `INSERT INTO users (username, display_name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (username) DO UPDATE SET display_name = excluded.display_name RETURNING id, username, display_name, email, role, preferences`,
    [username, name, `${username}@example.com`, hash, role],
  );
  users[username] = rows[0];
}
const categories = Object.fromEntries((await query('SELECT id, name FROM categories')).rows.map((r) => [r.name, r.id]));
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

interface Demo {
  by: string;
  title: string;
  description: string;
  category: string;
  service: string;
  detection?: 'reactive' | 'proactive';
  impact: number;
  urgency: number;
  major?: boolean;
  assignee: string;
  ageDays: number;
  links?: [kind: 'incident' | 'event' | 'change' | 'problem', ref: string, system: string][];
  notes?: string[];
  rootCause?: string;
  workaround?: string;
  resolution?: string;
  review?: string;
  status: 'new' | 'analysis' | 'known_error' | 'resolved' | 'closed';
  closure?: 'resolved' | 'workaround_accepted' | 'duplicate' | 'cancelled' | 'no_fix';
  actions?: [title: string, owner: string, dueOffset: number | null, done?: boolean][];
  assessment?: Parameters<typeof problems.assessProblem>[2] & { reviewOffset?: number };
  analyses?: { technique: analyses.Technique; title?: string; data: unknown; conclusion?: string }[];
}

const demos: Demo[] = [
  {
    by: 'erik', title: 'Intermittent 504 timeouts in order API during peak hours', category: 'Application', service: 'Order API',
    description: 'Customers get 504 Gateway Timeout when placing orders between 11:00 and 13:00. Around 2% of requests fail. Started after the September release.',
    impact: 1, urgency: 2, assignee: 'erik', ageDays: 21, status: 'known_error',
    links: [['incident', 'INC0012345', 'ServiceNow'], ['incident', 'INC0012388', 'ServiceNow'], ['incident', 'INC0012410', 'ServiceNow'], ['change', 'CHG0004521', 'ServiceNow']],
    notes: ['Thread dumps show all workers waiting on the DB connection pool.', 'Pool size is 20 per pod; peak concurrency reaches 35.'],
    rootCause: 'The September release added a synchronous inventory lookup per order line, holding a database connection for the full request. Under peak load the connection pool (20 per pod) is exhausted and requests queue until the gateway times out.',
    workaround: 'Scale order-api to 8 pods before 10:45 on weekdays (runbook RB-112). Reduces failures to < 0.1%.',
    analyses: [
      {
        technique: 'five_whys', title: 'Why do orders time out?',
        data: { problem_statement: 'Order API returns 504 for ~2% of requests between 11:00 and 13:00', whys: [
          { why: 'Why do requests return 504?', because: 'The gateway times out waiting for order-api (30 s).' },
          { why: 'Why is order-api that slow?', because: 'Requests wait for a free database connection.' },
          { why: 'Why are no connections free?', because: 'Each request holds a connection during the inventory lookup per order line.' },
          { why: 'Why does it hold the connection that long?', because: 'The September release made the inventory lookup synchronous inside the DB transaction.' },
          { why: 'Why was that not caught before release?', because: 'Load tests use single-line orders; peak orders average 7 lines.' },
        ] },
        conclusion: 'Synchronous inventory lookup inside the DB transaction exhausts the connection pool at peak; load tests did not reflect real order sizes.',
      },
      {
        technique: 'ishikawa', title: 'Contributing factors',
        data: { effect: 'Order API 504 at peak', categories: [
          { name: 'People', causes: ['No review of DB usage in PR'] },
          { name: 'Process', causes: ['Load test profile outdated', 'No perf gate in pipeline'] },
          { name: 'Technology', causes: ['Sync inventory call', 'Pool size 20/pod', 'Gateway timeout 30 s'] },
          { name: 'Supplier', causes: [] },
          { name: 'Environment', causes: ['Lunch-time order peak', 'Campaign traffic'] },
          { name: 'Measurement', causes: ['No pool saturation alert'] },
        ] },
      },
    ],
    assessment: { ec_risk_level: 1, ec_risk: 'Lost orders at every peak; workaround costs ~4 extra pods per day.', ec_fix_cost: 'One sprint for the order team.', ec_decision: 'fix', workaround_effectiveness: 'effective' },
    actions: [['Make inventory lookup asynchronous', 'erik', 9], ['Raise pool size to 40 as interim measure', 'jonas', -2], ['Add alert on pool saturation > 80%', 'sara', 5, true]],
  },
  {
    by: 'anna', title: 'Nightly batch overruns into business hours', category: 'Infrastructure', service: 'Billing batch',
    description: 'The nightly billing batch has finished after 07:00 on 6 of the last 20 days, delaying invoice availability for customer service.',
    impact: 2, urgency: 2, assignee: 'jonas', ageDays: 12, status: 'analysis', detection: 'proactive',
    analyses: [{
      technique: 'kepner_tregoe', title: 'IS / IS NOT',
      data: {
        problem_statement: 'Billing batch finishes after 07:00',
        what: { is: 'Invoice generation step', is_not: 'Payment import, ledger export', distinction: 'Only step that renders PDFs' },
        where: { is: 'batch-02', is_not: 'batch-01 (same job, other customers)', distinction: 'batch-02 serves enterprise customers' },
        when: { is: 'Month end and Mondays', is_not: 'Mid-week', distinction: 'Large invoice volumes' },
        extent: { is: '6 of 20 nights, getting worse', is_not: '', distinction: 'Correlates with invoice lines' },
        changes: 'New invoice template with per-line tax breakdown (August).',
        possible_causes: [
          { cause: 'PDF rendering of the new template is slow per line', test: 'Explains batch-02 and month end; not mid-week', result: 'explains' },
          { cause: 'Storage latency on batch-02', test: 'Would affect payment import too', result: 'does_not_explain' },
        ],
      },
    }],
    links: [['event', 'ZBX-88213', 'Zabbix'], ['event', 'ZBX-88457', 'Zabbix']],
    notes: ['Runtime correlates with number of invoice lines, not with load on the cluster.'],
    actions: [['Collect runtime per batch step for 2 weeks', 'jonas', 3]],
  },
  {
    by: 'sara', title: 'SSO login fails after certificate rotation', category: 'Security', service: 'Identity provider',
    description: 'All SSO logins failed for 40 minutes after the quarterly certificate rotation.', impact: 1, urgency: 1, major: true,
    assignee: 'sara', ageDays: 30, status: 'resolved',
    links: [['incident', 'INC0011876', 'ServiceNow'], ['change', 'CHG0004390', 'ServiceNow'], ['change', 'CHG0004402', 'ServiceNow']],
    rootCause: 'Service providers cache the IdP signing certificate. The new certificate was activated before the metadata had been published, so assertions failed validation.',
    workaround: 'Roll back to the previous signing certificate.',
    resolution: 'Rotation procedure changed to publish metadata with both certificates 14 days before switching (CHG0004402).',
    analyses: [{
      technique: 'timeline', title: 'Outage timeline',
      data: { events: [
        { at: '2026-09-08T06:00', kind: 'change', description: 'Quarterly signing certificate rotation started', reference: 'CHG0004390' },
        { at: '2026-09-08T06:04', kind: 'alert', description: 'Login error rate > 50%', reference: 'ZBX-87711' },
        { at: '2026-09-08T06:10', kind: 'incident', description: 'Major incident: nobody can log in', reference: 'INC0011876' },
        { at: '2026-09-08T06:35', kind: 'observation', description: 'SPs reject assertions: unknown signing key' },
        { at: '2026-09-08T06:44', kind: 'change', description: 'Rolled back to previous certificate', reference: 'CHG0004390' },
      ] },
      conclusion: 'Service providers had cached the old metadata; the new certificate was activated before they had fetched it.',
    }],
    actions: [['Update certificate rotation runbook', 'sara', -5, true], ['Automate expiry monitoring for all SAML certificates', 'jonas', 20]],
  },
  {
    by: 'jonas', title: 'Disk usage on PostgreSQL cluster trending to full', category: 'Database', service: 'pg-prod', detection: 'proactive',
    description: 'Trend analysis shows the data volume on pg-prod reaching 95% within ~6 weeks.', impact: 2, urgency: 3,
    assignee: 'jonas', ageDays: 4, status: 'new', links: [['event', 'ZBX-90012', 'Zabbix']],
  },
  {
    by: 'erik', title: 'Mobile app crashes on startup for Android 15 users', category: 'Application', service: 'Customer app',
    description: 'Crash rate on Android 15 is 4.2% on startup since app version 5.8.', impact: 2, urgency: 1, assignee: 'erik', ageDays: 2, status: 'analysis',
    links: [['incident', 'INC0012501', 'ServiceNow'], ['incident', 'INC0012507', 'ServiceNow']],
    workaround: 'Users can clear app storage and log in again.',
  },
  {
    by: 'anna', title: 'VPN disconnects every 60 minutes for remote staff', category: 'Network', service: 'Remote access',
    description: 'Remote users are disconnected hourly and must re-authenticate.', impact: 3, urgency: 2, assignee: 'sara', ageDays: 45, status: 'known_error',
    links: [['incident', 'INC0010022', 'ServiceNow'], ['incident', 'INC0010231', 'ServiceNow']],
    rootCause: 'Session lifetime on the VPN concentrator is hard-coded to 3600 s in firmware 9.2. Vendor confirmed defect.',
    workaround: 'Install VPN client 7.4 which reconnects silently.',
    assessment: { ec_risk_level: 3, ec_risk: 'Annoyance for ~200 remote users; silent reconnect hides it.', ec_fix_cost: 'Firmware 10.x needs new hardware.', ec_decision: 'accept', ec_decision_note: 'Accept until hardware refresh in Q2.', workaround_effectiveness: 'effective', reviewOffset: 40 },
    actions: [['Follow up vendor case for firmware fix', 'anna', 14]],
  },
  {
    by: 'sara', title: 'Slow search in intranet after index migration', category: 'Application', service: 'Intranet',
    description: 'Search takes 8–12 s since the index migration.', impact: 3, urgency: 3, assignee: 'erik', ageDays: 60, status: 'closed', closure: 'resolved',
    rootCause: 'Analyzer configuration was not migrated, so every query ran as a wildcard scan.',
    resolution: 'Analyzer settings restored and index rebuilt.',
  },
  {
    by: 'jonas', title: 'Email notifications delayed up to two hours', category: 'Supplier', service: 'Notification service',
    description: 'Order confirmation emails arrive with a delay of up to two hours on Mondays.', impact: 2, urgency: 3, assignee: 'anna', ageDays: 95, status: 'known_error',
    links: [['incident', 'INC0009001', 'ServiceNow']],
    rootCause: 'The email provider throttles our account when the weekly newsletter is sent.',
    workaround: 'Send the newsletter from a separate sending domain.',
    assessment: { ec_risk_level: 2, ec_risk: 'Customers call customer service when confirmations are late.', workaround_effectiveness: 'partial', ec_decision: 'pending', reviewOffset: -3 },
    actions: [['Decide between dedicated IP and new provider', 'anna', -10]],
  },
  {
    by: 'erik', title: 'Duplicate invoices for customers with multiple accounts', category: 'Application', service: 'Billing',
    description: 'A handful of customers with merged accounts received duplicate invoices.', impact: 2, urgency: 2, assignee: 'erik', ageDays: 8, status: 'new',
    links: [['incident', 'INC0012440', 'ServiceNow']],
  },
];

for (const d of demos) {
  const by = users[d.by];
  const p = await problems.createProblem(by, {
    title: d.title, description: d.description, category_id: categories[d.category], affected_service: d.service,
    detection: d.detection ?? 'reactive', impact: d.impact, urgency: d.urgency, assignee_id: users[d.assignee].id,
  });
  const pm = users.anna;
  if (d.major) await problems.updateProblem(pm, p.ref, { is_major: true });
  for (const [kind, reference, system] of d.links ?? []) await problems.addLink(by, p.ref, { kind, reference, system, url: '', note: '' });
  const order = ['new', 'analysis', 'known_error', 'resolved', 'closed'];
  const target = order.indexOf(d.status);
  if (target >= 1) await problems.transitionProblem(by, p.ref, { to: 'analysis' });
  for (const note of d.notes ?? []) await problems.addComment(users[d.assignee], p.ref, note);
  if (d.workaround && target < 2) await problems.updateProblem(by, p.ref, { workaround: d.workaround });
  if (target >= 2 && d.rootCause) {
    await problems.transitionProblem(by, p.ref, { to: 'known_error', root_cause: d.rootCause, workaround: d.workaround });
  } else if (d.rootCause) {
    await problems.updateProblem(by, p.ref, { root_cause: d.rootCause });
  }
  for (const a of d.analyses ?? []) await analyses.createAnalysis(by, p.ref, { technique: a.technique, title: a.title, data: a.data, conclusion: a.conclusion });
  if (d.assessment) {
    const { reviewOffset, ...assessment } = d.assessment;
    await problems.assessProblem(pm, p.ref, { ...assessment, ec_review_date: reviewOffset === undefined ? null : day(reviewOffset) });
  }
  if (target >= 3) await problems.transitionProblem(by, p.ref, { to: 'resolved', resolution: d.resolution });
  for (const [title, owner, due, done] of d.actions ?? []) {
    const r = await actions.createAction(by, p.ref, { title, owner_id: users[owner].id, due_date: due === null ? null : day(due) });
    if (done) await actions.updateAction(users[owner], p.ref, r.actions.find((a: { title: string }) => a.title === title)!.id, { status: 'done' });
  }
  if (target >= 4) await problems.transitionProblem(pm, p.ref, { to: 'closed', closure_code: d.closure, acknowledge_open_actions: true });

  // Spread the history out in time so ages and trends look realistic.
  const shift = `${d.ageDays} days`;
  await query(
    `UPDATE problems SET created_at = created_at - $2::interval, updated_at = updated_at - ($2::interval / 4),
       known_error_at = known_error_at - ($2::interval / 2), resolved_at = resolved_at - ($2::interval / 4),
       closed_at = closed_at - ($2::interval / 5), ec_decided_at = ec_decided_at - ($2::interval / 3),
       workaround_reviewed_at = workaround_reviewed_at - ($2::interval / 3) WHERE ref = $1`,
    [p.ref, shift],
  );
  await query(
    `UPDATE problem_activity SET created_at = created_at - $2::interval * (1 - (row_number_frac)) FROM (
       SELECT id AS aid, (row_number() OVER (ORDER BY id))::float / (count(*) OVER () + 1) AS row_number_frac
       FROM problem_activity WHERE problem_id = (SELECT id FROM problems WHERE ref = $1)) x WHERE problem_activity.id = x.aid`,
    [p.ref, shift],
  );
  console.log(`${p.ref} ${d.status.padEnd(12)} ${d.title}`);
}
// External systems and recent unlinked records, so the problem candidates list has content.
await query(`INSERT INTO external_systems (name, url_templates) VALUES
  ('ServiceNow', '{"incident": "https://example.service-now.com/incident.do?sysparm_query=number={ref}", "change": "https://example.service-now.com/change_request.do?sysparm_query=number={ref}"}'),
  ('Zabbix', '{"event": "https://zabbix.example.com/tr_events.php?eventid={ref}"}')
  ON CONFLICT (name) DO NOTHING`);
const recent = [
  ['ServiceNow', 'incident', 'Payments', 'Card payment declined with timeout'],
  ['ServiceNow', 'incident', 'Payments', 'Customer charged twice'],
  ['Zabbix', 'event', 'Payments', 'PSP latency > 2 s'],
  ['ServiceNow', 'incident', 'Payments', 'Checkout spinner never finishes'],
  ['Zabbix', 'event', 'Payments', 'PSP latency > 2 s'],
  ['ServiceNow', 'incident', 'Payments', 'Refund stuck in pending'],
  ['ServiceNow', 'incident', 'Customer portal', 'Login loop after password reset'],
  ['ServiceNow', 'incident', 'Customer portal', 'Password reset email not received'],
  ['ServiceNow', 'incident', 'Customer portal', 'Stuck on MFA screen'],
  ['ServiceNow', 'incident', 'Customer portal', 'Login loop on Safari'],
  ['ServiceNow', 'incident', 'Customer portal', 'Session expires immediately'],
  ['ServiceNow', 'incident', 'HR system', 'Payslip PDF blank'],
];
for (const [i, [system, kind, service, summary]] of recent.entries()) {
  await query(
    `INSERT INTO external_records (system, kind, reference, service, summary, occurred_at) VALUES ($1, $2, $3, $4, $5, now() - $6 * interval '9 hours')`,
    [system, kind, kind === 'incident' ? `INC00130${String(i).padStart(2, '0')}` : `ZBX-9${4100 + i}`, service, summary, i],
  );
}

await pool.end();
console.log('Demo users: anna (problem manager), erik, sara, jonas (analysts), lena (viewer) – password "demo-password"');
