import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ownerQuery, skip, startKernel, type Client, type Harness } from './harness.js';

const ok = (r: { status: number; body: unknown }) => assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);
const ROUTING_KEY = 'R0UTINGKEY0123456789abcdefABCDEF';
const API_TOKEN = 'pd-api-token-0123456789';
const GENIE_KEY = 'genie-key-0123456789abcdef';

/** PagerDuty (events + on-call API) and Opsgenie in one fake TLS server. */
function fakeTools(cert: string, key: string) {
  const state = { received: [] as { path: string; headers: any; body: any }[], fail: false, oncallDown: false };
  const server: Server = createServer({ cert, key }, async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url!, 'https://x');
    const json = (v: unknown, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(v));
    if (req.method === 'POST') state.received.push({ path: url.pathname + url.search, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    if (state.fail && req.method === 'POST') return json({ error: 'down' }, 503);
    if (url.pathname === '/hook') return json({ ok: true });
    if (url.pathname === '/v2/enqueue') return json({ status: 'success', dedup_key: JSON.parse(raw).dedup_key }, 202);
    if (url.pathname === '/oncalls') {
      if (state.oncallDown) return json({}, 500);
      if (req.headers.authorization !== `Token token=${API_TOKEN}`) return json({}, 401);
      return json({ oncalls: [{ escalation_level: 1, user: { summary: 'Nora Network' }, end: '2030-01-01T08:00:00Z' }, { escalation_level: 2, user: { summary: 'Backup Bob' } }] });
    }
    if (url.pathname.startsWith('/v2/alerts')) return json({ result: 'Request will be processed' }, 202);
    if (url.pathname.startsWith('/v2/schedules/')) return state.oncallDown ? json({}, 500) : json({ data: { onCallRecipients: ['dba@example.com'] } });
    return json({}, 404);
  });
  return { server, state, listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as any).port))) };
}

describe('on-call and paging (#111)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client, analyst2: Client;
  let tools: ReturnType<typeof fakeTools>;
  let ca = '', base = '';
  let network = 0, dba = 0, rota = 0, inboundToken = '', targetId = 0, router = '';
  const dir = mkdtempSync(join(tmpdir(), 'oncall-'));
  const deliver = async () => (await import('../../src/oncall.js')).deliverPages();
  const userId = async (u: string) => (await ownerQuery('SELECT id FROM users WHERE username = $1', [u])).rows[0].id as number;

  before(async () => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k'), '-out', join(dir, 'c'), '-days', '1', '-subj', '/CN=tools', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    ca = readFileSync(join(dir, 'c'), 'utf8');
    tools = fakeTools(ca, readFileSync(join(dir, 'k'), 'utf8'));
    base = `https://127.0.0.1:${await tools.listen()}`;
    process.env.KERNEL_SECRET_KEY = 'oncall-test-key-0123456789abcdef0123';
    process.env.KERNEL_OUTBOUND_ALLOW = '127.0.0.1';
    k = await startKernel();
    [admin, pm, analyst, analyst2] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst'), k.login('analyst2')]);
    router = (await pm.post('/api/cis', { name: 'core-router-1', ci_type: 'network_device', criticality: 1 })).body.ref;
    network = (await admin.post('/api/teams', { name: 'Network', description: '', email: '', auto_assign: 'none', active: true, cis: [router] })).body.id;
    ok(await admin.put(`/api/teams/${network}/members`, { members: [{ user_id: await userId('analyst'), role: 'lead' }] }));
    dba = (await admin.post('/api/teams', { name: 'DBA', description: '', email: '', auto_assign: 'none', active: true })).body.id;
    rota = (await admin.post('/api/teams', { name: 'Desktop', description: '', email: '', auto_assign: 'none', active: true })).body.id;
    ok(await admin.put(`/api/teams/${rota}/members`, { members: [{ user_id: await userId('analyst2'), role: 'lead' }, { user_id: await userId('pm'), role: 'member' }] }));
  });
  after(async () => {
    delete process.env.KERNEL_SECRET_KEY;
    delete process.env.KERNEL_OUTBOUND_ALLOW;
    tools?.server.close();
    rmSync(dir, { recursive: true, force: true });
    await k?.close();
  });

  test('administrators set a paging target; credentials and the inbound token are write-only', async () => {
    const body = { kind: 'pagerduty', config: { events_url: base, api_url: base, escalation_policy_id: 'PNET', ca_pem: ca }, secret: { routing_key: ROUTING_KEY, api_token: API_TOKEN }, rule: { priorities: [1, 2], major: true, services: [], hours: 'always' } };
    assert.equal((await analyst.put(`/api/teams/${network}/paging`, body)).status, 403, 'not even the team lead sets credentials');
    assert.equal((await admin.put(`/api/teams/${network}/paging`, { ...body, secret: undefined })).status, 400, 'a new target needs its credentials');
    const saved = await admin.put(`/api/teams/${network}/paging`, body);
    ok(saved);
    inboundToken = saved.body.inbound_token;
    targetId = saved.body.id;
    assert.match(inboundToken, /^kpg_/);
    const read = JSON.stringify((await analyst.get(`/api/teams/${network}/paging`)).body);
    for (const s of [ROUTING_KEY, API_TOKEN, inboundToken]) assert.equal(read.includes(s), false, 'never returned');
    const resaved = await admin.put(`/api/teams/${network}/paging`, { ...body, secret: undefined });
    ok(resaved);
    assert.equal(resaved.body.inbound_token, undefined, 'the token is shown once');
    const trail = JSON.stringify((await ownerQuery("SELECT changes FROM audit_log WHERE action = 'paging'")).rows);
    assert.equal(trail.includes(ROUTING_KEY), false);
  });

  test('an event-created P1 for team Network triggers a PagerDuty incident, with the ref as dedup key', async () => {
    ok(await pm.post('/api/event-rules', { name: 'Critical network', conditions: { min_severity: 'critical' }, impact: 1, urgency: 1, team_id: network, group_by: 'ci' }));
    const r = await analyst.post('/api/events', { source: 'Zabbix', events: [{ host: 'core-router-1', check: 'ICMP', severity: 'critical', message: 'unreachable' }] });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const { rows } = await ownerQuery("SELECT ref FROM incidents WHERE source = 'event' ORDER BY id DESC LIMIT 1");
    const ref = rows[0].ref;
    await deliver();
    const sent = tools.state.received.filter((x) => x.path === '/v2/enqueue');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.event_action, 'trigger');
    assert.equal(sent[0].body.dedup_key, ref);
    assert.equal(sent[0].body.routing_key, ROUTING_KEY);
    assert.equal(sent[0].body.payload.severity, 'critical');
    const inc = (await analyst.get(`/api/incidents/${ref}`)).body;
    assert.equal(inc.pages[0].status, 'sent', 'visible on the incident');
    assert.ok(inc.activity.some((a: any) => a.body === 'Paged Network via PagerDuty (P1)'));
    assert.ok((await ownerQuery("SELECT 1 FROM audit_log WHERE action = 'page' AND entity_ref = $1", [ref])).rows[0], 'audited');
    await deliver();
    assert.equal(tools.state.received.filter((x) => x.path === '/v2/enqueue').length, 1, 'paged once');
  });

  test('acknowledging in PagerDuty shows on the incident and stops the response clock', async () => {
    const { rows } = await ownerQuery("SELECT ref FROM incidents WHERE source = 'event' ORDER BY id DESC LIMIT 1");
    const ref = rows[0].ref;
    assert.equal((await fetch(`${k.base}/api/paging/${targetId}/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' }, body: '{}' })).status, 403);
    const res = await fetch(`${k.base}/api/paging/${targetId}/inbound`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${inboundToken}` },
      body: JSON.stringify({ event: { event_type: 'incident.acknowledged', agent: { summary: 'Nora Network' }, data: { title: `${ref}: core-router-1 ICMP` } } }),
    });
    assert.equal(res.status, 202);
    assert.equal((await res.json()).first_response, true);
    const inc = (await analyst.get(`/api/incidents/${ref}`)).body;
    assert.ok(inc.responded_at, 'the first response');
    assert.ok(inc.activity.some((a: any) => a.body === 'Acknowledged in PagerDuty by Nora Network'));
    if (inc.sla) assert.equal(inc.sla.response.state, 'met', 'the response clock stopped');
    // The token belongs in a header: in the URL it would land in request logs.
    assert.equal((await fetch(`${k.base}/api/paging/${targetId}/inbound?token=${inboundToken}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref, action: 'ack' }) })).status, 403);
    // Kernel does not acknowledge it back, and resolving in Kernel resolves the page.
    ok(await analyst.post(`/api/incidents/${ref}/transition`, { to: 'resolved', resolution_code: 'fixed', resolution: 'Replaced the line card' }));
    await deliver();
    assert.deepEqual(tools.state.received.filter((x) => x.path === '/v2/enqueue').map((x) => x.body.event_action), ['trigger', 'resolve']);
  });

  test("a target only speaks for incidents it paged: team A's token cannot acknowledge team B's incident", async () => {
    ok(await admin.put(`/api/teams/${dba}/paging`, { kind: 'webhook', config: { url: `${base}/hook`, ca_pem: ca }, secret: { signing_secret: 'whsec_dGVzdC1zaWduaW5nLXNlY3JldC0xMjM0NTY3OA==' }, rule: { priorities: [1], major: true, services: [], hours: 'always' } }));
    const other = (await analyst.post('/api/incidents', { title: 'DBA disk full', impact: 1, urgency: 1, team_id: dba })).body.ref;
    await deliver();
    const res = await fetch(`${k.base}/api/paging/${targetId}/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${inboundToken}` }, body: JSON.stringify({ ref: other, action: 'acknowledge', by: 'mallory' }) });
    assert.equal(res.status, 202);
    assert.equal((await res.json()).accepted, false);
    const inc = (await analyst.get(`/api/incidents/${other}`)).body;
    assert.equal(inc.responded_at, null, 'the SLA clock was not touched');
    assert.equal(inc.activity.some((a: any) => /mallory/.test(a.body)), false);
    // Also not by mentioning it in the text next to a ref the target did page.
    const mine = (await ownerQuery("SELECT i.ref FROM incidents i JOIN pages p ON p.incident_id = i.id WHERE p.target_id = $1 AND p.action = 'trigger' ORDER BY i.id DESC LIMIT 1", [targetId])).rows[0].ref;
    const mixed = await (await fetch(`${k.base}/api/paging/${targetId}/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${inboundToken}` }, body: JSON.stringify({ note: `${other} and ${mine}`, action: 'ack' }) })).json();
    assert.equal(mixed.ref, mine, 'only the incident this target paged');
  });

  test('PagerDuty webhooks are verified by their signature', async () => {
    const SIGNING = 'pd-webhook-signing-secret';
    ok(await admin.put(`/api/teams/${network}/paging`, { kind: 'pagerduty', config: { events_url: base, api_url: base, escalation_policy_id: 'PNET', ca_pem: ca }, secret: { routing_key: ROUTING_KEY, api_token: API_TOKEN, webhook_secret: SIGNING }, rule: { priorities: [1, 2], major: true, services: [], hours: 'always' } }));
    const ref = (await analyst.post('/api/incidents', { title: 'BGP session down', impact: 1, urgency: 1, team_id: network })).body.ref;
    await deliver();
    const body = JSON.stringify({ event: { event_type: 'incident.acknowledged', agent: { summary: 'Nora Network' }, data: { title: `${ref}: BGP` } } });
    const { createHmac } = await import('node:crypto');
    const post = (sig: string) => fetch(`${k.base}/api/paging/${targetId}/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PagerDuty-Signature': sig }, body });
    assert.equal((await post('v1=' + 'a'.repeat(64))).status, 403, 'a wrong signature');
    const good = await post(`v1=deadbeef, v1=${createHmac('sha256', SIGNING).update(body).digest('hex')}`);
    assert.equal(good.status, 202);
    assert.equal((await good.json()).accepted, true);
  });

  test('moving an incident to another team resolves the page in the old team\'s tool', async () => {
    const ref = (await analyst.post('/api/incidents', { title: 'Latency on the WAN', impact: 1, urgency: 1, team_id: network })).body.ref;
    await deliver();
    ok(await analyst.patch(`/api/incidents/${ref}`, { team_id: dba }));
    await deliver();
    const pd = tools.state.received.filter((x) => x.path === '/v2/enqueue' && x.body.dedup_key === ref).map((x) => x.body.event_action);
    assert.deepEqual(pd, ['trigger', 'resolve'], 'the old page is resolved');
    const hook = tools.state.received.filter((x) => x.path === '/hook' && x.body.incident.ref === ref).map((x) => x.body.type);
    assert.deepEqual(hook, ['page.trigger'], 'and the new team is paged');
    assert.ok((await analyst.get(`/api/incidents/${ref}`)).body.pages.some((p: any) => p.action === 'resolve' && p.reason === 'moved to DBA'));
  });

  test('responding in Kernel acknowledges the page; the rule decides what pages', async () => {
    const before = tools.state.received.length;
    const quiet = (await analyst.post('/api/incidents', { title: 'Port flapping', impact: 3, urgency: 3, team_id: network })).body.ref;
    await deliver();
    assert.equal(tools.state.received.length, before, 'P5 does not page');
    ok(await pm.post(`/api/incidents/${quiet}/major`, {}));
    await deliver();
    assert.equal(tools.state.received.at(-1)!.body.event_action, 'trigger', 'a declared major incident pages whatever its priority');
    ok(await analyst.post(`/api/incidents/${quiet}/transition`, { to: 'in_progress' }));
    await deliver();
    const last = tools.state.received.at(-1)!.body;
    assert.deepEqual([last.event_action, last.dedup_key], ['acknowledge', quiet]);
  });

  test('a restricted incident leaves Kernel as its ref only', async () => {
    const ref = (await analyst.post('/api/incidents', { title: 'Breach on the edge firewall', impact: 1, urgency: 1, team_id: network })).body.ref;
    ok(await analyst.put(`/api/records/${ref}/visibility`, { restricted: true, teams: [network], reason: 'Security investigation' }));
    await deliver();
    const sent = tools.state.received.filter((x) => x.body?.dedup_key === ref);
    assert.equal(sent.length, 1);
    assert.equal(JSON.stringify(sent[0].body).includes('firewall'), false);
    assert.match(sent[0].body.payload.summary, /restricted incident/);
    // The tool's acknowledgement reaches the restricted incident (the target is the authority, not a user).
    const ack = await (await fetch(`${k.base}/api/paging/${targetId}/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${inboundToken}` }, body: JSON.stringify({ ref, action: 'acknowledge', by: 'Nora' }) })).json();
    assert.equal(ack.accepted, true);
  });

  test('a bulk change pages each target once, and the tool answers for every incident on that page (#125)', async () => {
    const refs: string[] = [];
    for (let n = 0; n < 5; n++) refs.push((await analyst.post('/api/incidents', { title: `Branch office ${n} offline`, impact: 3, urgency: 3, team_id: network })).body.ref);
    await deliver();
    const enqueued = (from: number) => tools.state.received.slice(from).filter((x) => x.path === '/v2/enqueue').map((x) => x.body);
    const before = tools.state.received.length;
    const raised = await analyst.post('/api/incidents/bulk', { ids: refs, operation: { op: 'priority', impact: 1, urgency: 1 }, confirm_paging: true });
    ok(raised);
    const key = `bulk:${raised.body.request_id}`;
    await deliver();
    const sent = enqueued(before);
    assert.equal(sent.length, 1, 'one page for the team, not five');
    assert.deepEqual([sent[0].event_action, sent[0].dedup_key], ['trigger', key]);
    assert.match(sent[0].payload.summary, new RegExp(`^5 incidents \\(P1\\) after a bulk change by Analyst: ${refs.slice(0, 3).join(', ')} \\(\\+2\\)$`));
    assert.deepEqual(sent[0].payload.custom_details.incidents, refs);
    assert.match(sent[0].links[0].href, new RegExp(`/incidents\\?bulk=${raised.body.request_id}&status=all$`));
    for (const ref of refs) {
      const inc = (await analyst.get(`/api/incidents/${ref}`)).body;
      assert.ok(inc.activity.some((a: any) => a.body === 'Paged Network via PagerDuty in one page for 5 incidents (P1)'), `${ref} shows the page`);
    }
    // PagerDuty's webhook names the page by its title; the acknowledgement reaches all five incidents.
    const res = await fetch(`${k.base}/api/paging/${targetId}/inbound`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${inboundToken}` },
      body: JSON.stringify({ event: { event_type: 'incident.acknowledged', agent: { summary: 'Nora Network' }, data: { title: sent[0].payload.summary } } }),
    });
    assert.equal(res.status, 202);
    assert.deepEqual((await res.json()).refs, refs);
    for (const ref of refs) assert.ok((await analyst.get(`/api/incidents/${ref}`)).body.responded_at, `${ref} has its first response`);
    // The page is resolved when the last incident on it is.
    const resolve = (ref: string) => analyst.post(`/api/incidents/${ref}/transition`, { to: 'resolved', resolution_code: 'fixed', resolution: 'Line restored' });
    for (const ref of refs.slice(0, 4)) ok(await resolve(ref));
    await deliver();
    assert.equal(enqueued(before).length, 1, 'still open while one incident is');
    ok(await resolve(refs[4]));
    await deliver();
    assert.deepEqual(enqueued(before).map((b) => [b.event_action, b.dedup_key]), [['trigger', key], ['resolve', key]]);
  });

  test('who is on call: from PagerDuty, from the rotation, and never stale names', async () => {
    let calls = (await analyst.get('/api/on-call')).body;
    const net = calls.find((c: any) => c.team_id === network);
    assert.deepEqual(net.people, [{ name: 'Nora Network', until: '2030-01-01T08:00:00Z' }], 'level 1 only');
    // The rotation: two members, weekly; an override wins.
    ok(await admin.put(`/api/teams/${rota}/paging`, { kind: 'rotation' }));
    ok(await analyst2.put(`/api/teams/${rota}/rotation`, { members: [await userId('analyst2'), await userId('pm')], handover_dow: 1, handover_minute: 540, timezone: 'Europe/Stockholm' }));
    calls = (await analyst.get(`/api/on-call?team=${rota}`)).body;
    assert.equal(calls[0].source, 'rotation');
    assert.equal(calls[0].people.length, 1);
    ok(await pm.post(`/api/teams/${rota}/rotation/overrides`, { user_id: await userId('pm'), starts_at: new Date(Date.now() - 60_000).toISOString(), ends_at: new Date(Date.now() + 3600_000).toISOString(), reason: 'Swap' }));
    calls = (await analyst.get(`/api/on-call?team=${rota}`)).body;
    assert.equal(calls[0].people[0].name, 'Pm', 'the override wins');
    assert.equal((await pm.post(`/api/teams/${rota}/rotation/overrides`, { user_id: await userId('analyst2'), starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 3600_000).toISOString() })).status, 403, 'only the lead gives someone else a shift');
  });

  test('the rotation pages its person in Kernel; a failing tool is retried, then the lead is told', async () => {
    const ref = (await analyst.post('/api/incidents', { title: 'All printers offline', impact: 1, urgency: 1, team_id: rota })).body.ref;
    await deliver();
    const paged = (await ownerQuery("SELECT u.username FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.event = 'paged' AND n.ref = $1", [ref])).rows;
    assert.deepEqual(paged.map((p: any) => p.username), ['pm'], 'the person on call (the override) is paged');
    // A tool that keeps failing.
    tools.state.fail = true;
    const failing = (await analyst.post('/api/incidents', { title: 'Core switch down', impact: 1, urgency: 1, team_id: network })).body.ref;
    for (let n = 0; n < 5; n++) {
      await ownerQuery("UPDATE pages SET next_attempt_at = now() WHERE status = 'queued'");
      await deliver();
    }
    tools.state.fail = false;
    const page = (await ownerQuery("SELECT p.status, p.attempts, p.error FROM pages p JOIN incidents i ON i.id = p.incident_id WHERE i.ref = $1", [failing])).rows[0];
    assert.deepEqual([page.status, page.attempts, page.error], ['failed', 5, 'HTTP 503']);
    const told = (await ownerQuery("SELECT u.username FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.event = 'paged' AND n.ref = $1", [failing])).rows;
    assert.deepEqual(told.map((t: any) => t.username), ['analyst'], 'the team lead hears that nobody was woken');
    assert.ok((await analyst.get(`/api/incidents/${failing}`)).body.activity.some((a: any) => /^Paging Network via PagerDuty failed: HTTP 503/.test(a.body)));
  });

  test('Opsgenie: an alert with the ref as alias, closed by alias; an unreachable tool is said to be so', async () => {
    ok(await admin.put(`/api/teams/${dba}/paging`, { kind: 'opsgenie', config: { api_url: base, schedule_id: 'dba-schedule', ca_pem: ca }, secret: { api_key: GENIE_KEY }, rule: { priorities: [1], major: true, services: [], hours: 'always' } }));
    tools.state.oncallDown = true;
    const down = (await analyst.get(`/api/on-call?team=${dba}`)).body[0];
    assert.deepEqual(down.people, [], 'no names while the tool cannot be reached');
    assert.match(down.unavailable, /^Opsgenie could not be reached/);
    tools.state.oncallDown = false;
    const ref = (await analyst.post('/api/incidents', { title: 'Replication stopped', impact: 1, urgency: 1, team_id: dba })).body.ref;
    await deliver();
    ok(await analyst.post(`/api/incidents/${ref}/transition`, { to: 'resolved', resolution_code: 'fixed', resolution: 'Restarted replication' }));
    await deliver();
    const og = tools.state.received.filter((x) => x.path.startsWith('/v2/alerts'));
    assert.equal(og[0].body.alias, ref);
    assert.equal(og[0].headers.authorization, `GenieKey ${GENIE_KEY}`);
    assert.equal(og.at(-1)!.path, `/v2/alerts/${ref}/close?identifierType=alias`);
    assert.deepEqual((await analyst.get(`/api/on-call?team=${dba}`)).body[0].people, [{ name: 'dba@example.com', until: null }]);
  });

  test('agents see who is on call (MCP)', async () => {
    const { Client: McpClient } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const mcp = new McpClient({ name: 'oncall', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    const res: any = await mcp.callTool({ name: 'get_on_call', arguments: { team_id: network } });
    assert.match(res.content[0].text, /Nora Network/);
    await mcp.close();
  });
});
