import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client, skip, startKernel, type Harness } from './harness.js';

describe('service levels (#43)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client, viewer: Client;
  let sla: typeof import('../../src/reporting/sla.js');
  let db: typeof import('../../src/core/db.js');
  const id = async (ref: string) => (await db.query('SELECT id FROM incidents WHERE ref = $1', [ref])).rows[0].id as number;
  /** Moves an incident's clock into the past by shifting its timestamps. */
  const age = async (ref: string, minutes: number) => {
    await db.query("UPDATE incidents SET created_at = created_at - $2 * interval '1 minute' WHERE ref = $1", [ref, minutes]);
    await sla.recomputeSla(db.pool, await id(ref));
  };

  before(async () => {
    k = await startKernel();
    [admin, pm, analyst, viewer] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst'), k.login('viewer')]);
    sla = await import('../../src/reporting/sla.js');
    db = await import('../../src/core/db.js');
  });
  after(() => k?.close());

  test('incidents get the default SLA; a service on the CMDB path brings its own', async () => {
    const i = (await analyst.post('/api/incidents', { title: 'Printer offline', impact: 3, urgency: 2 })).body;
    assert.deepEqual([i.sla.name, i.priority, i.sla.response.target_minutes, i.sla.resolution.target_minutes], ['Standard', 4, 480, 7200]);
    assert.equal(i.sla.resolution.state, 'on_track');
    const cal = (await viewer.get('/api/calendars')).body.find((c: any) => c.name === 'Office hours (Sweden)');
    assert.equal((await pm.post('/api/slas', { name: 'x', calendar_id: cal.id, response_minutes: { 9: 1 } })).status, 400);
    const gold = (await pm.post('/api/slas', { name: 'Gold', calendar_id: (await viewer.get('/api/calendars')).body[0].id, response_minutes: { 1: 5, 2: 10, 3: 30, 4: 60, 5: 120 }, resolution_minutes: { 1: 60, 2: 120, 3: 480, 4: 960, 5: 2880 } })).body;
    assert.equal((await analyst.post('/api/slas', { name: 'y', calendar_id: cal.id })).status, 403);
    const svc = (await pm.post('/api/cis', { name: 'Trading', ci_type: 'business_service', sla_id: gold.id, in_catalogue: true, how_to_get_help: 'Call the trading desk' })).body.ref;
    const vm = (await pm.post('/api/cis', { name: 'trade-vm', ci_type: 'virtual_machine' })).body.ref;
    await pm.post(`/api/cis/${vm}/relationships`, { type: 'member_of', target: svc });
    const t = (await analyst.post('/api/incidents', { title: 'Trades slow', impact: 3, urgency: 2, cis: [vm] })).body;
    assert.deepEqual([t.sla.name, t.sla.resolution.target_minutes], ['Gold', 960]);
    const cat = (await viewer.get('/api/service-catalogue')).body.find((s: any) => s.ref === svc);
    assert.deepEqual([cat.sla, cat.how_to_get_help, cat.in_catalogue], ['Gold', 'Call the trading desk', true]);
  });

  test('warnings and breaches fire once; pauses resume exactly; priority changes move targets with history', async () => {
    const i = (await analyst.post('/api/incidents', { title: 'Payments down', impact: 1, urgency: 1 })).body; // P1: 15 / 240
    await age(i.ref, 190);
    assert.ok((await sla.checkSlaEvents()) >= 2, 'response breached and resolution at 75 %');
    assert.equal(await sla.checkSlaEvents(), 0, 'never twice');
    let cur = (await viewer.get(`/api/incidents/${i.ref}`)).body;
    assert.deepEqual([cur.sla.response.state, cur.sla.resolution.state], ['breached', 'at_risk']);
    assert.ok(cur.response_breached_at);
    assert.ok(cur.next_steps.steps.some((s: any) => s.id === 'sla'));
    assert.ok(cur.activity.some((a: any) => a.kind === 'sla' && /at risk/.test(a.body)));
    // On hold for an hour: the resolution target moves an hour later.
    const dueBefore = new Date(cur.resolution_due_at).getTime();
    await analyst.post(`/api/incidents/${i.ref}/transition`, { to: 'on_hold', hold_reason: 'Waiting for the bank' });
    await db.query("UPDATE incidents SET sla_paused_since = sla_paused_since - interval '60 minutes' WHERE ref = $1", [i.ref]);
    assert.equal((await viewer.get(`/api/incidents/${i.ref}`)).body.sla.resolution.state, 'paused');
    cur = (await analyst.post(`/api/incidents/${i.ref}/transition`, { to: 'in_progress' })).body;
    assert.ok(Math.abs(new Date(cur.resolution_due_at).getTime() - dueBefore - 3600_000) < 120_000, 'due moved by the pause');
    assert.equal(cur.sla.response.state, 'breached', 'response is not reset');
    // Past the target: a breach, once.
    await age(i.ref, 120);
    await sla.checkSlaEvents();
    assert.equal(await sla.checkSlaEvents(), 0);
    cur = (await viewer.get(`/api/incidents/${i.ref}`)).body;
    assert.equal(cur.sla.resolution.state, 'breached');
    assert.ok((await viewer.get('/api/incidents?breaching_within=0')).body.some((x: any) => x.ref === i.ref && x.sla_state === 'breached'));
    const events = (await db.query('SELECT target, kind FROM sla_events WHERE incident_id = $1 ORDER BY target, kind', [await id(i.ref)])).rows;
    assert.deepEqual(events.map((e: any) => `${e.target}:${e.kind}`), ['resolution:breach', 'resolution:warning', 'response:breach', 'response:warning']);
    // A lower priority moves the target, and says so.
    const moved = (await analyst.patch(`/api/incidents/${i.ref}`, { urgency: 3 })).body;
    assert.ok(moved.activity.some((a: any) => a.kind === 'sla' && /Priority changed: resolution target moved/.test(a.body)));
  });

  test('a reopen resumes the resolution clock without counting the resolved time', async () => {
    const i = (await analyst.post('/api/incidents', { title: 'VPN drops', impact: 2, urgency: 2 })).body; // P3: 240 / 2880
    await analyst.post(`/api/incidents/${i.ref}/transition`, { to: 'in_progress' });
    await analyst.post(`/api/incidents/${i.ref}/transition`, { to: 'resolved', resolution_code: 'fixed', resolution: 'Restarted' });
    const resolved = (await viewer.get(`/api/incidents/${i.ref}`)).body;
    assert.equal(resolved.sla.resolution.state, 'met');
    assert.equal(resolved.sla.response.state, 'met');
    await db.query("UPDATE incidents SET sla_paused_since = sla_paused_since - interval '600 minutes' WHERE ref = $1", [i.ref]);
    const reopened = (await analyst.post(`/api/incidents/${i.ref}/transition`, { to: 'in_progress' })).body;
    assert.ok(reopened.sla_paused_minutes >= 599);
    assert.equal(reopened.sla.resolution.state, 'on_track');
  });

  test('SLA compliance in reports and SLA fields over MCP', async () => {
    const done = (await analyst.post('/api/incidents', { title: 'Quick one', impact: 3, urgency: 3 })).body;
    await analyst.post(`/api/incidents/${done.ref}/transition`, { to: 'resolved', resolution_code: 'fixed', resolution: 'Done' });
    const r = (await viewer.get('/api/reports?from=2000-01-01&to=2100-01-01')).body.sla;
    assert.ok(r.overall.resolved >= 1);
    assert.ok(r.by_priority.length >= 1);
    const mcp = new McpClient({ name: 'sla', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    const call = async (name: string, args: object) => JSON.parse(((await mcp.callTool({ name, arguments: args })) as any).content[0].text);
    const soon = await call('list_incidents', { breaching_within: 0 });
    assert.ok(soon.length >= 1 && soon.every((x: any) => x.sla_state === 'breached'));
    const one = await call('get_incident', { ref: soon[0].ref });
    assert.equal(one.sla.resolution.state, 'breached');
    assert.ok((await call('list_slas', {})).some((s: any) => s.is_default));
    await mcp.close();
    void admin;
  });
});
