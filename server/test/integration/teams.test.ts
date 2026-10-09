import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { skip, startKernel, type Client, type Harness } from './harness.js';

describe('teams and assignment (#42)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client, viewer: Client;
  const ids: Record<string, number> = {};
  let db: typeof import('../../src/db.js');
  let svc: string, vm: string, net: any, dba: any;

  before(async () => {
    k = await startKernel();
    [admin, pm, analyst, viewer] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst'), k.login('viewer')]);
    db = await import('../../src/db.js');
    for (const u of (await db.query('SELECT id, username FROM users')).rows) ids[u.username] = u.id;
    svc = (await pm.post('/api/cis', { name: 'Core network', ci_type: 'technical_service' })).body.ref;
    vm = (await pm.post('/api/cis', { name: 'core-sw01', ci_type: 'network_device' })).body.ref;
    await pm.post(`/api/cis/${vm}/relationships`, { type: 'member_of', target: svc });
  });
  after(() => k?.close());

  test('administrators create teams; leads manage their own members; everything is audited', async () => {
    assert.equal((await pm.post('/api/teams', { name: 'Network' })).status, 403);
    net = (await admin.post('/api/teams', { name: 'Network', cis: [svc] })).body;
    dba = (await admin.post('/api/teams', { name: 'DBA', auto_assign: 'round_robin' })).body;
    assert.equal((await admin.post('/api/teams', { name: 'network' })).status, 409, 'names are unique, ignoring case');
    assert.equal((await analyst.put(`/api/teams/${net.id}/members`, { members: [{ user_id: ids.analyst }] })).status, 403);
    await admin.put(`/api/teams/${net.id}/members`, { members: [{ user_id: ids.pm, role: 'lead' }] });
    const asLead = await pm.put(`/api/teams/${net.id}/members`, { members: [{ user_id: ids.pm, role: 'lead' }, { user_id: ids.analyst }] });
    assert.equal(asLead.status, 200, 'the lead manages their own team');
    assert.deepEqual(asLead.body.members.map((m: any) => m.role).sort(), ['lead', 'member']);
    assert.equal((await pm.put(`/api/teams/${dba.id}/members`, { members: [{ user_id: ids.pm }] })).status, 403, 'not another team');
    assert.equal((await admin.put(`/api/teams/${net.id}/members`, { members: [{ user_id: ids.viewer }] })).status, 400, 'viewers cannot work records');
    await admin.put(`/api/teams/${dba.id}/members`, { members: [{ user_id: ids.analyst, role: 'lead' }, { user_id: ids.pm }] });
    const audited = (await db.query("SELECT action FROM audit_log WHERE entity_type = 'team'")).rows.map((r: any) => r.action);
    assert.ok(audited.includes('create') && audited.includes('members'));
    assert.ok((await viewer.get('/api/teams')).body.length >= 2);
  });

  test('work goes to the team that supports the CI; the queue is notified; assignees must be members', async () => {
    const i = (await analyst.post('/api/incidents', { title: 'Switch port flapping', cis: [vm] })).body;
    assert.equal(i.team_id, net.id, 'from the service the CI belongs to');
    assert.equal(i.assignment_group, 'Network', 'the compatibility text follows the team');
    assert.equal(i.assignee, null);
    const notified = (await db.query("SELECT user_id FROM notifications WHERE event = 'team_queue' AND ref = $1", [i.ref])).rows.map((r: any) => r.user_id).sort();
    assert.deepEqual(notified, [ids.pm], 'the other members (not the person who logged it)');
    assert.equal((await analyst.patch(`/api/incidents/${i.ref}`, { assignee_id: ids.admin })).status, 400, 'admin is not in Network');
    assert.equal((await analyst.patch(`/api/incidents/${i.ref}`, { assignee_id: ids.analyst })).status, 200);
    const queue = (await analyst.get(`/api/teams/${net.id}/queue`)).body;
    assert.ok(queue.mine.some((r: any) => r.ref === i.ref));
    const legacy = (await analyst.post('/api/incidents', { title: 'From a script', assignment_group: 'dba' })).body;
    assert.equal(legacy.team_id, dba.id, 'a group name still lands with its team');
  });

  test('moving to another team hands it to that queue, counts a hop, and round robin picks a member', async () => {
    const i = (await analyst.post('/api/incidents', { title: 'Slow queries', team_id: net.id, assignee_id: ids.analyst })).body;
    const moved = (await analyst.patch(`/api/incidents/${i.ref}`, { team_id: dba.id })).body;
    assert.equal(moved.team_id, dba.id);
    assert.equal(moved.assignment_group, 'DBA');
    assert.equal(moved.assignee_id, ids.analyst, 'the analyst is in DBA too, so they keep it');
    assert.equal(moved.team_hops, 1);
    await analyst.patch(`/api/incidents/${i.ref}`, { title: 'Slow queries on payroll' });
    assert.equal((await analyst.get(`/api/incidents/${i.ref}`)).body.team_hops, 1, 'hops count team changes, not edits');
    await admin.put(`/api/teams/${dba.id}`, { name: 'Database team', auto_assign: 'round_robin' });
    const shown = (await analyst.get(`/api/incidents/${i.ref}`)).body;
    assert.equal(shown.assignment_group, 'Database team');
    assert.ok(shown.activity.some((a: any) => a.body === 'Moved to team Database team'), 'histories show the current name');
    const rr = (await analyst.post('/api/incidents', { title: 'Backup failed', team_id: dba.id })).body;
    assert.ok([ids.pm, ids.analyst].includes(rr.assignee_id), 'round robin assigns a member');
    assert.equal(rr.assignee_id, ids.pm, 'the member with the least open work');
  });

  test('a team with open work cannot be removed; my work shows my teams\' queues', async () => {
    assert.equal((await admin.del(`/api/teams/${net.id}`)).status, 409);
    const work = (await analyst.get('/api/my-work')).body;
    assert.ok(work.teams.some((t: any) => t.id === net.id));
    const empty = (await admin.post('/api/teams', { name: 'Temporary' })).body;
    assert.equal((await admin.del(`/api/teams/${empty.id}`)).status, 200);
  });

  test('SLA warnings go to the team lead when no one is assigned; reports count by team', async () => {
    const i = (await analyst.post('/api/incidents', { title: 'Core down', impact: 1, urgency: 1, team_id: net.id })).body;
    const sla = await import('../../src/sla.js');
    const { rows } = await db.query('SELECT sla_id FROM incidents WHERE ref = $1', [i.ref]);
    assert.ok(rows[0].sla_id, 'the default SLA applies');
    // Two days later, with no one assigned: the resolution target is breached.
    await sla.checkSlaEvents(Date.now() + 2 * 86400_000);
    const to = (await db.query("SELECT DISTINCT user_id FROM notifications WHERE ref = $1 AND event IN ('sla_warning', 'sla_breach')", [i.ref])).rows.map((x: any) => x.user_id);
    assert.deepEqual(to, [ids.pm], 'the Network lead, not every manager');
    await analyst.post(`/api/incidents/${i.ref}/transition`, { to: 'resolved', resolution_code: 'fixed', resolution: 'Replaced the line card' });
    const report = await sla.slaCompliance('2000-01-01', '2100-01-01');
    assert.ok(report.by_group.some((g: any) => g.team_id === net.id && g.name === 'Network'), 'reported per team id with its current name');
  });
});
