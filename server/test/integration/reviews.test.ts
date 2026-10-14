import assert from 'node:assert/strict';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { after, before, describe, test } from 'node:test';
import { ownerQuery, skip, startKernel, type Client, type Harness } from './harness.js';

const ok = (r: { status: number; body: unknown }) => assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);
const userId = async (username: string) => (await ownerQuery('SELECT id FROM users WHERE username = $1', [username])).rows[0].id as number;

describe('post-incident reviews (#109)', { skip }, () => {
  let k: Harness;
  let pm: Client, analyst: Client, analyst2: Client;
  let inc = '', factorProblem = '';

  before(async () => {
    k = await startKernel();
    [pm, analyst, analyst2] = await Promise.all([k.login('pm'), k.login('analyst'), k.login('analyst2')]);
    const svc = (await pm.post('/api/cis', { name: 'Webshop', ci_type: 'business_service', criticality: 1 })).body.ref;
    const vm = (await pm.post('/api/cis', { name: 'pay-gw01', ci_type: 'virtual_machine' })).body.ref;
    ok(await pm.post(`/api/cis/${vm}/relationships`, { type: 'member_of', target: svc }));
    inc = (await analyst.post('/api/incidents', { title: 'Checkout down', impact: 1, urgency: 1, cis: [vm] })).body.ref;
    ok(await pm.post(`/api/incidents/${inc}/major`, { lead_id: await userId('analyst') }));
    ok(await analyst.post(`/api/incidents/${inc}/communications`, { body: 'Checkout is down; failing over.' }));
  });
  after(async () => k?.close());

  test('a resolved major incident shows "review due in N days"; opening it shows the timeline and impact filled in', async () => {
    const r = await analyst.post(`/api/incidents/${inc}/transition`, { to: 'resolved', resolution_code: 'fixed', resolution: 'Renewed the gateway certificate' });
    ok(r);
    assert.equal(r.body.review.status, 'scheduled');
    assert.equal(r.body.review.owner, 'Analyst', 'the incident lead owns it by default');
    assert.ok(r.body.review.due_in_days >= 5 && r.body.review.due_in_days <= 9, `five working days, got ${r.body.review.due_in_days}`);
    const step = r.body.next_steps.steps.find((s: any) => s.id === 'review');
    assert.match(step.label, /^Post-incident review due in \d+ days$/);
    const review = (await analyst.get(`/api/incidents/${inc}/review`)).body;
    assert.match(review.what_happened, /Declared a major incident/);
    assert.match(review.what_happened, /Communication update: Checkout is down/);
    assert.match(review.impact_summary, /Services: Webshop/);
    assert.match(review.impact_summary, /Duration: /);
    assert.ok(review.context.timeline.length >= 3);
    assert.match(review.guide.wording, /not people/);
  });

  test('closing waits for the review; only a manager waives, with a reason, audited', async () => {
    ok(await pm.post(`/api/incidents/${inc}/problem`, {}));
    const closing = await analyst.post(`/api/incidents/${inc}/transition`, { to: 'closed' });
    assert.equal(closing.status, 409);
    assert.match(closing.body.error, /post-incident review/);
    assert.equal((await analyst.post(`/api/incidents/${inc}/review/waive`, { reason: 'Small blip, nothing to learn' })).status, 403);
    assert.equal((await pm.post(`/api/incidents/${inc}/review/waive`, { reason: '' })).status, 400);
  });

  test('a contributing factor becomes a linked problem in one click, which shows "from the PIR of INC…"', async () => {
    let r = (await analyst.post(`/api/incidents/${inc}/review/items`, { kind: 'factor', body: 'Certificate expiry is not monitored' })).body;
    assert.equal(r.status, 'draft', 'the first contribution makes it a draft');
    const factor = r.items.find((x: any) => x.kind === 'factor');
    r = (await analyst.post(`/api/incidents/${inc}/review/items/${factor.id}/problem`, {})).body;
    factorProblem = r.items.find((x: any) => x.id === factor.id).problem_ref;
    assert.match(factorProblem, /^PRB/);
    const p = (await analyst.get(`/api/problems/${factorProblem}`)).body;
    assert.equal(p.title, 'Certificate expiry is not monitored');
    assert.deepEqual(p.from_reviews.map((x: any) => x.incident_ref), [inc]);
    assert.ok(p.links.some((l: any) => l.kind === 'incident' && l.reference === inc));
    assert.equal((await analyst.post(`/api/incidents/${inc}/review/items/${factor.id}/problem`, {})).status, 409, 'once');
  });

  test("a follow-up becomes an action with owner and due date on the factor's problem", async () => {
    let r = (await analyst.post(`/api/incidents/${inc}/review/items`, { kind: 'follow_up', body: 'Alert 30 days before any certificate expires' })).body;
    const item = r.items.find((x: any) => x.kind === 'follow_up');
    const owner = await userId('analyst2');
    r = (await analyst.post(`/api/incidents/${inc}/review/items/${item.id}/action`, { owner_id: owner, due_date: '2026-12-01' })).body;
    const done = r.items.find((x: any) => x.id === item.id);
    assert.equal(done.action_problem_ref, factorProblem);
    assert.equal(done.action_owner, 'Analyst2');
    const work = (await analyst2.get('/api/my-work')).body;
    assert.ok(work.actions.some((a: any) => a.title === 'Alert 30 days before any certificate expires' && a.due_date === '2026-12-01'));
    assert.equal((await analyst.del(`/api/incidents/${inc}/review/items/${item.id}`)).status, 409, 'an item that became an action stays');
  });

  test('My work shows my open reviews, overdue first; publishing takes the owner, lead or a manager', async () => {
    await ownerQuery("UPDATE incident_reviews SET due = current_date - 1 WHERE incident_id = (SELECT id FROM incidents WHERE ref = $1)", [inc]);
    const mine = (await analyst.get('/api/my-work')).body.reviews;
    assert.deepEqual(mine.map((x: any) => [x.ref, x.overdue]), [[inc, true]]);
    assert.deepEqual((await analyst2.get('/api/my-work')).body.reviews, [], 'positive control: only the owner');
    assert.equal((await analyst2.post(`/api/incidents/${inc}/review/publish`, {})).status, 403);
    ok(await analyst.patch(`/api/incidents/${inc}/review`, { went_well: 'Failover worked within minutes.', attendees: 'Analyst, Pm' }));
    const pub = await analyst.post(`/api/incidents/${inc}/review/publish`, {});
    ok(pub);
    assert.equal(pub.body.status, 'published');
    assert.equal((await analyst.patch(`/api/incidents/${inc}/review`, { lucky: 'x' })).status, 409, 'read-only once published');
    ok(await analyst.post(`/api/incidents/${inc}/transition`, { to: 'closed' }));
    const md = await (await fetch(`${k.base}/api/incidents/${inc}/review/export.md`, { headers: { Cookie: analyst.cookie! } })).text();
    assert.match(md, /^# Post-incident review: INC\d+ Checkout down/);
    assert.match(md, /- Certificate expiry is not monitored → PRB\d+/);
    assert.match(md, /Failover worked within minutes/);
  });

  test('reports show the share of major incidents with a published review; lessons become a draft article', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const rep = (await pm.get(`/api/reports?from=${today}&to=${today}`)).body;
    assert.deepEqual({ ...rep.incidents.reviews, median_days_to_review: undefined }, { major_resolved: 1, reviewed: 1, waived: 0, reviewed_share: 100, median_days_to_review: undefined });
    const a = await analyst.post(`/api/incidents/${inc}/review/article`, {});
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(a.body.status, 'draft');
    assert.match(a.body.body, /## Contributing factors\n\n- Certificate expiry is not monitored/);
  });

  test('any incident can have a review; waiving one is audited', async () => {
    const small = (await analyst.post('/api/incidents', { title: 'VPN flapped' })).body.ref;
    const created = await analyst.post(`/api/incidents/${small}/review`, {});
    assert.equal(created.status, 201);
    assert.equal((await analyst.post(`/api/incidents/${small}/review`, {})).status, 409);
    ok(await pm.post(`/api/incidents/${small}/review/waive`, { reason: 'Known flapping link, covered by PRB' }));
    const trail = (await ownerQuery("SELECT changes FROM audit_log WHERE entity_ref = $1 AND entity_type = 'incident' ORDER BY id DESC LIMIT 1", [small])).rows[0].changes;
    assert.equal(trail.review.status.to, 'waived', 'audited (the reason itself is kept as a digest, like all free text)');
    assert.equal((await analyst.get(`/api/incidents/${small}/review`)).body.waived_reason, 'Known flapping link, covered by PRB');
  });

  test('a confidential incident: the review text is masked for outsiders', async () => {
    const SECRET = 'Payroll file shared with the wrong group';
    const conf = (await pm.post('/api/incidents', { title: 'Payroll access', description: SECRET })).body.ref;
    ok(await pm.post(`/api/incidents/${conf}/review`, {}));
    ok(await pm.patch(`/api/incidents/${conf}/review`, { went_well: SECRET }));
    ok(await pm.put(`/api/records/${conf}/classification`, { classification: 'confidential', reason: 'Personal data' }));
    assert.equal((await pm.get(`/api/incidents/${conf}/review`)).body.went_well, SECRET, 'positive control: the creator reads it');
    const outside = await analyst2.get(`/api/incidents/${conf}/review`);
    assert.equal(JSON.stringify(outside.body).includes(SECRET), false);
    const md = await (await fetch(`${k.base}/api/incidents/${conf}/review/export.md`, { headers: { Cookie: analyst2.cookie! } })).text();
    assert.equal(md.includes(SECRET), false);
  });

  test('agents draft and contribute over MCP', async () => {
    const mcp = new McpClient({ name: 'reviews', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const res: any = await mcp.callTool({ name, arguments: args });
      assert.ok(!res.isError, res.content[0].text);
      return JSON.parse(res.content[0].text);
    };
    const ref = (await analyst.post('/api/incidents', { title: 'Mail delayed' })).body.ref;
    let r = await call('create_review', { ref });
    assert.equal(r.status, 'scheduled');
    r = await call('update_review', { ref, was_hard: 'The queue metrics were not on a dashboard.' });
    assert.equal(r.status, 'draft');
    r = await call('add_review_item', { ref, kind: 'gap', body: 'No alert on queue depth' });
    assert.equal(r.items[0].kind, 'gap');
    assert.equal(r.untrusted_content.items[r.items[0].id], 'No alert on queue depth');
    await mcp.close();
  });
});
