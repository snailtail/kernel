import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { skip, startKernel, type Client, type Harness } from './harness.js';

describe('service reports (#54)', { skip }, () => {
  let k: Harness;
  let pm: Client, analyst: Client, analyst2: Client, viewer: Client;
  let svc: string, vm: string;
  let db: typeof import('../../src/db.js');

  before(async () => {
    k = await startKernel();
    [pm, analyst, analyst2, viewer] = await Promise.all([k.login('pm'), k.login('analyst'), k.login('analyst2'), k.login('viewer')]);
    db = await import('../../src/db.js');
    svc = (await pm.post('/api/cis', { name: 'Payroll', ci_type: 'business_service' })).body.ref;
    vm = (await pm.post('/api/cis', { name: 'payroll-db', ci_type: 'database' })).body.ref;
    await pm.post(`/api/cis/${vm}/relationships`, { type: 'member_of', target: svc });
  });
  after(() => k?.close());

  test('overlapping outages are counted once', async () => {
    const { coveredMinutes } = await import('../../src/service-report.js');
    const m = 60_000;
    assert.equal(coveredMinutes([[0, 60 * m], [30 * m, 90 * m], [120 * m, 150 * m]]), 120);
    assert.equal(coveredMinutes([]), 0);
    const { subtractIntervals } = await import('../../src/service-report.js');
    assert.deepEqual(subtractIntervals([[0, 100]], [[20, 30], [90, 120]]), [[0, 20], [30, 90]]);
  });

  test('availability, incidents, SLA, changes and problems for a service and its components', async () => {
    // A P1 on the database (a component) lasting two hours, yesterday; a P3 on the service.
    const p1 = (await analyst.post('/api/incidents', { title: 'Payroll DB down', impact: 1, urgency: 1, cis: [vm] })).body.ref;
    const p3 = (await analyst.post('/api/incidents', { title: 'Slow payslip export', impact: 3, urgency: 3, cis: [svc] })).body.ref;
    await db.query("UPDATE incidents SET created_at = date_trunc('day', now()) - interval '1 day' + interval '8 hours' WHERE ref = $1", [p1]);
    await analyst.post(`/api/incidents/${p1}/transition`, { to: 'resolved', resolution_code: 'fixed', resolution: 'Failed over' });
    await db.query("UPDATE incidents SET resolved_at = date_trunc('day', now()) - interval '1 day' + interval '10 hours' WHERE ref = $1", [p1]);
    const chg = (await analyst.post('/api/changes', { title: 'Upgrade payroll-db', cis: [vm] })).body.ref;
    await db.query("UPDATE changes SET outcome = 'rolled_back', actual_start = now() - interval '2 days' WHERE ref = $1", [chg]);
    const prb = (await analyst.post('/api/problems', { title: 'DB fails over under load' })).body.ref;
    await analyst.post(`/api/problems/${prb}/cis`, { ci: vm });

    const r = (await viewer.get(`/api/services/${svc}/report`)).body;
    assert.equal(r.service.name, 'Payroll');
    assert.equal(r.availability.outage_minutes, 120);
    assert.ok(r.availability.percent < 100 && r.availability.percent > 99);
    assert.equal(r.incidents.total, 2);
    assert.deepEqual(r.incidents.major.map((i: any) => i.ref), [p1]);
    assert.equal(r.incidents.mttr_minutes, 120);
    assert.equal(r.changes.success_rate, 0);
    assert.deepEqual(r.changes.failed.map((c: any) => c.ref), [chg]);
    assert.deepEqual(r.problems.map((p: any) => p.ref), [prb]);
    void p3;
    const md = await fetch(`${k.base}/api/services/${svc}/report.md`, { headers: { Cookie: viewer.cookie! } });
    const text = await md.text();
    assert.match(md.headers.get('content-disposition')!, /service-report-SVC/);
    assert.match(text, /^# Service report: Payroll/);
    assert.match(text, /outage 2 h 0 min/);
    assert.match(r.availability.basis, /calendar time|service hours/);
  });

  test('planned maintenance is not unavailability, and an outage starts at the first alert', async () => {
    const { query } = db;
    const p2 = (await analyst.post('/api/incidents', { title: 'Payroll slow to a halt', impact: 1, urgency: 2, cis: [vm] })).body.ref;
    const day = "date_trunc('day', now()) - interval '3 days'";
    await query(`UPDATE incidents SET created_at = ${day} + interval '12 hours', resolved_at = ${day} + interval '14 hours', status = 'resolved' WHERE ref = $1`, [p2]);
    const { rows } = await query('SELECT id FROM incidents WHERE ref = $1', [p2]);
    const { rows: ci } = await query('SELECT id FROM configuration_items WHERE ref = $1', [vm]);
    await query(`INSERT INTO alerts (source, dedupe_ci, check_key, severity, status, first_seen, last_seen, state_at, incident_id) VALUES ('test', 'payroll-db', 'db', 'critical', 'closed', ${day} + interval '11 hours', ${day} + interval '14 hours', ${day} + interval '14 hours', $1)`, [rows[0].id]);
    await query(`INSERT INTO maintenance_windows (ci_id, starts_at, ends_at, reason) VALUES ($1, ${day} + interval '13 hours', ${day} + interval '14 hours', 'Patch')`, [ci[0].id]);
    const r = (await viewer.get(`/api/services/${svc}/report`)).body;
    assert.ok(r.availability.maintenance_minutes >= 60);
    // Earlier P1: 120 min; this one from the first alert 11:00 to 14:00, minus the 13:00–14:00 maintenance: 120 min.
    assert.equal(r.availability.outage_minutes, 240);
  });

  test('a report shows only what its reader may see', async () => {
    const secret = (await analyst.post('/api/incidents', { title: 'Payroll data exposure', impact: 1, urgency: 1, cis: [vm] })).body.ref;
    await analyst.put(`/api/records/${secret}/visibility`, { restricted: true, teams: [], reason: 'Security' });
    const mine = (await analyst.get(`/api/services/${svc}/report`)).body;
    const other = (await analyst2.get(`/api/services/${svc}/report`)).body;
    assert.ok(mine.incidents.major.some((i: any) => i.ref === secret));
    assert.ok(!other.incidents.major.some((i: any) => i.ref === secret));
    assert.equal((await pm.get(`/api/services/${svc}/report`)).body.restricted_records_left_out, true, 'managers are told');
    assert.equal((await viewer.get('/api/services/CI999999/report')).status, 404);
  });
});
