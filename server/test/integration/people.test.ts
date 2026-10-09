import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client, skip, startKernel, type Harness } from './harness.js';

describe('people, organisations and affected users (#39)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client, viewer: Client;
  let svc: string, infra: string, org: number;

  before(async () => {
    process.env.KERNEL_SECRET_KEY = 'people-test-key-0123456789abcdefghijklmn';
    k = await startKernel();
    [admin, pm, analyst, viewer] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst'), k.login('viewer')]);
    svc = (await pm.post('/api/cis', { name: 'Payroll', ci_type: 'business_service', has_end_users: true })).body.ref;
    infra = (await pm.post('/api/cis', { name: 'Storage', ci_type: 'technical_service' })).body.ref;
    org = (await pm.post('/api/organisations', { name: 'Finance', services: [svc] })).body.id;
  });
  after(async () => {
    delete process.env.KERNEL_SECRET_KEY;
    await k?.close();
  });

  test('contacts need no login; organisations list the services they consume', async () => {
    assert.equal((await viewer.post('/api/people', { name: 'X' })).status, 403);
    assert.equal((await analyst.post('/api/organisations', { name: 'Sales' })).status, 403);
    const anna = (await analyst.post('/api/people', { name: 'Anna Berg', email: 'anna@example.com', department: 'Payroll team', organisation_id: org })).status;
    assert.equal(anna, 201);
    assert.equal((await analyst.post('/api/people', { name: 'Other', email: 'ANNA@example.com' })).status, 409);
    const found = (await viewer.get('/api/people?q=berg')).body;
    assert.equal(found[0].organisation, 'Finance');
    assert.equal(found[0].email, undefined, 'viewers see who a person is, not how to reach them');
    assert.equal((await analyst.get('/api/people?q=berg')).body[0].email, 'anna@example.com');
    assert.equal((await analyst.patch(`/api/people/${found[0].id}`, { is_vip: true })).status, 403, 'VIP is a manager decision');
    assert.equal((await pm.patch(`/api/people/${found[0].id}`, { is_vip: true })).status, 200);
    assert.equal((await pm.patch(`/api/cis/${svc}`, { business_owner_id: 999999 })).status, 400);
    assert.equal((await pm.patch(`/api/cis/${svc}`, { business_owner_id: found[0].id })).body.business_owner, 'Anna Berg');
    const orgs = (await viewer.get('/api/organisations')).body;
    assert.deepEqual(orgs.find((o: any) => o.id === org).services.map((s: any) => s.ref), [svc]);
  });

  test('incidents take a caller and affected people; VIPs and many affected suggest impact, never set it', async () => {
    const inc = (await analyst.post('/api/incidents', { title: 'Payslips missing', impact: 3, cis: [svc], caller: { email: 'anna@example.com' } })).body;
    assert.equal(inc.caller.name, 'Anna Berg');
    assert.equal(inc.asks_affected_users, true, 'the service has end users');
    assert.equal(inc.people_hint.suggested_impact, 2, 'a VIP caller');
    assert.equal(inc.impact, 3, 'only a suggestion');
    for (let n = 0; n < 10; n++) await analyst.post(`/api/incidents/${inc.ref}/people`, { name: `User ${n}`, email: `user${n}@example.com` });
    const after = (await analyst.get(`/api/incidents/${inc.ref}`)).body;
    assert.equal(after.affected_people.length, 10);
    assert.equal(after.people_hint.suggested_impact, 1);
    const plain = (await analyst.post('/api/incidents', { title: 'Disk slow', cis: [infra] })).body;
    assert.equal(plain.asks_affected_users, false, 'infrastructure-only services are not cluttered');
    const anna = (await analyst.get('/api/people?q=anna@example.com')).body[0];
    const page = (await viewer.get(`/api/people/${anna.id}`)).body;
    assert.equal(page.phone, undefined);
    assert.equal((await viewer.get(`/api/incidents/${inc.ref}`)).body.caller.email, undefined);
    assert.equal(page.incidents[0].role, 'caller');
    assert.deepEqual(page.services.map((s: any) => s.ref), [svc]);
    assert.equal(page.owns[0].role, 'business owner');
  });

  test('agents see who people are, not how to reach them, and cannot create contacts', async () => {
    const mcp = new McpClient({ name: 'people', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('analyst')}` } } }));
    const raw = async (name: string, args: object) => (await mcp.callTool({ name, arguments: args })) as any;
    const found = JSON.parse((await raw('search_people', { q: 'anna' })).content[0].text);
    assert.equal(found[0].name, 'Anna Berg');
    assert.ok(!JSON.stringify(found).includes('@'), 'no email to the AI provider');
    assert.ok(!(await raw('get_person', { id: found[0].id })).content[0].text.includes('anna@example.com'));
    const inc = (await analyst.post('/api/incidents', { title: 'Agent case' })).body;
    assert.equal((await raw('add_affected_person', { ref: inc.ref, id: found[0].id })).isError, undefined);
    assert.equal((await raw('add_affected_person', { ref: inc.ref, id: 999999 })).isError, true);
    assert.equal((await raw('add_affected_person', { ref: inc.ref, name: 'Injected Person' })).isError, true, 'agents link existing contacts only');
    await mcp.close();
  });

  test('erasing a person keeps incidents and the audit trail, with no name left in either', async () => {
    const anna = (await analyst.get('/api/people?q=anna@example.com')).body[0];
    const inc = (await analyst.post('/api/incidents', { title: 'Cannot log in', caller: { id: anna.id } })).body;
    await analyst.post(`/api/incidents/${inc.ref}/people`, { id: anna.id });
    assert.equal((await pm.post(`/api/people/${anna.id}/erase`, { reason: 'Erasure request #7' })).status, 403);
    assert.equal((await admin.post(`/api/people/${anna.id}/erase`, { reason: 'Erasure request #7' })).status, 200);
    const shown = (await analyst.get(`/api/incidents/${inc.ref}`)).body;
    assert.equal(shown.caller.name, `Erased person #${anna.id}`);
    assert.equal(shown.caller.email, null);
    assert.ok(shown.activity.some((a: any) => a.body === `Caller: Erased person #${anna.id} (#${anna.id})`), 'histories show the current name');
    const { query } = await import('../../src/db.js');
    const histories = JSON.stringify((await query('SELECT * FROM incident_activity')).rows) + JSON.stringify((await query('SELECT * FROM audit_log')).rows);
    assert.ok(!histories.includes('Anna') && !histories.includes('anna@example.com'));
    assert.equal((await admin.get('/api/audit/verify')).body.ok, true);
    assert.equal((await analyst.get('/api/people?q=anna')).body.length, 0);
  });
});
