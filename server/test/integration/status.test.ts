import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { skip, startKernel, type Client, type Harness } from './harness.js';

const MARKER = `INTERNAL-${randomBytes(4).toString('hex')}`;

describe('service status page (#46)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client;
  let svc: string, vm: string, inc: string;

  before(async () => {
    k = await startKernel();
    [admin, pm, analyst] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst')]);
    // Internal names, hosts and incident texts all carry the marker; none of it may reach the public page.
    svc = (await pm.post('/api/cis', { name: `Webshop ${MARKER}`, ci_type: 'business_service' })).body.ref;
    vm = (await pm.post('/api/cis', { name: `shop-vm01.${MARKER}.internal`, ci_type: 'virtual_machine' })).body.ref;
    await pm.post(`/api/cis/${vm}/relationships`, { type: 'member_of', target: svc });
    inc = (await analyst.post('/api/incidents', { title: `Checkout down ${MARKER}`, impact: 1, urgency: 1, cis: [vm] })).body.ref;
  });
  after(() => k?.close());

  test('Kernel suggests a status from incidents on the service and its components; a person sets it', async () => {
    const board = (await analyst.get('/api/status')).body;
    const s = board.services.find((x: any) => x.ref === svc);
    assert.equal(s.suggested, 'major_outage', 'a P1 incident on a component of the service');
    assert.deepEqual(s.incidents.map((i: any) => i.ref), [inc]);
    assert.equal(s.status, 'operational', 'nothing changes until a person sets it');
    assert.equal((await analyst.put(`/api/status/${svc}`, { status: 'major_outage' })).status, 200);
    assert.equal((await analyst.put(`/api/status/${svc}`, { status: 'major_outage', publish: true })).status, 403, 'publishing is for managers');
  });

  test('the public page is off by default and shows only what people published, under curated names', async () => {
    const anon = (path: string) => fetch(`${k.base}${path}`);
    assert.equal((await anon('/api/public/status')).status, 404);
    assert.equal((await anon('/status')).status, 404);
    assert.equal((await pm.put(`/api/status/${svc}/public`, { public: true })).status, 400, 'a public name is required');
    await pm.put(`/api/status/${svc}/public`, { public: true, public_name: 'Online shop', public_description: 'Ordering and payment' });
    await pm.put('/api/admin/status-page', { public_enabled: true, title: 'Acme status', reason: 'Customers ask during outages' });
    await analyst.post('/api/status/updates', { incident: inc, services: [svc], phase: 'investigating', status: 'major_outage', message: `Internal: db pool exhausted on ${MARKER}` });
    let page = await anon('/api/public/status').then((r) => r.json() as any);
    assert.deepEqual(page.services, [{ name: 'Online shop', description: 'Ordering and payment', status: 'operational' }], 'internal updates change nothing publicly');
    assert.equal((await analyst.post('/api/status/updates', { services: [svc], phase: 'identified', message: 'Ordering is unavailable.', public: true })).status, 403);
    await pm.post('/api/status/updates', { incident: inc, services: [svc], phase: 'identified', status: 'major_outage', message: 'Ordering is unavailable. We are working on it.', public: true });
    const res = await anon('/api/public/status');
    page = await res.json();
    assert.equal(page.services[0].status, 'major_outage');
    assert.equal(page.updates[0].message, 'Ordering is unavailable. We are working on it.');
    assert.match(res.headers.get('cache-control')!, /public, max-age=30/);
    const etag = res.headers.get('etag')!;
    assert.equal((await fetch(`${k.base}/api/public/status`, { headers: { 'If-None-Match': etag } })).status, 304);
    const html = await anon('/status');
    const text = await html.text();
    assert.match(html.headers.get('content-security-policy')!, /default-src 'none'/);
    assert.ok(!/<script/i.test(text));
    for (const body of [JSON.stringify(page), text]) {
      assert.ok(!body.includes(MARKER), 'no CI names, hosts, incident texts or internal updates');
      assert.ok(!body.includes(inc), 'no incident refs');
    }
    assert.equal((await fetch(`${k.base}/api/public/status`, { method: 'POST' })).status, 404, 'GET only');
  });

  test('a published update can be retracted, with a reason, and it leaves the page', async () => {
    const board = (await pm.get('/api/status')).body;
    const published = board.updates.find((u: any) => u.public);
    assert.equal((await pm.del(`/api/status/updates/${published.id}`)).status, 400, 'a reason is required');
    assert.equal((await pm.del(`/api/status/updates/${published.id}?reason=${encodeURIComponent('Wrong service')}`)).status, 200);
    const page = await fetch(`${k.base}/api/public/status`).then((r) => r.json() as any);
    assert.equal(page.updates.length, 0);
    const history = (await analyst.get(`/api/incidents/${inc}`)).body.activity;
    assert.ok(history.some((a: any) => a.kind === 'communication' && /Public status update/.test(a.body)), 'the incident keeps its communication log');
    void admin;
  });
});
