import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ownerQuery, skip, startKernel, type Client, type Harness } from './harness.js';

describe('service reports (#54)', { skip }, () => {
  let k: Harness;
  let pm: Client, analyst: Client, analyst2: Client, viewer: Client;
  let svc: string, vm: string;
  let db: typeof import('../../src/core/db.js');

  before(async () => {
    k = await startKernel();
    [pm, analyst, analyst2, viewer] = await Promise.all([k.login('pm'), k.login('analyst'), k.login('analyst2'), k.login('viewer')]);
    db = await import('../../src/core/db.js');
    svc = (await pm.post('/api/cis', { name: 'Payroll', ci_type: 'business_service' })).body.ref;
    vm = (await pm.post('/api/cis', { name: 'payroll-db', ci_type: 'database' })).body.ref;
    await pm.post(`/api/cis/${vm}/relationships`, { type: 'member_of', target: svc });
  });
  after(() => k?.close());

  test('overlapping outages are counted once', async () => {
    const { coveredMinutes } = await import('../../src/reporting/service-report.js');
    const m = 60_000;
    assert.equal(coveredMinutes([[0, 60 * m], [30 * m, 90 * m], [120 * m, 150 * m]]), 120);
    assert.equal(coveredMinutes([]), 0);
    const { subtractIntervals } = await import('../../src/reporting/service-report.js');
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

  test('CSV: the records behind the report, only what the reader may see, formulas neutralised', async () => {
    const formula = (await analyst.post('/api/incidents', { title: '=HYPERLINK("http://evil.example","x")', impact: 3, urgency: 3, cis: [svc] })).body.ref;
    const secret = (await db.query("SELECT ref FROM incidents WHERE title = 'Payroll data exposure'")).rows[0].ref;
    const csv = async (c: Client) => {
      const res = await fetch(`${k.base}/api/reports/service.csv?service=${svc}`, { headers: { Cookie: c.cookie! } });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type')!, /text\/csv/);
      return res.text();
    };
    const text = await csv(analyst2);
    assert.match(text, /^kind,ref,title,status,priority,type,major,started,ended,outcome,resolution_target_met,problem\r\n/);
    assert.match(text, new RegExp(`incident,${formula},"'=HYPERLINK`), 'a formula is prefixed with a quote');
    assert.match(text, /\nchange,CHG/);
    assert.match(text, /\nproblem,PRB/);
    assert.ok(!text.includes(secret), 'a restricted incident is left out for someone who cannot see it');
    assert.ok((await csv(analyst)).includes(secret));
    assert.equal((await viewer.get('/api/reports/service.csv')).status, 400, 'a service is required');
  });

  test('dashboard KPIs: six periods, how each is calculated, the list behind it, through RLS', async () => {
    // Three incidents on one CI within 30 days and no problem: recurring.
    const nas = (await pm.post('/api/cis', { name: 'nas-01', ci_type: 'virtual_machine' })).body.ref;
    for (const t of ['NAS full', 'NAS full again', 'NAS full once more']) await analyst.post('/api/incidents', { title: t, impact: 3, urgency: 3, cis: [nas] });
    const quick = (await analyst.post('/api/incidents', { title: 'Printer jam', impact: 2, urgency: 2 })).body.ref;
    await db.query("UPDATE incidents SET created_at = now() - interval '90 minutes' WHERE ref = $1", [quick]);
    await analyst.post(`/api/incidents/${quick}/transition`, { to: 'resolved', resolution_code: 'fixed', resolution: 'Cleared' });

    const d = (await viewer.get('/api/dashboard/kpis')).body;
    assert.equal(d.period.unit, 'month');
    assert.equal(d.period.starts.length, 6);
    assert.deepEqual(d.tiles.map((t: any) => t.id), ['mttr', 'sla', 'change_success', 'recurring', 'problems_resolved', 'major_open', 'fix_lead_time', 'recurred_after_fix']);
    for (const t of d.tiles) {
      assert.equal(t.trend.length, 6, t.id);
      assert.ok(t.basis.length > 20 && t.link.startsWith('/'), t.id);
    }
    const tile = (id: string) => d.tiles.find((t: any) => t.id === id);
    assert.ok(tile('mttr').value > 0);
    assert.match(tile('mttr').detail, /P2 /);
    assert.ok(tile('recurring').value >= 1);
    assert.equal(tile('major_open').unit, 'count');
    assert.equal((await viewer.get('/api/dashboard/kpis?period=week')).body.period.starts.length, 6);
    assert.equal((await viewer.get('/api/dashboard/kpis?period=year')).status, 400);
    assert.equal((await pm.get('/api/dashboard/kpis')).body.restricted_records_left_out, true, 'managers are told');

    // Choosing and ordering tiles is a preference; each tile once, known tiles only.
    assert.deepEqual((await viewer.put('/api/auth/preferences', { dashboard_tiles: ['sla', 'mttr'] })).body.dashboard_tiles, ['sla', 'mttr']);
    // Unknown ids are dropped (a module switched off later must not break the page); each tile counts once.
    assert.deepEqual((await viewer.put('/api/auth/preferences', { dashboard_tiles: ['sla', 'cost', 'sla', 'mttr'] })).body.dashboard_tiles, ['sla', 'mttr']);

    // A switched-off practice has no tiles, and the rest still work.
    const admin = await k.login('admin');
    assert.equal((await admin.put('/api/admin/modules', { change: false, reason: 'Testing' })).status, 200);
    try {
      const without = (await viewer.get('/api/dashboard/kpis')).body.tiles.map((t: any) => t.id);
      assert.ok(!without.includes('change_success') && !without.includes('fix_lead_time') && without.includes('mttr'));
    } finally {
      await admin.put('/api/admin/modules', { change: true, reason: 'Back on' });
    }

    // get_dashboard (like the web page, through GET /api/dashboard) needs problem.read: that keeps parity only while
    // every role that may read a practice also reads problems and reports. Guard that assumption.
    const { PERMISSIONS } = await import('../../src/security/policy.js');
    for (const [role, actions] of Object.entries(PERMISSIONS)) {
      if (['incident.read', 'change.read'].some((a) => actions.has(a as any))) assert.ok(actions.has('problem.read') && actions.has('report.read'), role);
      // The improvement register (#52): read by everyone who reads problems, written by those who comment on them.
      assert.equal(actions.has('improvement.read'), actions.has('problem.read'), `${role}: improvement.read`);
      assert.equal(actions.has('improvement.write'), actions.has('problem.comment'), `${role}: improvement.write`);
      // Service requests (#44): read and logged like improvements; the catalogue is the managers'.
      assert.equal(actions.has('request.read'), actions.has('problem.read'), `${role}: request.read`);
      assert.equal(actions.has('request.write'), actions.has('problem.comment'), `${role}: request.write`);
      assert.equal(actions.has('request.manage'), actions.has('improvement.approve'), `${role}: request.manage`);
    }

    // MCP parity: get_dashboard carries the same KPIs.
    const mcp = new McpClient({ name: 'kpi', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${k.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await k.tokenFor('viewer')}` } } }));
    const res = (await mcp.callTool({ name: 'get_dashboard', arguments: {} })) as any;
    assert.ok(!res.isError, res.content[0].text);
    const viaMcp = JSON.parse(res.content[0].text);
    assert.deepEqual(viaMcp.kpis.tiles.map((t: any) => [t.id, t.value]), d.tiles.map((t: any) => [t.id, t.value]));
    assert.ok(viaMcp.by_status, 'the backlog summary is still there');
    await mcp.close();
  });

  test('scheduled reports: the owner or a manager, once per period, by email without restricted records', async () => {
    const n = await import('../../src/notifications/notifications.js');
    const rs = await import('../../src/reporting/report-schedules.js');
    process.env.SMTP_URL = 'capture:';
    try {
      await ownerQuery("UPDATE users SET email = username || '@example.com'");
      await ownerQuery("UPDATE configuration_items SET owner_id = (SELECT id FROM users WHERE username = 'analyst') WHERE ref = $1", [svc]);
      assert.equal((await analyst2.post('/api/report-schedules', { service: svc, frequency: 'monthly' })).status, 403, 'not the owner');
      assert.equal((await analyst.post('/api/report-schedules', { frequency: 'monthly' })).status, 400, 'a service or an organisation');
      const created = await analyst.post('/api/report-schedules', { service: svc, frequency: 'monthly' });
      assert.equal(created.status, 201);
      assert.equal(created.body.service_ref, svc);
      assert.equal((await analyst.post('/api/report-schedules', { service: svc, frequency: 'monthly' })).body.id, created.body.id, 'asking twice keeps one');
      assert.equal((await analyst.get('/api/report-schedules')).body.schedules.length, 1);
      assert.equal((await analyst2.get('/api/report-schedules')).body.schedules.length, 0, 'only my own');

      // At the start of next month this month is due: queued once however often the worker runs.
      const now = new Date();
      const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2));
      assert.equal(await rs.queueScheduledReports(next), 1);
      assert.equal(await rs.queueScheduledReports(next), 0);
      const before = n.capturedMail.length;
      assert.equal(await rs.processReportDeliveries(), 1);
      assert.equal(await rs.processReportDeliveries(), 0);
      const mail = n.capturedMail.slice(before);
      assert.equal(mail.length, 1);
      assert.equal(mail[0].to, 'analyst@example.com');
      assert.match(mail[0].subject, new RegExp(`service report Payroll, ${now.toISOString().slice(0, 7)}`));
      assert.match(mail[0].text, /Availability .* %/);
      assert.match(mail[0].text, new RegExp(`/services/${svc}/report\\?from=`));
      assert.match(mail[0].attachments![0].content, /^# Service report: Payroll/);
      // The analyst can see the restricted incident in Kernel, but it never goes by mail.
      const secret = (await db.query("SELECT ref FROM incidents WHERE title = 'Payroll data exposure'")).rows[0].ref;
      assert.ok((await analyst.get(`/api/services/${svc}/report`)).body.incidents.major.some((i: any) => i.ref === secret));
      assert.ok(!mail[0].text.includes(secret) && !mail[0].attachments![0].content.includes(secret));
      assert.ok(!mail[0].attachments![0].content.includes('Payroll data exposure'));

      // An owner who handed the service on no longer gets it.
      await ownerQuery('UPDATE configuration_items SET owner_id = NULL WHERE ref = $1', [svc]);
      const later = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 2));
      assert.equal(await rs.queueScheduledReports(later), 1);
      assert.equal(await rs.processReportDeliveries(), 0);
      assert.equal((await ownerQuery("SELECT status FROM report_deliveries ORDER BY id DESC LIMIT 1")).rows[0].status, 'skipped');

      // A manager schedules an organisation's services.
      const org = (await ownerQuery("INSERT INTO organisations (name) VALUES ('Finance') RETURNING id")).rows[0].id;
      await ownerQuery('INSERT INTO organisation_services (organisation_id, ci_id) SELECT $1, id FROM configuration_items WHERE ref = $2', [org, svc]);
      assert.equal((await analyst.post('/api/report-schedules', { organisation_id: org, frequency: 'quarterly' })).status, 403);
      const orgSchedule = (await pm.post('/api/report-schedules', { organisation_id: org, frequency: 'quarterly' })).body;
      await ownerQuery("UPDATE report_schedules SET created_at = now() - interval '1 year' WHERE id = $1", [orgSchedule.id]);
      assert.equal(await rs.queueScheduledReports(), 1);
      assert.equal(await rs.processReportDeliveries(), 1);
      const orgMail = n.capturedMail.at(-1)!;
      assert.equal(orgMail.to, 'pm@example.com');
      assert.match(orgMail.subject, /service report Finance, \d{4}-Q\d/);
      assert.match(orgMail.text, /Payroll \(/);

      assert.equal((await analyst2.del(`/api/report-schedules/${created.body.id}`)).status, 404);
      assert.equal((await analyst.del(`/api/report-schedules/${created.body.id}`)).status, 200);
      assert.equal((await pm.get('/api/report-schedules')).body.schedules.length, 1, 'managers see everyone\'s');

      // A confidential known error's workaround (#61): masked in the web until revealed, never in exports or mail.
      const ke = (await analyst.post('/api/problems', { title: 'Payroll export times out' })).body.ref;
      await analyst.post(`/api/problems/${ke}/cis`, { ci: vm });
      await db.query("UPDATE problems SET status = 'known_error', known_error_at = now(), workaround = 'Run the export for the board member at night' WHERE ref = $1", [ke]);
      assert.equal((await analyst.put(`/api/records/${ke}/classification`, { classification: 'confidential', reason: 'Concerns a board member' })).status, 200);
      const inWeb = async (c: Client) => (await c.get(`/api/services/${svc}/report`)).body.problems.find((p: any) => p.ref === ke);
      assert.deepEqual([(await inWeb(analyst2)).workaround, (await inWeb(analyst2)).workaround_masked], [null, true]);
      assert.equal((await analyst.post(`/api/records/${ke}/reveal`, { reason: 'Service review' })).status, 200);
      assert.match((await inWeb(analyst)).workaround, /board member/, 'revealed, the reader sees it in Kernel');
      const md = await (await fetch(`${k.base}/api/services/${svc}/report.md`, { headers: { Cookie: analyst.cookie! } })).text();
      assert.ok(md.includes(ke) && md.includes('Workaround: confidential, not included') && !md.includes('board member'), 'never in a download');
      const quarter = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 4, 2));
      assert.equal(await rs.queueScheduledReports(quarter), 1);
      assert.equal(await rs.processReportDeliveries(), 1);
      const keMail = n.capturedMail.at(-1)!;
      assert.ok(keMail.attachments![0].content.includes(ke) && !keMail.attachments![0].content.includes('board member') && !keMail.text.includes('board member'), 'never by mail');
    } finally {
      delete process.env.SMTP_URL;
    }
  });
});
