import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkTransition, priorityOf, type TransitionSubject } from '../src/workflow.js';

const base: TransitionSubject = {
  status: 'analysis',
  is_major: false,
  root_cause: '',
  resolution: '',
  closure_code: null,
  major_review: '',
};

test('priority follows the impact/urgency matrix', () => {
  assert.equal(priorityOf(1, 1), 1);
  assert.equal(priorityOf(2, 3), 4);
  assert.equal(priorityOf(3, 3), 5);
});

test('viewers cannot change status', () => {
  assert.match(checkTransition(base, 'known_error', 'viewer')!, /role/);
});

test('only defined transitions are allowed', () => {
  assert.match(checkTransition({ ...base, status: 'new' }, 'resolved', 'admin')!, /Cannot move/);
  assert.equal(checkTransition({ ...base, status: 'new' }, 'analysis', 'analyst'), null);
});

test('known error requires a root cause', () => {
  assert.match(checkTransition(base, 'known_error', 'analyst')!, /root cause/);
  assert.equal(checkTransition({ ...base, root_cause: 'Leaking connection pool' }, 'known_error', 'analyst'), null);
});

test('resolving requires a resolution', () => {
  assert.match(checkTransition(base, 'resolved', 'analyst')!, /resolution/);
  assert.equal(checkTransition({ ...base, resolution: 'Patched' }, 'resolved', 'analyst'), null);
});

test('closing requires a manager and a closure code', () => {
  const resolved = { ...base, status: 'resolved' as const, closure_code: 'resolved' as const };
  assert.match(checkTransition(resolved, 'closed', 'analyst')!, /problem manager/);
  assert.match(checkTransition({ ...resolved, closure_code: null }, 'closed', 'problem_manager')!, /closure code/);
  assert.equal(checkTransition(resolved, 'closed', 'problem_manager'), null);
});

test('major problems need a review before closing, unless dismissed', () => {
  const major = { ...base, status: 'resolved' as const, is_major: true, closure_code: 'resolved' as const };
  assert.match(checkTransition(major, 'closed', 'problem_manager')!, /major problem review/);
  assert.equal(checkTransition({ ...major, major_review: 'Lessons learned' }, 'closed', 'problem_manager'), null);
  assert.equal(checkTransition({ ...major, closure_code: 'duplicate' }, 'closed', 'problem_manager'), null);
});

test('only managers reopen closed problems', () => {
  const closed = { ...base, status: 'closed' as const };
  assert.match(checkTransition(closed, 'analysis', 'analyst')!, /reopen/);
  assert.equal(checkTransition(closed, 'analysis', 'problem_manager'), null);
});

test('closing without a fix requires an accepted risk', () => {
  const p = { ...base, status: 'known_error' as const, closure_code: 'no_fix' as const };
  assert.match(checkTransition(p, 'closed', 'problem_manager')!, /accept the risk/);
  assert.equal(checkTransition({ ...p, ec_decision: 'accept' }, 'closed', 'problem_manager'), null);
});
