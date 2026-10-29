// Development and service management (#167, part 2): a change delivers bugs and stories, a link made from either side
// is in both histories, and the problem's loop is closed on a verified fix: watched for new incidents after the deploy,
// then a suggestion to resolve. A failed or rolled back fix is never suggested. The fix KPIs.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ownerQuery, skip, startKernel, type Client, type Harness } from './harness.js';

const ok = (r: { status: number; body: any }, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

describe('closing the loop between a problem and its fix (#167)', { skip }, () => {
  let k: Harness;
  let admin: Client, pm: Client, analyst: Client;
  let ci: string;
  let n = 0;

  const knownError = async (title: string, fixType: string) => {
    const p = ok(await analyst.post('/api/problems', { title, description: 'Payslips show last month' }), 201).ref as string;
    ok(await analyst.post(`/api/problems/${p}/transition`, { to: 'analysis' }));
    ok(await analyst.post(`/api/problems/${p}/transition`, { to: 'known_error', root_cause: 'A stale cache key', workaround: 'Clear the cache' }));
    ok(await pm.put(`/api/problems/${p}/assessment`, { ec_decision: 'fix' }));
    ok(await analyst.patch(`/api/problems/${p}`, { fix_type: fixType }));
    return p;
  };
  /** A low-risk change, authorised and started; `finish` takes it to review with an outcome. */
  const change = async (ref?: string) => {
    const plans = { implementation_plan: 'Deploy', backout_plan: 'Redeploy the last release', planned_start: at(60), planned_end: at(120) };
    const c = ref ?? ok(await analyst.post('/api/changes', { title: `Release ${++n}`, risk: 'low', cis: [ci], ...plans }), 201).ref as string;
    if (ref) ok(await analyst.patch(`/api/changes/${c}`, { risk: 'low', ...plans }));
    if (ref) ok(await analyst.post(`/api/records/${c}/links`, { to: ci }));
    for (const to of ['assess', 'authorize']) ok(await analyst.post(`/api/changes/${c}/transition`, { to }));
    ok(await pm.post(`/api/changes/${c}/votes`, { decision: 'approve' }));
    ok(await analyst.post(`/api/changes/${c}/transition`, { to: 'implementing' }));
    return c;
  };
  const finish = (c: string, outcome: string) => analyst.post(`/api/changes/${c}/transition`, { to: 'review', outcome }).then(ok);
  const problem = async (p: string) => ok(await analyst.get(`/api/problems/${p}`));

  before(async () => {
    k = await startKernel();
    [admin, pm, analyst] = await Promise.all([k.login('admin'), k.login('pm'), k.login('analyst')]);
    ok(await admin.put('/api/admin/modules', { development: true, reason: 'Teams build what they run' }));
    ci = ok(await pm.post('/api/cis', { name: 'payroll-app', ci_type: 'application', criticality: 3 }), 201).ref;
  });
  after(async () => k?.close());

  test('a change lists what it delivers; a link made from the problem or the change is in both histories', async () => {
    const p = ok(await analyst.post('/api/problems', { title: 'Linked from the problem' }), 201).ref;
    const story = ok(await analyst.post('/api/work-items', { type: 'story', title: 'Faster payslips' }), 201).ref;
    ok(await analyst.post(`/api/records/${p}/links`, { to: story }));
    assert.ok((await problem(p)).activity.some((a: any) => a.kind === 'link' && a.body === `Linked work item ${story}`), 'logged on the problem');
    assert.ok(ok(await analyst.get(`/api/work-items/${story}`)).activity.some((a: any) => a.body === `Linked problem ${p}`), 'and on the story');

    const chg = ok(await pm.post('/api/changes', { title: 'Release 4.3' }), 201).ref;
    ok(await pm.post(`/api/records/${chg}/links`, { to: story }));
    const c = ok(await analyst.get(`/api/changes/${chg}`));
    assert.deepEqual(c.work_items.map((w: any) => [w.ref, w.item_type, w.status]), [[story, 'story', 'new']]);
    assert.ok(c.activity.some((a: any) => a.body === `Linked work item ${story}`));

    const w = ok(await analyst.get(`/api/work-items/${story}`));
    ok(await analyst.del(`/api/work-items/${story}/links/${w.links.find((l: any) => l.kind === 'change').id}`));
    const after = ok(await analyst.get(`/api/changes/${chg}`));
    assert.deepEqual(after.work_items, []);
    assert.ok(after.activity.some((a: any) => a.body === `Unlinked work item ${story}`));
  });

  test('path A: the bug is done and its change implemented, the fix is watched, then resolving is suggested', async () => {
    const p = await knownError('Payslips show last month', 'code');
    const bug = ok(await analyst.post(`/api/records/${p}/work-items`, {}), 201).ref;
    const chg = await change();
    ok(await analyst.post(`/api/records/${chg}/links`, { to: bug }));
    assert.equal((await problem(p)).next_steps.handover.label, 'The fix is planned', 'the bug is still open');

    ok(await analyst.post(`/api/work-items/${bug}/transition`, { to: 'in_progress' }));
    ok(await analyst.post(`/api/work-items/${bug}/transition`, { to: 'done' }));
    let r = await problem(p);
    assert.equal(r.next_steps.handover.label, `The fix goes out with ${chg}`);
    assert.equal(r.fix.deployed, null);

    await finish(chg, 'successful');
    r = await problem(p);
    assert.equal(r.fix.deployed.change, chg);
    assert.equal(r.fix.observation_days, 7);
    assert.match(r.next_steps.handover.label, /^The fix is deployed: watch until \d{4}-\d{2}-\d{2}$/);
    assert.equal(r.next_steps.handover.action, undefined, 'no suggestion to resolve yet');
    assert.ok(r.activity.some((a: any) => a.body === `Change ${chg} implemented: successful`), 'the change is noted on the problem it fixes through the bug');
    assert.equal(r.status, 'known_error', 'never a status change by itself');

    // A shorter window is the problem's own setting.
    assert.equal((await analyst.patch(`/api/problems/${p}`, { fix_observation_days: 0 })).status, 400);
    ok(await analyst.patch(`/api/problems/${p}`, { fix_observation_days: 3 }));
    await ownerQuery("UPDATE changes SET actual_end = now() - interval '4 days' WHERE ref = $1", [chg]);
    await ownerQuery("UPDATE problems SET known_error_at = now() - interval '6 days' WHERE ref = $1", [p]);
    r = await problem(p);
    assert.equal(r.fix.observation_days, 3);
    assert.deepEqual([r.next_steps.handover.action, r.next_steps.handover.target], ['resolve_problem', chg]);
    assert.match(r.next_steps.handover.hint, /No new incidents in 3 days/);

    // A new incident on the problem after the deploy: the fix may not hold.
    const inc = ok(await analyst.post('/api/incidents', { title: 'Payslip shows September again' }), 201).ref;
    ok(await analyst.post(`/api/records/${inc}/links`, { to: p, kind: 'problem' }));
    r = await problem(p);
    assert.deepEqual(r.fix.recurred.map((i: any) => i.ref), [inc]);
    assert.equal(r.next_steps.handover.label, '1 incident since the fix');
    assert.equal(r.next_steps.handover.action, undefined);

    const kpis = ok(await pm.get('/api/dashboard/kpis')).tiles;
    const lead = kpis.find((t: any) => t.id === 'fix_lead_time');
    assert.ok(lead.trend.some((v: number | null) => v !== null && v >= 2 * 1440 - 1), 'two days from the known error to the deploy');
    assert.ok(kpis.find((t: any) => t.id === 'recurred_after_fix').value >= 1);
  });

  test('path D: a configuration fix through a change raised on the problem; a rollback is never suggested as the fix', async () => {
    const p = await knownError('Leave requests go to the wrong approver', 'configuration');
    const raised = ok(await analyst.post(`/api/problems/${p}/change`, {}), 201).ref;
    const chg = await change(raised);
    assert.equal((await problem(p)).next_steps.handover.label, `The fix goes out with ${chg}`);
    await finish(chg, 'rolled_back');
    const r = await problem(p);
    assert.equal(r.fix.deployed, null);
    assert.deepEqual(r.fix.failed, { change: chg, outcome: 'rolled_back' });
    assert.equal(r.next_steps.handover.label, `The fix in ${chg} was rolled back`);
    assert.equal(r.next_steps.handover.action, undefined);
  });

  test('without the development module the fix tiles are gone', async () => {
    ok(await admin.put('/api/admin/modules', { development: false, reason: 'Off' }));
    try {
      const ids = ok(await pm.get('/api/dashboard/kpis')).tiles.map((t: any) => t.id);
      assert.ok(!ids.includes('fix_lead_time') && !ids.includes('recurred_after_fix'));
    } finally {
      ok(await admin.put('/api/admin/modules', { development: true, reason: 'On' }));
    }
  });
});
