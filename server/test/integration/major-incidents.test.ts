import assert from 'node:assert/strict';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { after, before, describe, test } from 'node:test';
import { ownerQuery, skip, startKernel, type Client, type Harness } from './harness.js';

const ok = (r: { status: number; body: unknown }) => assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);
const userId = async (username: string) => (await ownerQuery('SELECT id FROM users WHERE username = $1', [username])).rows[0].id as number;

describe('major incidents (#108)', { skip }, () => {
  let k: Harness;
  let pm: Client, analyst: Client, analyst2: Client, viewer: Client;
  let svc = '', vm = '', major = '', child = '', stays = '';

  before(async () => {
    k = await startKernel();
    [pm, analyst, analyst2, viewer] = await Promise.all([k.login('pm'), k.login('analyst'), k.login('analyst2'), k.login('viewer')]);
    svc = (await pm.post('/api/cis', { name: 'Webshop', ci_type: 'business_service', criticality: 1 })).body.ref;
    vm = (await pm.post('/api/cis', { name: 'shop-vm01', ci_type: 'virtual_machine' })).body.ref;
    ok(await pm.post(`/api/cis/${vm}/relationships`, { type: 'member_of', target: svc }));
    const inc = await analyst.post('/api/incidents', { title: 'Webshop down', impact: 1, urgency: 1, cis: [vm] });
    ok(inc);
    major = inc.body.ref;
  });
  after(async () => k?.close());

  test('declaring is one action: lead, comms lead, bridge and the first update due', async () => {
    assert.equal((await analyst.post(`/api/incidents/${major}/major`, {})).status, 403, 'problem managers declare');
    assert.equal((await pm.post(`/api/incidents/${major}/major`, { bridge: 'javascript:alert(1)' })).status, 400, 'a bridge is a link or a phone number');
    const analystId = await userId('analyst');
    const r = await pm.post(`/api/incidents/${major}/major`, { comms_id: analystId, bridge: 'https://meet.example.com/war-room' });
    ok(r);
    const m = r.body.major;
    assert.equal(r.body.is_major, true);
    assert.equal(m.lead, 'Pm', 'the person declaring leads by default');
    assert.equal(m.comms, 'Analyst');
    assert.equal(m.bridge, 'https://meet.example.com/war-room');
    assert.equal(m.update_minutes, 30, 'P1 default cadence');
    const due = new Date(m.next_update_at).getTime() - Date.now();
    assert.ok(due > 28 * 60_000 && due <= 30 * 60_000, `next update in ~30 min, got ${due}`);
    assert.equal(m.update_overdue, false);
    assert.equal((await pm.post(`/api/incidents/${major}/major`, {})).status, 409, 'declared once');
    const notes = (await ownerQuery("SELECT u.username FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.event = 'major_incident' AND n.ref = $1", [major])).rows.map((x: any) => x.username);
    assert.ok(notes.includes('analyst'), 'the comms lead hears about it');
    // The status page gets a proposal, never a publication.
    assert.deepEqual(r.body.status_proposal.services, [svc]);
    assert.equal(r.body.status_proposal.status, 'major_outage');
    assert.equal((await ownerQuery('SELECT count(*)::int AS n FROM status_updates')).rows[0].n, 0, 'nothing posted by itself');
  });

  test('the team: only the lead or a manager changes it; a shorter cadence counts from the last update', async () => {
    assert.equal((await analyst2.patch(`/api/incidents/${major}/major`, { bridge: '+46 8 123 456' })).status, 403);
    const r = await pm.patch(`/api/incidents/${major}/major`, { bridge: '+46 8 123 456', update_minutes: 15 });
    ok(r);
    assert.equal(r.body.major.bridge, '+46 8 123 456');
    const due = new Date(r.body.major.next_update_at).getTime() - new Date(r.body.major.declared_at).getTime();
    assert.ok(Math.abs(due - 15 * 60_000) < 5_000, 'counted from the declaration, as no update was posted yet');
  });

  test('posting an update is one click: it restarts the countdown and is the prefill for the next', async () => {
    assert.equal((await viewer.post(`/api/incidents/${major}/communications`, { body: 'x' })).status, 403);
    await ownerQuery("UPDATE incidents SET major_next_update_at = now() - interval '5 minutes' WHERE ref = $1", [major]);
    const r = await analyst.post(`/api/incidents/${major}/communications`, { body: 'Checkout is down. We are restarting the shop servers. Next update 10:30.' });
    ok(r);
    assert.equal(r.body.major.update_overdue, false);
    assert.ok(new Date(r.body.major.next_update_at).getTime() > Date.now() + 14 * 60_000);
    assert.match(r.body.major.last_update.body, /Checkout is down/);
    const other = (await analyst.post('/api/incidents', { title: 'Printer jam' })).body.ref;
    assert.equal((await analyst.post(`/api/incidents/${other}/communications`, { body: 'x' })).status, 400, 'only on a major incident');
  });

  test('an overdue update shows in the list and on My work, and the comms lead is told once', async () => {
    await ownerQuery("UPDATE incidents SET major_next_update_at = now() - interval '1 minute' WHERE ref = $1", [major]);
    const row = (await analyst.get('/api/incidents')).body.find((i: any) => i.ref === major);
    assert.equal(row.update_overdue, true);
    const work = (await analyst.get('/api/my-work')).body;
    assert.deepEqual(work.major_updates.map((m: any) => [m.ref, m.role, m.update_overdue]), [[major, 'communications lead', true]]);
    assert.deepEqual((await analyst2.get('/api/my-work')).body.major_updates, [], 'positive control: not on everyone\'s list');
    const { checkOverdueUpdates } = await import('../../src/major-incidents.js');
    await checkOverdueUpdates();
    await checkOverdueUpdates();
    const due = (await ownerQuery("SELECT u.username FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.event = 'major_update_due' AND n.ref = $1", [major])).rows;
    assert.deepEqual(due.map((d: any) => d.username), ['analyst'], 'one notice per overdue period');
  });

  test('related incidents: suggested on the same CI, linked in one click, one level only', async () => {
    child = (await analyst2.post('/api/incidents', { title: 'Cannot pay in the shop', cis: [vm] })).body.ref;
    stays = (await analyst2.post('/api/incidents', { title: 'Shop slow for one customer', cis: [vm] })).body.ref;
    const before = (await analyst2.get(`/api/incidents/${child}`)).body;
    assert.equal(before.suggested_parent.ref, major, 'the open major incident on the same CI is suggested');
    assert.equal((await analyst2.post(`/api/incidents/${major}/children`, { child: major })).status, 400);
    ok(await analyst2.post(`/api/incidents/${major}/children`, { child }));
    const r = await analyst2.post(`/api/incidents/${major}/children`, { child: stays, resolve_with_parent: false });
    ok(r);
    assert.deepEqual(r.body.children.map((c: any) => [c.ref, c.resolve_with_parent]), [[child, true], [stays, false]]);
    const c = (await analyst2.get(`/api/incidents/${child}`)).body;
    assert.equal(c.parent.ref, major);
    assert.equal(c.suggested_parent, null);
    const third = (await analyst2.post('/api/incidents', { title: 'Third' })).body.ref;
    assert.equal((await analyst2.post(`/api/incidents/${child}/children`, { child: third })).status, 409, 'no grandchildren');
    assert.equal((await analyst2.get('/api/incidents')).body.find((i: any) => i.ref === major).child_count, 2);
  });

  test('the timeline lists key moments, anyone can mark one, and it exports as Markdown', async () => {
    const note = await analyst.post(`/api/incidents/${major}/comments`, { body: 'Root cause found: full disk on shop-vm01' });
    ok(note);
    const noteId = note.body.activity.find((a: any) => a.kind === 'comment').id;
    let t = (await analyst.get(`/api/incidents/${major}/timeline`)).body;
    assert.ok(!t.entries.some((e: any) => e.activity_id === noteId), 'a plain note is not a key moment');
    for (const label of ['Logged', 'Declared a major incident', 'Communication update', `Related incident ${child}`]) assert.ok(t.entries.some((e: any) => e.label === label), `${label} on the timeline`);
    ok(await analyst2.put(`/api/incidents/${major}/activity/${noteId}/key-moment`, { key_moment: true }));
    t = (await analyst.get(`/api/incidents/${major}/timeline`)).body;
    assert.ok(t.entries.some((e: any) => e.activity_id === noteId && e.key_moment));
    assert.equal((await viewer.put(`/api/incidents/${major}/activity/${noteId}/key-moment`, { key_moment: false })).status, 403);
    const md = await fetch(`${k.base}/api/incidents/${major}/timeline?format=md`, { headers: { Cookie: analyst.cookie! } });
    assert.match(md.headers.get('content-type') ?? '', /text\/markdown/);
    const text = await md.text();
    assert.match(text, /^# Timeline: INC\d+ Webshop down/);
    assert.match(text, /Root cause found: full disk on shop-vm01 ★/);
    const audit = (await ownerQuery("SELECT 1 FROM audit_log WHERE action = 'key_moment' AND entity_ref = $1", [major])).rows;
    assert.equal(audit.length, 1, 'marking is audited');
  });

  test('resolving the major incident resolves its children (traceably), stops the countdown and asks for the review', async () => {
    const pmId = await userId('pm');
    const r = await pm.post(`/api/incidents/${major}/transition`, { to: 'resolved', resolution_code: 'fixed', resolution: 'Cleaned the disk and restarted checkout', pir_owner_id: pmId, pir_due: '2026-11-01' });
    ok(r);
    assert.equal(r.body.major.next_update_at, null, 'no more countdown');
    assert.equal(r.body.major.pir_owner, 'Pm');
    assert.equal(r.body.major.pir_due.slice(0, 10), '2026-11-01');
    const c = (await analyst.get(`/api/incidents/${child}`)).body;
    assert.equal(c.status, 'resolved');
    assert.equal(c.resolution_code, 'fixed');
    assert.match(c.resolution, new RegExp(`^Resolved with ${major}: Cleaned the disk`));
    assert.equal((await analyst.get(`/api/incidents/${stays}`)).body.status, 'new', 'an unticked child stays open');
    const trail = (await ownerQuery("SELECT changes FROM audit_log WHERE entity_type = 'incident' AND entity_ref = $1 AND action = 'status'", [child])).rows;
    assert.equal(trail.at(-1).changes.with_parent, major, 'the child\'s audit entry says why');
    assert.deepEqual((await analyst.get('/api/my-work')).body.major_updates, [], 'a resolved incident needs no more updates');
  });

  test('review of #114: restricted text stays put, problems are inherited, services match, nobody is forgotten', async () => {
    // (5) A major on a server, a new report on the service it serves: suggested through the impact graph.
    const server = (await pm.post('/api/incidents', { title: 'shop-vm01 disk full', impact: 1, urgency: 1, cis: [vm] })).body.ref;
    ok(await pm.post(`/api/incidents/${server}/major`, {}));
    const report = (await analyst.post('/api/incidents', { title: 'Webshop is slow', cis: [svc] })).body;
    assert.equal(report.suggested_parent?.ref, server, 'matched on the affected service, not only the CI');

    // (3) The parent's problem: a child linked later inherits it, and so do children of a parent linked later.
    const prb = (await pm.post(`/api/incidents/${server}/problem`, {})).body.ref;
    ok(await analyst.post(`/api/incidents/${server}/children`, { child: report.ref }));
    assert.equal((await analyst.get(`/api/incidents/${report.ref}`)).body.problem_ref, prb, 'a child linked to a parent with a problem gets it');
    const late = (await analyst.post('/api/incidents', { title: 'Late report' })).body.ref;
    const other = (await pm.post('/api/incidents', { title: 'Other outage', impact: 1, urgency: 1 })).body.ref;
    ok(await pm.post(`/api/incidents/${other}/major`, {}));
    ok(await analyst.post(`/api/incidents/${other}/children`, { child: late }));
    const prb2 = (await pm.post(`/api/incidents/${other}/problem`, {})).body.ref;
    assert.equal((await analyst.get(`/api/incidents/${late}`)).body.problem_ref, prb2, 'and children follow a parent linked afterwards');
    assert.ok((await pm.get(`/api/problems/${prb2}`)).body.incidents.some((x: any) => x.ref === late), 'the problem counts it');

    // (1) A restricted parent's resolution is not copied into a child more people can read.
    ok(await pm.put(`/api/records/${server}/visibility`, { restricted: true, reason: 'Security investigation' }));
    ok(await pm.post(`/api/incidents/${server}/transition`, { to: 'resolved', resolution_code: 'fixed', resolution: 'Secret detail: attacker filled the disk' }));
    const child = (await analyst.get(`/api/incidents/${report.ref}`)).body;
    assert.equal(child.status, 'resolved', 'positive control: the child was resolved with it');
    assert.equal(child.resolution, `Resolved with ${server}.`);

    // (4) The parent comes back: a guide step about the children resolved with it.
    ok(await pm.post(`/api/incidents/${server}/transition`, { to: 'in_progress', comment: 'It came back' }));
    const reopened = (await pm.get(`/api/incidents/${server}`)).body;
    assert.ok(reopened.next_steps.steps.some((x: any) => x.id === 'children_reopen'));

    // (2) No lead, comms lead or assignee: the managers hear about an overdue update.
    await ownerQuery("UPDATE incidents SET major_lead_id = NULL, major_comms_id = NULL, assignee_id = NULL, major_next_update_at = now() - interval '1 minute' WHERE ref = $1", [other]);
    const { checkOverdueUpdates } = await import('../../src/major-incidents.js');
    await checkOverdueUpdates();
    const due = (await ownerQuery("SELECT u.username FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.event = 'major_update_due' AND n.ref = $1 ORDER BY 1", [other])).rows;
    assert.ok(due.some((d: any) => d.username === 'pm'), JSON.stringify(due));
  });

  test('a confidential major incident: its timeline is masked for outsiders and its resolution is not copied', async () => {
    const SECRET = 'Payroll export leaked via shared folder';
    const conf = (await pm.post('/api/incidents', { title: 'Payroll outage', impact: 1, urgency: 1 })).body.ref;
    ok(await pm.post(`/api/incidents/${conf}/major`, {}));
    ok(await pm.post(`/api/incidents/${conf}/communications`, { body: `Update: ${SECRET}` }));
    ok(await pm.put(`/api/records/${conf}/classification`, { classification: 'confidential', reason: 'Personal data' }));
    const kid = (await analyst2.post('/api/incidents', { title: 'Cannot see my payslip' })).body.ref;
    ok(await analyst2.post(`/api/incidents/${conf}/children`, { child: kid }));
    const md = async (c: Client) => (await fetch(`${k.base}/api/incidents/${conf}/timeline?format=md`, { headers: { Cookie: c.cookie! } })).text();
    assert.ok((await md(pm)).includes(SECRET), 'positive control: the creator reads the timeline in full');
    const outside = await md(analyst2);
    assert.equal(outside.includes(SECRET), false, 'the Markdown export is masked for someone outside the record');
    assert.match(outside, /Confidential: notes, updates and the resolution are not included/);
    assert.equal(JSON.stringify((await analyst2.get(`/api/incidents/${conf}/timeline`)).body).includes(SECRET), false);
    ok(await pm.post(`/api/incidents/${conf}/transition`, { to: 'resolved', resolution_code: 'fixed', resolution: `Closed the share. ${SECRET}` }));
    const child = (await analyst2.get(`/api/incidents/${kid}`)).body;
    assert.equal(child.status, 'resolved');
    assert.equal(child.resolution, `Resolved with ${conf}.`, 'only the reference reaches the ordinary child');
  });

  test('agents have the same contract (MCP)', async () => {
    const mcp = new McpClient({ name: 'major', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('pm')}` } } }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const res: any = await mcp.callTool({ name, arguments: args });
      assert.ok(!res.isError, res.content[0].text);
      return JSON.parse(res.content[0].text);
    };
    const ref = (await pm.post('/api/incidents', { title: 'Mail outage', impact: 1, urgency: 2 })).body.ref;
    const other = (await pm.post('/api/incidents', { title: 'No mail for sales' })).body.ref;
    const d = await call('declare_major', { ref, comms_lead: 'analyst', bridge: 'https://meet.example.com/mail' });
    assert.equal(d.major.comms_lead, 'Analyst');
    assert.equal(d.major.update_minutes, 60, 'P2 default');
    await call('post_communication', { ref, body: 'Mail is delayed; we are failing over.' });
    const l = await call('link_child_incident', { ref, child: other });
    assert.deepEqual(l.related_incidents.map((c: any) => c.ref), [other]);
    const t = await call('get_incident_timeline', { ref });
    assert.ok(t.entries.some((e: any) => e.kind === 'communication'));
    assert.ok(t.entries.some((e: any) => e.label_untrusted === `Related incident ${other}`));
    await mcp.close();
  });
});
