import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeEntry, recordPath, showValue, type AuditEntry } from '../src/components/History.js';

const entry = (e: Partial<AuditEntry>): AuditEntry => ({
  id: 1, at: '2026-10-17T10:00:00Z', actor_user_id: 2, actor_name: 'Anna', actor_type: 'user', channel: 'web', token_prefix: '',
  request_id: '', entity_type: 'incident', entity_ref: 'INC000001', action: 'update', changes: {}, reason: '', ...e,
});

test('history lines read as sentences (#57)', () => {
  assert.equal(describeEntry(entry({ changes: { priority: { from: 3, to: 2 } } })), 'Anna changed priority 3 → 2');
  assert.equal(describeEntry(entry({ changes: { status: { from: 'new', to: 'in_progress' } } })), 'Anna moved it from new to in progress');
  assert.equal(describeEntry(entry({ action: 'status', changes: { from: 'assess', to: 'authorize' } })), 'Anna moved it from assess to authorize');
  assert.equal(describeEntry(entry({ changes: { affected_person: { id: 4, action: 'add' } } })), 'Anna added affected person');
  assert.equal(describeEntry(entry({ action: 'link', changes: { kind: 'problem', action: 'add', reference: 'PRB000010' } })), 'Anna linked PRB000010');
  assert.equal(describeEntry(entry({ action: 'vote', changes: { decision: 'approve' } })), 'Anna voted approve');
  assert.equal(describeEntry(entry({ action: 'comment', changes: { body: { digest: 'hmac-sha256:k1:ab', length: 12 } } })), 'Anna added a note');
  assert.equal(describeEntry(entry({ changes: { paging: { via: 'rotation', page_id: 1 } } })), 'Anna updated it');
  assert.equal(describeEntry(entry({ actor_name: '', actor_type: 'system', action: 'created' })), 'Kernel created it');
  assert.equal(describeEntry(entry({ actor_name: 'vCenter sync', entity_type: 'ci_upsert', entity_ref: 'vCenter', action: 'upsert' })), 'vCenter sync synced from vCenter');
});

test('digests and masked values show that something changed, not what', () => {
  assert.equal(showValue({ digest: 'hmac-sha256:k1:ab', length: 42 }), 'changed text (42 characters)');
  assert.equal(showValue({ changed: true, length: 5 }), 'changed text (5 characters)');
  assert.equal(showValue({ masked: true }), 'hidden (confidential)');
  assert.equal(showValue('[changed]'), 'changed (secret)');
  assert.equal(describeEntry(entry({ changes: { description: { from: { digest: 'a', length: 3 }, to: { digest: 'b', length: 4 } } } })), 'Anna changed description');
  const text = (n: number) => ({ digest: 'x', length: n });
  assert.equal(describeEntry(entry({ changes: { title: { from: text(3), to: text(4) }, description: { from: text(5), to: text(6) }, impact: { from: 3, to: 1 } } })), 'Anna changed title and description, changed impact 3 → 1');
});

test('record refs link to their page', () => {
  assert.equal(recordPath('PRB000012'), '/problems/PRB000012');
  assert.equal(recordPath('SVC000003'), '/cis/SVC000003');
  assert.equal(recordPath('#42'), null);
});
