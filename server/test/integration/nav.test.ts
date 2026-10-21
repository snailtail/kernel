import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { skip, startKernel, type Client, type Harness } from './harness.js';

const ok = (r: { status: number; body: unknown }) => assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);

describe('menu badges (#102)', { skip }, () => {
  let k: Harness;
  let pm: Client, analyst: Client, analyst2: Client, viewer: Client, admin: Client;
  before(async () => {
    k = await startKernel();
    [pm, analyst, analyst2, viewer, admin] = await Promise.all([k.login('pm'), k.login('analyst'), k.login('analyst2'), k.login('viewer'), k.login('admin')]);
  });
  after(async () => k?.close());

  test('counts what needs someone, per person, filtered by visibility', async () => {
    const zero = (await analyst.get('/api/nav/counts')).body;
    assert.deepEqual(Object.keys(zero).sort(), ['actions', 'events', 'incidents', 'kedb', 'my_work', 'requests', 'reviews']);
    const ids = Object.fromEntries((await admin.get('/api/users')).body.map((u: any) => [u.username, u.id]));
    // My work: a problem assigned to the analyst.
    ok(await pm.post('/api/problems', { title: 'Assigned to the analyst', assignee_id: ids.analyst }));
    // The team queue: an unassigned incident for the analyst's team.
    const team = (await admin.post('/api/teams', { name: 'Nav desk' })).body;
    ok(await admin.put(`/api/teams/${team.id}/members`, { members: [{ user_id: ids.analyst, role: 'member' }] }));
    ok(await pm.post('/api/incidents', { title: 'Queue item', team_id: team.id }));
    // An alert without an incident.
    ok(await analyst.post('/api/events', { source: 'nav', events: [{ host: 'web-9', check: 'http', severity: 'major', message: 'down' }] }));
    const c = (await analyst.get('/api/nav/counts')).body;
    assert.equal(c.my_work, zero.my_work + 1);
    assert.equal(c.incidents, zero.incidents + 1);
    assert.ok(c.events >= zero.events + 1, JSON.stringify(c));
    // Positive control above; someone not in the team does not get the queue item.
    assert.equal((await analyst2.get('/api/nav/counts')).body.incidents, 0);
    // A restricted problem assigned to someone counts for them only if they may see it (they always may) – and a
    // viewer, who cannot decide on known errors, gets no decision count.
    assert.equal((await viewer.get('/api/nav/counts')).body.kedb, 0);
  });
});
