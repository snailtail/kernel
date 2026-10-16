// Proactive problem candidates (part 2 of #31): event trends and change correlation, each with a positive, a negative
// and a dismissed case, the evidence series, and the change links on a problem logged from a candidate.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, ownerQuery, skip, startKernel, type Harness } from './harness.js';

const ok = (r: { status: number; body: unknown }, status?: number) =>
  assert.ok(status ? r.status === status : r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body)}`);

describe('proactive problem candidates (#31)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client;
  let n = 0;

  before(async () => {
    k = await startKernel();
    [admin, pm, analyst] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst')]);
  });
  after(() => k?.close());

  const ci = async (name: string, ci_type = 'application') => (await pm.post('/api/cis', { name: `${name}-${++n}`, ci_type })).body.ref as string;
  const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
  const D = 24 * 60;
  /** Events in order, one request each, so a clear always follows its firing. */
  const send = async (source: string, events: object[]) => {
    for (const e of events) ok(await analyst.post('/api/events', { source, events: [e] }));
  };
  const candidates = async (rule: string) => (await analyst.get(`/api/candidates?rule=${rule}`)).body.candidates as any[];
  const byCi = async (rule: string, ref: string) => (await candidates(rule)).find((c) => c.ci_ref === ref);
  const dismiss = async (key: string) => ok(await analyst.post('/api/candidates/dismiss', { key, reason: 'Known and accepted for now' }));

  test('the trend rules are listed as proactive, with their settings', async () => {
    const { rules } = (await analyst.get('/api/candidates')).body;
    for (const id of ['flapping', 'rising_warnings', 'capacity_warnings', 'self_clearing', 'change_correlation']) {
      assert.ok(rules.find((r: any) => r.rule === id), id);
    }
    assert.deepEqual(rules.find((r: any) => r.rule === 'change_correlation').settings, { min_changes: 3, min_percent: 50, within_hours: 24, window_days: 90 });
  });

  test('flapping: a check that keeps reopening; not one that reopened twice; a dismissal holds while the same alert flaps on', async () => {
    const hit = await ci('flappy'), miss = await ci('steady');
    const flap = (ref: string, check: string, times: number, start: number) =>
      send('mon', Array.from({ length: times }, (_, i) => [
        { ci: ref, check, severity: 'warning', occurred_at: at(start + i) },
        { ci: ref, check, severity: 'clear', occurred_at: at(start + i + 0.5) },
      ]).flat());
    await flap(hit, 'http_health', 6, -13);
    await flap(miss, 'http_health', 3, -13);
    const c = await byCi('flapping', hit);
    assert.ok(c, 'found');
    assert.equal(c.proactive, true);
    assert.match(c.reason, new RegExp(`^http_health from mon on flappy-\\d+ \\(${hit}\\) reopened 5 times in 7 days`));
    assert.equal(c.evidence.series[0].points.length, 7);
    assert.ok(c.evidence.series[0].points.at(-1).value >= 12, 'today has the events');
    assert.equal(await byCi('flapping', miss), undefined, 'two reopenings are below the threshold');
    assert.equal((await analyst.get(`/api/candidates/draft?key=${encodeURIComponent(c.key)}`)).body.detection, 'proactive');

    await dismiss(c.key);
    await flap(hit, 'http_health', 2, -2);
    assert.equal(await byCi('flapping', hit), undefined, 'the same alert flapping on does not bring it back');
  });

  test('rising warnings: this window against the one before, from the daily counts', async () => {
    const hit = await ci('rising'), flat = await ci('flat'), few = await ci('few');
    const warn = (ref: string, count: number, daysAgo: number, tag: string) =>
      send('mon', Array.from({ length: count }, (_, i) => ({ ci: ref, check: `${tag}-${i}`, severity: 'warning', message: 'Latency high', occurred_at: at(-daysAgo * D - i) })));
    await warn(hit, 3, 10, 'old');
    await warn(hit, 12, 2, 'new');
    await warn(flat, 10, 10, 'old');
    await warn(flat, 12, 2, 'new');
    await warn(few, 5, 2, 'new');
    const c = await byCi('rising_warnings', hit);
    assert.match(c.reason, new RegExp(`^12 warnings on rising-\\d+ \\(${hit}\\) in the last 7 days, 400 % of the 7 days before \\(3\\)$`));
    const s = c.evidence.series[0];
    assert.equal(s.points.length, 14);
    assert.equal(s.split, s.points[7].day);
    assert.equal(s.points.reduce((t: number, p: any) => t + p.value, 0), 15);
    assert.equal(await byCi('rising_warnings', flat), undefined, '120 % is not rising enough');
    assert.equal(await byCi('rising_warnings', few), undefined, 'five warnings are below the minimum');

    // Dismissed: hidden until a new alert joins the trend.
    await dismiss(c.key);
    assert.equal(await byCi('rising_warnings', hit), undefined);
    await warn(hit, 1, 0, 'newest');
    assert.equal((await byCi('rising_warnings', hit)).evidence.records.length, 1, 'back with only the new alert');
  });

  test('capacity warnings: disk alerts that keep coming back; other checks do not count', async () => {
    const hit = await ci('fileserver'), other = await ci('webserver');
    for (const ago of [20, 10, 2]) {
      await send('mon', [
        { ci: hit, check: 'disk_usage /var', severity: 'warning', message: 'Disk 91% full', occurred_at: at(-ago * D) },
        { ci: hit, check: 'disk_usage /var', severity: 'clear', occurred_at: at(-ago * D + 60) },
        { ci: other, check: 'http_latency', severity: 'warning', message: 'Slow responses', occurred_at: at(-ago * D) },
        { ci: other, check: 'http_latency', severity: 'clear', occurred_at: at(-ago * D + 60) },
      ]);
    }
    const c = await byCi('capacity_warnings', hit);
    assert.match(c.reason, /^Capacity alerts \(disk_usage \/var\) fired 3 times on fileserver-\d+ \(CI\d+\) in 30 days/);
    assert.equal(c.evidence.series[0].points.filter((p: any) => p.value > 0).length, 3);
    assert.equal(await byCi('capacity_warnings', other), undefined);
    await dismiss(c.key);
    assert.equal(await byCi('capacity_warnings', hit), undefined);
  });

  test('alerts that clear themselves: short, unacknowledged, no incident; not when someone looked', async () => {
    const hit = await ci('lossy'), seen = await ci('watched');
    for (let d = 5; d >= 1; d--) {
      await send('mon', [
        { ci: hit, check: 'packet_loss', severity: 'minor', occurred_at: at(-d * D) },
        { ci: hit, check: 'packet_loss', severity: 'clear', occurred_at: at(-d * D + 5) },
        { ci: seen, check: 'packet_loss', severity: 'minor', occurred_at: at(-d * D) },
        { ci: seen, check: 'packet_loss', severity: 'clear', occurred_at: at(-d * D + 120) },
      ]);
    }
    const c = await byCi('self_clearing', hit);
    assert.match(c.reason, /^packet_loss from mon on lossy-\d+ \(CI\d+\) fired 5 times in 14 days and cleared itself after 5 minutes on average, unnoticed$/);
    assert.equal(await byCi('self_clearing', seen), undefined, 'two hours is not self-clearing (max 30 minutes)');
    await dismiss(c.key);
    await send('mon', [{ ci: hit, check: 'packet_loss', severity: 'minor', occurred_at: at(-60) }, { ci: hit, check: 'packet_loss', severity: 'clear', occurred_at: at(-55) }]);
    assert.equal(await byCi('self_clearing', hit), undefined, 'one new firing is not five');
  });

  /** A change through to review with an outcome (actual_end now). */
  const change = async (ref: string, outcome: string) => {
    const plans = { implementation_plan: 'Run the playbook', backout_plan: 'Restore the snapshot', planned_start: at(60), planned_end: at(120) };
    const c = (await analyst.post('/api/changes', { title: `Update ${ref} ${++n}`, risk: 'low', cis: [ref], ...plans })).body.ref as string;
    for (const to of ['assess', 'authorize']) ok(await analyst.post(`/api/changes/${c}/transition`, { to }));
    ok(await pm.post(`/api/changes/${c}/votes`, { decision: 'approve' }));
    if ((await analyst.get(`/api/changes/${c}`)).body.status === 'authorize') ok(await admin.post(`/api/changes/${c}/votes`, { decision: 'approve' }));
    ok(await analyst.post(`/api/changes/${c}/transition`, { to: 'implementing' }));
    ok(await analyst.post(`/api/changes/${c}/transition`, { to: 'review', outcome }));
    return c;
  };

  test('changes that fail or are followed by incidents; logged with the changes linked', async () => {
    const hit = await ci('billing-db', 'database'), fine = await ci('wiki-db', 'database'), bad = await ci('crm-db', 'database');
    const changes = [await change(hit, 'rolled_back'), await change(hit, 'successful'), await change(hit, 'successful')];
    // The first two were done days ago; only the last one is followed by the incident.
    for (const [i, days] of [[0, 6], [1, 3]] as const) await ownerQuery(`UPDATE changes SET actual_start = now() - $2 * interval '1 day', actual_end = now() - $2 * interval '1 day' WHERE ref = $1`, [changes[i], days]);
    const inc = (await analyst.post('/api/incidents', { title: 'Billing slow after patch', cis: [hit] })).body.ref;
    for (let i = 0; i < 3; i++) await change(fine, 'successful');
    for (let i = 0; i < 3; i++) await change(bad, 'failed');

    const c = await byCi('change_correlation', hit);
    assert.match(c.reason, new RegExp(`^2 of 3 changes on billing-db-\\d+ \\(${hit}\\) in 90 days failed, were rolled back or were followed by an incident within 24 hours$`));
    const notes = Object.fromEntries(c.evidence.records.map((r: any) => [r.reference, r.note]));
    assert.equal(notes[changes[0]], 'rolled back');
    assert.equal(notes[changes[2]], `followed by ${inc}`, 'the latest change was followed by the incident');
    assert.equal(notes[inc], `after ${changes[2]}`);
    assert.equal(await byCi('change_correlation', fine), undefined, 'successful changes without incidents');
    assert.ok(new Date(c.first_at) < new Date(c.last_at), 'first and latest in time order');

    const draft = (await analyst.get(`/api/candidates/draft?key=${encodeURIComponent(c.key)}`)).body;
    assert.equal(draft.detection, 'reactive', 'an incident happened');
    assert.match(draft.description, /\[rolled back\]/);
    const created = await analyst.post('/api/candidates/create', { key: c.key });
    ok(created, 201);
    assert.deepEqual(created.body.links.filter((l: any) => l.kind === 'change').map((l: any) => l.reference).sort(), [...changes].sort());
    assert.ok(created.body.incidents.some((i: any) => i.ref === inc));
    assert.equal(await byCi('change_correlation', hit), undefined, 'changes linked to a problem no longer count');

    const failing = await byCi('change_correlation', bad);
    assert.equal((await analyst.get(`/api/candidates/draft?key=${encodeURIComponent(failing.key)}`)).body.detection, 'proactive', 'only failed changes, no incident yet');
    await dismiss(failing.key);
    assert.equal(await byCi('change_correlation', bad), undefined);
  });

  test('rule settings apply to the trend rules', async () => {
    const hit = await ci('tuned');
    for (let d = 3; d >= 1; d--) {
      await send('mon', [
        { ci: hit, check: 'jitter', severity: 'minor', occurred_at: at(-d * D) },
        { ci: hit, check: 'jitter', severity: 'clear', occurred_at: at(-d * D + 2) },
      ]);
    }
    assert.equal(await byCi('self_clearing', hit), undefined);
    ok(await pm.put('/api/candidates/rules/self_clearing', { settings: { min_firings: 3 } }));
    assert.ok(await byCi('self_clearing', hit));
    const { rows } = await ownerQuery("SELECT count(*)::int AS n FROM audit_log WHERE entity_ref = 'candidate_rule:self_clearing'");
    assert.equal(rows[0].n, 1);
  });
});
