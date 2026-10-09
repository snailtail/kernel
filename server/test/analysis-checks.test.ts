import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAnalysis } from '../src/analysis-checks.js';

test('5 Whys needs evidence or assumptions, a stop decision and a conclusion', () => {
  const weak = checkAnalysis('five_whys', { problem_statement: 'Orders time out', whys: [{ why: 'Why?', because: 'DB slow' }] }, '');
  assert.equal(weak.ready, false);
  assert.ok(weak.findings.some((f) => /evidence/.test(f.message)));
  assert.ok(weak.findings.some((f) => /within our control/.test(f.message)));
  const step = (because: string, evidence = 'metric') => ({ why: 'Why?', because, evidence, assumption: false });
  const good = checkAnalysis(
    'five_whys',
    { problem_statement: 'Orders time out 11–13', whys: [step('Pool exhausted'), step('Connections held'), step('Sync lookup'), step('No load test for big orders')], root_cause_in_control: true },
    'Synchronous lookup holds connections',
  );
  assert.equal(good.ready, true, JSON.stringify(good.findings));
  const blame = checkAnalysis('five_whys', { problem_statement: 'x', whys: [step('a'), step('b'), step('The operator made a mistake')], root_cause_in_control: true }, 'c');
  assert.ok(blame.findings.some((f) => /human error/.test(f.message)));
});

test('Kepner-Tregoe needs IS NOT and tested causes', () => {
  const r = checkAnalysis('kepner_tregoe', { problem_statement: 'X', what: { is: 'a' }, possible_causes: [{ cause: 'c', test: '', result: 'untested' }] }, '');
  assert.ok(r.findings.some((f) => /IS NOT/.test(f.message)));
  assert.ok(r.findings.some((f) => /Test "c"/.test(f.message)));
});

test('Ishikawa wants every category considered', () => {
  const r = checkAnalysis('ishikawa', { effect: 'E', categories: [{ name: 'People', causes: [] }, { name: 'Process', causes: ['p'], considered: false }, { name: 'Supplier', causes: [], considered: true }] }, 'x');
  assert.ok(r.findings.some((f) => /People/.test(f.message) && !/Supplier/.test(f.message)));
});

test('Timelines need a change and timestamps', () => {
  const r = checkAnalysis('timeline', { events: [{ at: 'yesterday', kind: 'incident', description: 'down' }] }, '');
  assert.ok(r.findings.some((f) => /What changed/.test(f.message)));
  assert.ok(r.findings.some((f) => /date and time/.test(f.message)));
});
