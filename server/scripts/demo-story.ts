// The Webshop story (#115): one connected example across every practice, small enough to read in five minutes, plus
// a little background volume so reports and trends have shapes. Everything goes through the service layer, like the
// API, so audit, SLA clocks, live updates and the hash chain are real; then timestamps are moved relative to now, so
// the demo always looks current (an update is due in 10 minutes, an action is two days overdue).
import type { User } from '../src/auth.js';
import { query } from '../src/db.js';
import * as actions from '../src/actions.js';
import * as analyses from '../src/analyses.js';
import * as candidates from '../src/candidates.js';
import * as changes from '../src/changes.js';
import * as cmdb from '../src/cmdb.js';
import * as connectors from '../src/connectors.js';
import * as graph from '../src/cmdb-graph.js';
import * as events from '../src/events.js';
import * as incidents from '../src/incidents.js';
import * as knowledge from '../src/knowledge.js';
import * as major from '../src/major-incidents.js';
import * as oncall from '../src/oncall.js';
import * as people from '../src/people.js';
import * as problems from '../src/problems.js';
import * as improvements from '../src/improvements.js';
import * as requests from '../src/requests.js';
import * as reviews from '../src/reviews.js';
import * as setup from '../src/setup.js';
import * as sla from '../src/sla.js';
import * as status from '../src/status.js';
import * as teams from '../src/teams.js';

type People = Record<'admin' | 'anna' | 'erik' | 'sara' | 'jonas', User>;
const TABLE: Record<string, [table: string, log?: [string, string]]> = {
  INC: ['incidents', ['incident_activity', 'incident_id']], PRB: ['problems', ['problem_activity', 'problem_id']], CHG: ['changes', ['change_activity', 'change_id']],
};
const columns = new Map<string, string[]>();

/** Moves every timestamp of a record (and its history) back by `minutes`, so it happened then. */
async function shift(ref: string, minutes: number) {
  const [table, log] = TABLE[ref.slice(0, 3)];
  for (const t of [table, log?.[0]].filter(Boolean) as string[]) {
    if (!columns.has(t)) {
      const { rows } = await query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND data_type IN ('timestamp with time zone', 'date') AND is_generated = 'NEVER'", [t]);
      columns.set(t, rows.map((r) => r.column_name));
    }
  }
  const set = (t: string) => columns.get(t)!.map((c) => `${c} = ${c} - $2 * interval '1 minute'`).join(', ');
  const { rows } = await query(`UPDATE ${table} SET ${set(table)} WHERE ref = $1 RETURNING id`, [ref, minutes]);
  if (log) await query(`UPDATE ${log[0]} SET ${set(log[0])} WHERE ${log[1]} = $1`, [rows[0].id, minutes]);
}
const H = 60, D = 24 * 60;

export async function seedStory(p: People) {
  const { admin, anna, erik, sara, jonas } = p;
  // ---- Service levels, teams and the CMDB ----
  // The calendars and the default SLA come with every installation; the Webshop gets a stricter one.
  const { rows: cals } = await query("SELECT id, name FROM business_calendars WHERE name IN ('24/7', 'Office hours (Sweden)')");
  const always = cals.find((c) => c.name === '24/7')!;
  const gold = await sla.saveSla(admin, null, { name: 'Webshop Gold', description: 'Customer-facing commerce, around the clock', calendar_id: always.id, response_minutes: { 1: 15, 2: 30, 3: 60, 4: 240, 5: 480 }, resolution_minutes: { 1: 240, 2: 480, 3: 1440, 4: 2880, 5: 4320 }, availability_target: 99.9, is_default: false });

  const ci = async (name: string, ci_type: string, extra: Record<string, unknown> = {}) => (await cmdb.createCi(admin, { name, ci_type, ...extra } as any)).ref as string;
  const webshop = await ci('Webshop', 'business_service', { criticality: 1, sla_id: gold.id, has_end_users: true, in_catalogue: true, user_description: 'Online shop for customers: browse, cart and checkout.', how_to_get_help: 'Call the service desk on 010-123 45 00.' });
  const frontend = await ci('shop-frontend', 'application', { criticality: 1, attributes: { version: '4.12.0' } });
  const workload = await ci('shop-web', 'kubernetes_workload', { attributes: { namespace: 'shop', kind: 'Deployment', replicas: 6 } });
  const node = await ci('aks-node-07', 'virtual_machine', { attributes: { os: 'Ubuntu 22.04', ip: '10.20.0.17' } });
  const db = await ci('shop-db', 'database', { criticality: 1, attributes: { engine: 'PostgreSQL', version: '17' } });
  const gateway = await ci('pay-gw01', 'virtual_machine', { criticality: 1, attributes: { os: 'RHEL 9', ip: '10.30.0.5' } });
  const search = await ci('shop-search', 'application', { criticality: 2, attributes: { version: '8.15' } });
  for (const [from, type, to] of [[frontend, 'member_of', webshop], [frontend, 'runs_on', workload], [workload, 'runs_on', node], [frontend, 'uses_database', db], [frontend, 'connects_to', gateway], [search, 'member_of', webshop]] as const) {
    await graph.addRelationship(admin, from, { type, target: to, direction: 'outgoing' });
  }
  const web = await teams.saveTeam(admin, null, { name: 'Web platform', description: 'Webshop front end and its platform', email: '', auto_assign: 'none', active: true, cis: [webshop, frontend, workload, search] });
  await teams.setMembers(admin, web!.id, { members: [{ user_id: erik.id, role: 'lead' }, { user_id: sara.id, role: 'member' }] });
  const pay = await teams.saveTeam(admin, null, { name: 'Payments', description: 'Payment gateway and PSP integration', email: '', auto_assign: 'none', active: true, cis: [gateway] });
  await teams.setMembers(admin, pay!.id, { members: [{ user_id: jonas.id, role: 'lead' }] });

  // On call: both teams use the built-in weekly rotation (no paging tool in a demo), so a P1 notifies a person.
  for (const [team, members] of [[web!.id, [erik.id, sara.id]], [pay!.id, [jonas.id]]] as const) {
    await oncall.savePaging(admin, team, { kind: 'rotation', config: {}, rule: { priorities: [1, 2], major: true, services: [], hours: 'always', calendar_id: null }, private_allow: [], enabled: true, new_inbound_token: false });
    await oncall.saveRotation(admin, team, { members: [...members], handover_dow: 1, handover_minute: 540, timezone: 'Europe/Stockholm' });
  }

  // ---- The people who use it: a customer organisation, contacts, a VIP ----
  await people.saveOrganisation(admin, null, { name: 'Webshop customers', kind: 'customer', description: 'Consumers buying online', active: true, services: [webshop] });
  const { rows: org } = await query("SELECT id FROM organisations WHERE name = 'Webshop customers'");
  await people.saveOrganisation(admin, null, { name: 'Customer service', kind: 'internal', description: 'Answers customer calls and chats', active: true, services: [webshop] });
  const { rows: cs } = await query("SELECT id FROM organisations WHERE name = 'Customer service'");
  const contacts = [
    { name: 'Maria Svensson', email: 'maria.svensson@example.com', title: 'Team lead', department: 'Customer service', organisation_id: cs[0].id, is_vip: false },
    { name: 'Johan Ek', email: 'johan.ek@example.com', title: 'Head of e-commerce', department: 'Digital', organisation_id: cs[0].id, is_vip: true },
    { name: 'Lisa Nordin', email: 'lisa.nordin@example.net', organisation_id: org[0].id, is_vip: false },
    { name: 'Ahmed Karimi', email: 'ahmed.karimi@example.net', organisation_id: org[0].id, is_vip: false },
  ];
  for (const c of contacts) await people.createPerson(admin, c as any);

  // ---- A change two hours ago on the payment gateway: the likely cause ----
  const chg = (await changes.createChange(erik, {
    title: 'Upgrade the TLS library on the payment gateway', description: 'Security update for the gateway\'s TLS stack (CVE fix).', change_type: 'normal', risk: 'low',
    cis: [gateway], team_id: pay!.id, implementation_plan: 'Drain pay-gw01, upgrade openssl, restart, verify a test payment.', backout_plan: 'Reinstall the previous package from the local mirror and restart.',
    planned_start: new Date(Date.now() + H * 60_000).toISOString(), planned_end: new Date(Date.now() + 2 * H * 60_000).toISOString(),
  })).ref as string;
  await changes.transitionChange(erik, chg, { to: 'assess' });
  await changes.transitionChange(erik, chg, { to: 'authorize' });
  await changes.voteOnChange(anna, chg, { decision: 'approve', comment: 'Low risk, backout is clear.' });
  await changes.transitionChange(jonas, chg, { to: 'implementing' });
  await changes.transitionChange(jonas, chg, { to: 'review', outcome: 'successful' });
  await shift(chg, 2 * H + 10);

  // ---- Monitoring sees checkout fail; the event rule opens the incident ----
  await events.saveRule(admin, null, { name: 'Critical on business-critical CIs', enabled: true, position: 10, conditions: { min_severity: 'critical', max_ci_criticality: 1 }, impact: 1, urgency: 1, team_id: web!.id, group_by: 'service', group_window_minutes: 60, max_incidents_per_hour: 5, auto_resolve: false, hold_down_minutes: 15 });
  await events.processEvents('Uptime Kuma', 'Uptime Kuma', [
    { host: 'shop-frontend', check: 'HTTP POST /checkout', severity: 'critical', message: 'Checkout returns 502 (3 of 3 probes)' },
    { host: 'pay-gw01', check: 'TLS handshake', severity: 'major', message: 'handshake failure: unsupported protocol' },
  ] as any);
  const { rows: opened } = await query("SELECT ref FROM incidents WHERE source = 'event' ORDER BY id DESC LIMIT 1");
  const inc = opened[0].ref as string;
  await incidents.updateIncident(anna, inc, { title: 'Checkout fails for all customers', description: 'Customers get an error at payment. Monitoring: checkout returns 502; TLS handshakes to the payment gateway fail.', caller: { email: 'maria.svensson@example.com' } });
  for (const email of ['johan.ek@example.com', 'lisa.nordin@example.net', 'ahmed.karimi@example.net']) await people.setAffected(anna, inc, { email }, true, false);
  await incidents.transitionIncident(sara, inc, { to: 'in_progress' });

  // ---- It is a major incident: lead, comms, bridge, updates, related reports, the status page ----
  await major.declareMajor(anna, inc, { comms_id: sara.id, bridge: 'https://teams.example.com/l/meetup-join/webshop-war-room', update_minutes: 30 });
  await major.postCommunication(sara, inc, { body: 'Affected: online checkout. Browsing and carts work.\nWhat we know: payments fail since about 40 minutes ago.\nWhat we are doing: checking the payment gateway change from this morning.\nNext update: in 30 minutes.' });
  for (const [who, title] of [[erik, 'Customer cannot pay with card'], [jonas, 'Orders stuck in "payment pending"']] as const) {
    const child = (await incidents.createIncident(who, { title, impact: 2, urgency: 2, cis: [webshop], reporter: 'Service desk' })).ref as string;
    await major.linkChild(anna, inc, { child, resolve_with_parent: true });
  }
  await status.postUpdate(anna, { incident: inc, services: [webshop], phase: 'identified', status: 'major_outage', message: 'Payments in the webshop fail. We have found the likely cause and are rolling back a change.', public: false });
  const { rows: note } = await query("SELECT a.id FROM incident_activity a JOIN incidents i ON i.id = a.incident_id WHERE i.ref = $1 AND a.kind = 'communication' ORDER BY a.id LIMIT 1", [inc]);
  await major.setKeyMoment(anna, inc, note[0].id, true);
  await shift(inc, 50);
  // The last update was 20 minutes ago: the next is due in 10.
  await query("UPDATE incidents SET major_next_update_at = now() + interval '10 minutes' WHERE ref = $1", [inc]);

  // ---- The problem behind it: 5 Whys, known error with a workaround, an article, actions ----
  const prb = (await incidents.createProblemFromIncident(anna, inc, { title: 'Payment gateway rejects TLS 1.2 clients after library upgrades' })).ref as string;
  await problems.transitionProblem(anna, prb, { to: 'analysis' });
  await analyses.createAnalysis(erik, prb, {
    technique: 'five_whys', title: 'Why did checkout fail?',
    data: { problem_statement: 'Checkout payments failed for 55 minutes after the TLS upgrade on pay-gw01', whys: [
      { why: 'Why did payments fail?', because: 'The shop could not complete a TLS handshake with the payment gateway.' },
      { why: 'Why did the handshake fail?', because: 'The upgraded library disabled TLS 1.2 by default; the shop client only speaks 1.2.' },
      { why: 'Why was that not caught?', because: 'The change test was a payment from the admin console, which uses TLS 1.3.' },
      { why: 'Why does the test use the console?', because: 'The test plan template predates the shop client and was never updated.' },
    ] },
    conclusion: 'Library defaults changed under us, and the change test did not exercise the real client.',
  });
  await problems.transitionProblem(anna, prb, { to: 'known_error', root_cause: 'The TLS library upgrade disabled TLS 1.2, which the shop client still needs.', workaround: 'Re-enable TLS 1.2 on pay-gw01 (`MinProtocol = TLSv1.2`) and restart the gateway service.' });
  await knowledge.publishKnownError(anna, prb);
  await actions.createAction(anna, prb, { title: 'Upgrade the shop payment client to TLS 1.3', owner_id: erik.id, due_date: new Date(Date.now() + 14 * D * 60_000).toISOString().slice(0, 10) });
  await actions.createAction(anna, prb, { title: 'Add a real shop payment to the gateway change test', owner_id: jonas.id, due_date: new Date(Date.now() - 2 * D * 60_000).toISOString().slice(0, 10) });
  await shift(prb, 30);

  // ---- An earlier major incident, resolved and reviewed ----
  const old = (await incidents.createIncident(sara, { title: 'Product search returns no results', impact: 1, urgency: 2, cis: [search] })).ref as string;
  await major.declareMajor(anna, old, { lead_id: erik.id, comms_id: sara.id });
  await major.postCommunication(sara, old, { body: 'Search is down; customers can still browse categories. Next update in 60 minutes.' });
  await incidents.transitionIncident(erik, old, { to: 'resolved', resolution_code: 'fixed', resolution: 'Rebuilt the search index after a failed mapping update.' });
  await reviews.updateReview(erik, old, { attendees: 'Erik, Sara, Anna', went_well: 'Browsing by category kept most sales going.', was_hard: 'Index rebuild time was unknown; we guessed.', lucky: 'It happened on a Monday morning, not during a campaign.' });
  let rv = await reviews.addItem(erik, old, { kind: 'factor', body: 'Mapping updates are applied in place, without a new index' });
  await reviews.itemToProblem(erik, old, rv.items.find((x: any) => x.kind === 'factor').id, {});
  rv = await reviews.addItem(erik, old, { kind: 'follow_up', body: 'Blue/green index switch for mapping changes' });
  await reviews.itemToAction(erik, old, rv.items.find((x: any) => x.kind === 'follow_up').id, { owner_id: erik.id, due_date: new Date(Date.now() + 21 * D * 60_000).toISOString().slice(0, 10) });
  // A detection gap is bigger than a fix: it goes to the continual improvement register (#52).
  rv = await reviews.addItem(erik, old, { kind: 'gap', body: 'Synthetic search checks from outside, so we notice before customers do' });
  await reviews.itemToImprovement(erik, old, rv.items.find((x: any) => x.kind === 'gap').id, { owner_id: erik.id });
  await reviews.publishReview(erik, old);
  await shift(old, 12 * D);
  // Reviewed three working days after it was resolved.
  await query(`UPDATE incident_reviews SET created_at = created_at - interval '12 days', updated_at = updated_at - interval '9 days',
                 published_at = published_at - interval '9 days', due = due - 9 WHERE incident_id = (SELECT id FROM incidents WHERE ref = $1)`, [old]);

  // A major incident resolved yesterday: its review is scheduled for tomorrow, so the list and the badge show it (#120).
  const recent = (await incidents.createIncident(erik, { title: 'Login slow for all customers after the release', impact: 1, urgency: 2, cis: [frontend], team_id: web!.id })).ref as string;
  await major.declareMajor(anna, recent, { lead_id: sara.id });
  const tomorrow = new Date(Date.now() + D * 60_000).toISOString().slice(0, 10);
  await incidents.transitionIncident(sara, recent, { to: 'resolved', resolution_code: 'fixed', resolution: 'Rolled back the session cache change.', pir_owner_id: sara.id, pir_due: tomorrow });
  await shift(recent, D);

  // ---- Background: a quarter of everyday incidents and changes ----
  const everyday: [string, string, number][] = [
    ['VPN drops every hour for remote staff', node, 3], ['Printer queue stuck on floor 3', node, 3], ['Slow product images', frontend, 3], ['Password reset mail delayed', frontend, 3],
    ['Cart loses items after login', frontend, 2], ['Search suggestions empty', search, 3], ['Payment page slow at lunch', gateway, 2], ['Order confirmation PDF blank', frontend, 3],
    ['Database replica lag alerts', db, 2], ['Checkout button greyed out on Safari', frontend, 2], ['Gift cards rejected', gateway, 2], ['Wrong prices shown for 10 minutes', frontend, 1],
    ['Shop slow after campaign mail', workload, 2], ['Admin console login loop', frontend, 3], ['Stock levels not updated', db, 2], ['Cookie banner covers checkout', frontend, 3],
    ['Search returns old products', search, 3], ['Refund stuck in pending', gateway, 2], ['Images 404 after deploy', workload, 2], ['Customer charged twice', gateway, 1],
    ['Newsletter signup fails', frontend, 3], ['Delivery options missing', frontend, 2], ['Pod restarts on node 07', workload, 3], ['Card form does not load', gateway, 2],
  ];
  for (const [n, [title, on, level]] of everyday.entries()) {
    const who = [erik, sara, jonas][n % 3];
    const r = (await incidents.createIncident(who, { title, impact: level, urgency: Math.min(3, level + (n % 2)), cis: [on] })).ref as string;
    await incidents.transitionIncident(who, r, { to: 'in_progress' });
    await incidents.transitionIncident(who, r, { to: 'resolved', resolution_code: n % 5 === 0 ? 'workaround' : 'fixed', resolution: n % 5 === 0 ? 'Applied the documented workaround.' : 'Fixed and verified with the reporter.' });
    if (n % 3 !== 0) await incidents.transitionIncident(who, r, { to: 'closed' });
    await shift(r, (3 + Math.round((n * 87) / everyday.length)) * D + (n % 7) * H);
  }
  for (const [n, title] of ['Patch shop-db to 17.2', 'Raise shop-web replicas for the campaign', 'Rotate the payment gateway certificate', 'New delivery partner API key', 'Upgrade the search cluster'].entries()) {
    const c = (await changes.createChange(erik, { title, change_type: 'normal', risk: 'low', cis: [[db, workload, gateway, frontend, search][n]], implementation_plan: 'Follow the runbook.', backout_plan: 'Restore the previous version.', planned_start: new Date(Date.now() + H * 60_000).toISOString(), planned_end: new Date(Date.now() + 2 * H * 60_000).toISOString() })).ref as string;
    await changes.transitionChange(erik, c, { to: 'assess' });
    await changes.transitionChange(erik, c, { to: 'authorize' });
    await changes.voteOnChange(anna, c, { decision: 'approve', comment: '' });
    await changes.transitionChange(jonas, c, { to: 'implementing' });
    await changes.transitionChange(jonas, c, { to: 'review', outcome: n === 2 ? 'rolled_back' : 'successful' });
    await changes.transitionChange(jonas, c, { to: 'closed', ...(n === 2 ? { review: 'The new certificate chain was incomplete; rolled back and re-issued.' } : {}) });
    await shift(c, (10 + n * 15) * D);
  }
  // Maintenance next week, so the status page and the change schedule show what is coming.
  const upgrade = (await changes.createChange(erik, { title: 'Minor upgrade of shop-db to 17.3', description: 'Rolling restart; checkout read-only for about five minutes.', change_type: 'normal', risk: 'low', cis: [db], implementation_plan: 'Upgrade the replica, fail over, upgrade the old primary.', backout_plan: 'Fail back to the old primary.', planned_start: new Date(Date.now() + 6 * D * 60_000).toISOString(), planned_end: new Date(Date.now() + 6 * D * 60_000 + 2 * H * 60_000).toISOString() })).ref as string;
  await changes.transitionChange(erik, upgrade, { to: 'assess' });
  await changes.transitionChange(erik, upgrade, { to: 'authorize' });
  await changes.voteOnChange(anna, upgrade, { decision: 'approve', comment: 'Fine outside the campaign week.' });
  // One change waiting for approval, so the change board has something to decide.
  const next = (await changes.createChange(jonas, { title: 'Re-enable TLS 1.2 permanently on pay-gw01', change_type: 'normal', risk: 'medium', cis: [gateway], problem: prb, implementation_plan: 'Set MinProtocol = TLSv1.2 in the gateway config and restart.', backout_plan: 'Revert the config line.', planned_start: new Date(Date.now() + 26 * H * 60_000).toISOString(), planned_end: new Date(Date.now() + 27 * H * 60_000).toISOString() })).ref as string;
  await changes.transitionChange(jonas, next, { to: 'assess' });
  await changes.transitionChange(jonas, next, { to: 'authorize' });
  // ---- Problem candidates (#31): something for every rule ----
  // shop-web pods keep restarting: five this week, each handled with a restart (recurring records; same category and resolution).
  const { rows: infra } = await query("SELECT id FROM categories WHERE name = 'Infrastructure'");
  for (let d = 0; d < 5; d++) {
    const who = [erik, sara][d % 2];
    const r = (await incidents.createIncident(who, { title: 'shop-web pods restarting (OOMKilled)', impact: 3, urgency: 2, cis: [workload], category_id: infra[0]?.id ?? null, team_id: web!.id })).ref as string;
    await incidents.transitionIncident(who, r, { to: 'resolved', resolution_code: 'workaround', resolution: 'Restarted the deployment; memory back to normal.' });
    await shift(r, (d + 1) * D - 3 * H);
  }
  // The front end runs on shop-web and is slow too: incidents on two CIs that share one dependency.
  for (const [title, ago] of [['Product pages slow to load', 2], ['Cart page times out now and then', 4]] as const) {
    await shift((await incidents.createIncident(sara, { title, impact: 3, urgency: 3, cis: [frontend] })).ref as string, ago * D);
  }
  // A log-analysis agent noticed the memory growth behind the restarts.
  await candidates.reportCandidate(admin, {
    source: 'log-agent', external_key: 'shop-web-heap-growth', title: 'shop-web heap grows until the pods are killed',
    reason: 'Heap usage on shop-web grows about 300 MB a day since release 4.12 and the pods are OOM-killed every night', ci_ref: workload, service: '',
    evidence: {
      incident_refs: [], alert_ids: [], ci_refs: [frontend],
      items: [
        { reference: 'Grafana: shop-web memory', summary: 'Working set climbs from 1.1 GB to 2 GB (limit) in about three days', url: 'https://grafana.example.com/d/shop-web-memory' },
        { reference: 'kubectl describe pod shop-web-7c9f', summary: 'Last state: Terminated, reason OOMKilled, exit code 137' },
      ],
      notes: 'The growth started with release 4.12 of shop-frontend. A heap dump would show which cache keeps growing.',
    },
  });
  // ---- Before it hurts (#31, part 2): trends in monitoring and in changes ----
  const kuma = (evs: object[]) => events.processEvents('Uptime Kuma', 'Uptime Kuma', evs.map((e) => ({ message: '', ...e })) as any);
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  // The search health check flaps: it clears and fires again six times in the last quarter hour.
  for (let i = 0; i < 6; i++) {
    await kuma([{ host: 'shop-search', check: 'HTTP GET /search/health', severity: 'warning', message: 'Slow response (2.4 s)', occurred_at: ago(13 - 2 * i) }]);
    await kuma([{ host: 'shop-search', check: 'HTTP GET /search/health', severity: 'clear', occurred_at: ago(12.5 - 2 * i) }]);
  }
  // Replication lag warnings on shop-db: a few last week, many this week.
  for (const [day, times] of [[12, 1], [10, 1], [8, 1], [6, 2], [5, 2], [4, 3], [3, 3], [2, 4], [1, 4]] as const) {
    for (let t = 0; t < times; t++) await kuma([{ host: 'shop-db', check: 'Replication lag', severity: 'warning', message: `Replica ${20 + day * 3 + t} s behind`, occurred_at: ago(day * D - t * 90) }]);
  }
  // The node's disk keeps filling up and being cleaned by hand.
  for (const day of [25, 15, 6, 1]) {
    await kuma([{ host: 'aks-node-07', check: 'Disk usage /var/lib/containerd', severity: 'major', message: 'Disk 93% full', occurred_at: ago(day * D) }]);
    await kuma([{ host: 'aks-node-07', check: 'Disk usage /var/lib/containerd', severity: 'clear', occurred_at: ago(day * D - 4 * H) }]);
  }
  // Packet loss to the payment gateway that clears itself within minutes, every day or two, and nobody looks.
  for (const day of [11, 9, 7, 5, 3, 2]) {
    await kuma([{ host: 'pay-gw01', check: 'Ping loss', severity: 'minor', message: 'Packet loss 12%', occurred_at: ago(day * D + 3 * H) }]);
    await kuma([{ host: 'pay-gw01', check: 'Ping loss', severity: 'clear', occurred_at: ago(day * D + 3 * H - 4) }]);
  }
  // Two more gateway changes: with the rolled-back certificate change, two of three went wrong.
  for (const [title, outcome, days] of [['Update the gateway firewall rules', 'successful', 50], ['Tune the gateway JVM heap', 'failed', 20]] as const) {
    const c = (await changes.createChange(jonas, { title, change_type: 'normal', risk: 'low', cis: [gateway], implementation_plan: 'Follow the runbook.', backout_plan: 'Restore the previous version.', planned_start: new Date(Date.now() + H * 60_000).toISOString(), planned_end: new Date(Date.now() + 2 * H * 60_000).toISOString() })).ref as string;
    await changes.transitionChange(jonas, c, { to: 'assess' });
    await changes.transitionChange(jonas, c, { to: 'authorize' });
    await changes.voteOnChange(anna, c, { decision: 'approve', comment: '' });
    await changes.transitionChange(jonas, c, { to: 'implementing' });
    await changes.transitionChange(jonas, c, { to: 'review', outcome });
    await changes.transitionChange(jonas, c, { to: 'closed', ...(outcome === 'failed' ? { review: 'The new heap size made garbage collection pauses longer; reverted.' } : {}) });
    await shift(c, days * D);
  }
  // ---- Configuration risk (#31, part 3) ----
  // Two more services use shop-db, which has no replica in the CMDB: a single point of failure for three services.
  for (const [service, app] of [['Order API', 'order-api'], ['Back office', 'admin-console']] as const) {
    const svc = await ci(service, 'business_service', { criticality: 2 });
    const comp = await ci(app, 'application', { criticality: 2 });
    await graph.addRelationship(admin, comp, { type: 'member_of', target: svc, direction: 'outgoing' });
    await graph.addRelationship(admin, comp, { type: 'uses_database', target: db, direction: 'outgoing' });
  }
  // A reporting database on a PostgreSQL version past its end of life (in the EOL table).
  await ci('reporting-db', 'database', { criticality: 3, attributes: { engine: 'PostgreSQL', version: '13.9' } });
  // vCenter keeps losing sight of the batch server (Windows Server 2012 R2, also past end of life): missing twice.
  const vms = [['vm-101', 'batch01', 'Windows Server 2012 R2'], ['vm-102', 'file01', 'Windows Server 2022'], ['vm-103', 'print01', 'Windows Server 2022']].map(([source_id, name, os]) => ({ source_id, name, ci_type: 'virtual_machine', attributes: { os } }));
  const vcenter = (cis: typeof vms) => connectors.ciBatch(admin, { source_system: 'vCenter', cis, relationships: [], full_sync: true, incomplete_prefixes: [] } as any);
  await vcenter(vms);
  for (let round = 0; round < 2; round++) {
    for (let miss = 0; miss < 3; miss++) await vcenter(vms.slice(1));
    if (round === 0) await vcenter(vms);
  }
  await query("UPDATE ci_activity SET created_at = created_at - interval '20 days' WHERE id = (SELECT min(id) FROM ci_activity WHERE data->>'to' = 'missing')");
  // The asset inventory lost a scanner server three weeks ago: long enough to be proposed for retirement (#18).
  const assets = [{ source_id: 'scan01', name: 'scan01', ci_type: 'virtual_machine' }, { source_id: 'kiosk01', name: 'kiosk01', ci_type: 'virtual_machine' }];
  const sweep = (cis: typeof assets) => connectors.ciBatch(admin, { source_system: 'Asset inventory', cis, relationships: [], full_sync: true, incomplete_prefixes: [] } as any);
  await sweep(assets);
  for (let miss = 0; miss < 3; miss++) await sweep(assets.slice(1));
  await query("UPDATE configuration_items SET missing_since = now() - interval '23 days' WHERE name = 'scan01'");
  await query("UPDATE ci_sources SET first_seen_at = now() - interval '400 days', last_seen_at = now() - interval '26 days' WHERE source_id = 'scan01'");
  await query("UPDATE ci_activity SET created_at = now() - interval '23 days' WHERE data->>'to' = 'missing' AND ci_id = (SELECT id FROM configuration_items WHERE name = 'scan01')");
  // ---- The continual improvement register (#52): ideas in every stage, rated by value and effort ----
  const fromGap = (await query("SELECT ref FROM improvements WHERE source = 'review' ORDER BY id LIMIT 1")).rows[0].ref as string;
  await improvements.updateImprovement(erik, fromGap, { service: webshop, value: 5, effort: 2, kpi: 'mttr', description: 'Search broke for 40 minutes before the first customer call. A synthetic check every minute would have paged us in two.' });
  await improvements.transitionImprovement(anna, fromGap, { to: 'approved' });
  await improvements.transitionImprovement(erik, fromGap, { to: 'in_progress' });
  const ideas: { by: User; title: string; description: string; value: number; effort: number; to?: string[]; kpi?: 'mttr' | 'sla' | 'change_success' | 'recurring'; benefit?: string; reason?: string }[] = [
    { by: sara, title: 'Status page link in the checkout error message', description: 'Customers call the desk when checkout fails; the status page already says what is wrong.', value: 4, effort: 1, kpi: 'sla' },
    { by: jonas, title: 'Canary releases for the payment gateway', description: 'Two of the last five gateway releases were rolled back.', value: 5, effort: 4, to: ['approved'], kpi: 'change_success' },
    { by: erik, title: 'Runbook for a full search index rebuild', description: 'Nobody knew how long a rebuild takes.', value: 3, effort: 1, to: ['approved', 'in_progress', 'done'], benefit: 'The last rebuild took 25 minutes instead of 70: the runbook names the right batch size.' },
    { by: sara, title: 'Weekly review of incidents without a category', description: 'A third of last month\'s incidents had no category, so trends miss them.', value: 2, effort: 1, kpi: 'recurring' },
    { by: anna, title: 'Move the webshop to a new CMS', description: 'Content editors find the current CMS slow.', value: 2, effort: 5, to: ['rejected'], reason: 'Not a service problem: the editors\' wish goes to the product backlog.' },
    { by: jonas, title: 'Automatic certificate renewal everywhere', description: 'Three expired certificates this year, each found by customers.', value: 5, effort: 3, to: ['approved', 'in_progress'], kpi: 'mttr' },
    { by: erik, title: 'Self-service password reset for shop staff', description: 'Password resets are a fifth of the desk\'s tickets.', value: 4, effort: 2 },
  ];
  for (const x of ideas) {
    const m = (await improvements.createImprovement(x.by, { title: x.title, description: x.description, value: x.value, effort: x.effort, service: webshop, ...(x.kpi ? { kpi: x.kpi } : {}), owner_id: x.by.id })).ref;
    for (const to of x.to ?? []) {
      await improvements.transitionImprovement(['approved', 'rejected'].includes(to) ? anna : x.by, m, { to: to as 'approved', ...(to === 'done' ? { benefit: x.benefit } : {}), ...(to === 'rejected' ? { reason: x.reason } : {}) });
    }
  }
  // The certificate work is carried out by the gateway certificate change (rolled back once).
  const certChange = (await query("SELECT ref FROM changes WHERE title = 'Rotate the payment gateway certificate'")).rows[0].ref as string;
  await improvements.addImprovementLink(jonas, (await query("SELECT ref FROM improvements WHERE title LIKE 'Automatic certificate%'")).rows[0].ref, { kind: 'change', reference: certChange, system: 'Kernel', url: '', note: '' });

  // ---- Service requests (#44): an optional module, on in the demo; a small catalogue and requests in every stage ----
  await setup.setModules(admin, { request: true }, 'Demo story');
  await query('UPDATE configuration_items SET owner_id = $2 WHERE ref = $1', [webshop, anna.id]);
  // Anna has a contact of her own and manages the customer service staff, so she approves their access requests.
  const annaPerson = (await people.createPerson(admin, { name: 'Anna Lind', email: 'anna.lind@example.com', title: 'Service manager', department: 'IT' } as any)).id as number;
  await query('UPDATE people SET user_id = $2 WHERE id = $1', [annaPerson, anna.id]);
  await query("UPDATE people SET manager_id = $1 WHERE email IN ('maria.svensson@example.com', 'johan.ek@example.com')", [annaPerson]);
  const karin = (await people.createPerson(admin, { name: 'Karin Holm', email: 'karin.holm@example.com', title: 'New hire', department: 'Customer service', manager_id: annaPerson } as any)).id as number;
  const personId = async (email: string) => (await query('SELECT id FROM people WHERE email = $1', [email])).rows[0].id as number;
  const item = (input: Partial<Parameters<typeof requests.saveRequestItem>[2]> & { name: string; fulfilment_tasks: { title: string; team_id: number | null }[] }) =>
    requests.saveRequestItem(anna, null, requests.requestItemSchema.parse({ service: webshop, ...input }));
  const account = await item({
    name: 'New account', description: 'An account for the shop admin and the order system, for a new colleague.',
    form: [{ key: 'full_name', label: 'Full name', type: 'text', required: true }, { key: 'start', label: 'Start date', type: 'date', required: true }, { key: 'role', label: 'Role', type: 'choice', required: true, choices: ['Customer service', 'Content editor', 'Warehouse'] }],
    fulfilment_tasks: [{ title: 'Create the account', team_id: web!.id }, { title: 'Send the welcome email', team_id: null }],
  });
  const access = await item({
    name: 'Access to a system', description: 'Read or write access to a system you need for your work.',
    form: [
      { key: 'system', label: 'System', type: 'ci', required: true },
      { key: 'level', label: 'Access level', type: 'choice', required: true, choices: ['Read', 'Write'] },
      { key: 'why', label: 'Why do you need it?', type: 'textarea', required: true },
      { key: 'until', label: 'Until', type: 'date' },
    ],
    approval: 'requester_manager', fulfilment_tasks: [{ title: 'Grant the access', team_id: web!.id }, { title: 'Tell the requester', team_id: null }],
  });
  // A new VM is a standard change (part 2 of #44): approved by the service owner, provisioned through the template.
  const vmTemplate = await changes.saveTemplate(admin, null, changes.templateSchema.parse({
    name: 'Provision a webshop VM', max_risk: 'high', description: 'A new VM from the platform image.',
    implementation_plan: 'Run the VM pipeline with the requested size; join it to monitoring.', backout_plan: 'Delete the VM and its DNS record.',
  }));
  const newVm = await item({
    name: 'New VM', description: 'A virtual machine for the webshop platform. Becomes a standard change when approved.',
    form: [{ key: 'size', label: 'Size', type: 'choice', required: true, choices: ['Small (2 vCPU)', 'Medium (4 vCPU)', 'Large (8 vCPU)'] }, { key: 'purpose', label: 'What is it for?', type: 'textarea', required: true }],
    approval: 'service_owner', standard_change_template_id: vmTemplate.id,
    fulfilment_tasks: [{ title: 'Provision the VM', team_id: web!.id, kind: 'change' }, { title: 'Add monitoring', team_id: web!.id }],
  });
  // Waiting for Anna's approval.
  await requests.createRequest(sara, { item_id: access.id, requester: { id: await personId('maria.svensson@example.com') }, answers: { system: db, level: 'Read', why: 'To look up orders when customers call about a failed checkout.' }, priority: 3 });
  // In fulfilment: approved, the first task waits in the Web platform queue.
  await requests.createRequest(sara, { item_id: account.id, requester: { id: karin }, answers: { full_name: 'Karin Holm', start: new Date(Date.now() + 7 * D * 60_000).toISOString().slice(0, 10), role: 'Customer service' }, priority: 3 });
  // Fulfilled last week, both tasks done.
  const done = await requests.createRequest(sara, { item_id: access.id, requester: { id: await personId('johan.ek@example.com') }, answers: { system: frontend, level: 'Write', why: 'Publishing the campaign pages for the spring sale.' }, priority: 3 });
  await requests.decideRequest(anna, done.ref, { decision: 'approve', comment: 'For the campaign.' });
  for (const t of (await requests.getRequest(erik, done.ref)).tasks) await requests.completeRequestTask(erik, done.ref, t.id, { note: t.position === 1 ? 'Editor role in the CMS.' : '' });
  // A VM: approved by Anna (the Webshop's owner), so its standard change waits to be scheduled.
  const vm = await requests.createRequest(erik, { item_id: newVm.id, requester: { id: await personId('maria.svensson@example.com') }, answers: { size: 'Medium (4 vCPU)', purpose: 'A staging copy of the search service for the spring sale.' }, priority: 3 });
  await requests.decideRequest(anna, vm.ref, { decision: 'approve', comment: '' });
  // Rejected, with the reason.
  const rejected = await requests.createRequest(sara, { item_id: access.id, requester: { id: await personId('johan.ek@example.com') }, answers: { system: db, level: 'Write', why: 'Fix prices directly in the database.' }, priority: 4 });
  await requests.decideRequest(anna, rejected.ref, { decision: 'reject', comment: 'Prices are changed in the shop admin, which keeps the history. Ask for the price editor role there.' });

  // The pages the story queued (the worker is not running while seeding).
  await oncall.deliverPages();
  return { incident: inc, problem: prb, change: chg, earlier: old };
}
