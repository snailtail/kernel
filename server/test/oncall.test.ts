import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInbound, rotationOnCall } from '../src/people/oncall.js';

const rot = { members: [1, 2, 3], handover_dow: 1, handover_minute: 540, timezone: 'Europe/Stockholm', starts_on: '2026-10-07' };
const at = (s: string) => new Date(s).getTime();

test('the rotation hands over weekly, Monday 09:00 local, across daylight saving', () => {
  // starts_on is a Wednesday: the first handover is the Monday before, 5 October 2026 09:00 CEST (07:00 UTC).
  assert.deepEqual(rotationOnCall(rot, [], at('2026-10-05T07:00:00Z')), { user_id: 1, until: '2026-10-12T07:00:00.000Z' });
  assert.equal(rotationOnCall(rot, [], at('2026-10-12T06:59:00Z'))!.user_id, 1, 'until the handover minute');
  assert.equal(rotationOnCall(rot, [], at('2026-10-12T07:00:00Z'))!.user_id, 2);
  assert.equal(rotationOnCall(rot, [], at('2026-10-19T07:00:00Z'))!.user_id, 3);
  // Summer time ends on 25 October: the 26 October handover is 09:00 CET, 08:00 UTC.
  assert.equal(rotationOnCall(rot, [], at('2026-10-26T07:30:00Z'))!.user_id, 3, 'still last week\'s person at 08:30 CET');
  assert.deepEqual(rotationOnCall(rot, [], at('2026-10-26T08:00:00Z')), { user_id: 1, until: '2026-11-02T08:00:00.000Z' });
  assert.equal(rotationOnCall(rot, [], at('2026-10-01T00:00:00Z'))!.user_id, 1, 'before the start: the first member');
});

test('an override wins while it lasts; an empty rotation has nobody', () => {
  const ov = [{ user_id: 9, starts_at: '2026-10-13T00:00:00Z', ends_at: '2026-10-14T00:00:00Z' }];
  assert.deepEqual(rotationOnCall(rot, ov, at('2026-10-13T12:00:00Z')), { user_id: 9, until: '2026-10-14T00:00:00.000Z' });
  assert.equal(rotationOnCall(rot, ov, at('2026-10-14T00:00:00Z'))!.user_id, 2);
  assert.equal(rotationOnCall({ ...rot, members: [] }, [], at('2026-10-13T12:00:00Z')), null);
});

test('inbound webhooks: PagerDuty, Opsgenie, Grafana OnCall and the generic form, with anchored actions', () => {
  assert.deepEqual(parseInbound({ event: { event_type: 'incident.acknowledged', agent: { summary: 'Nora' }, data: { title: 'INC000012: router' } } }), { refs: ['INC000012'], bulk: null, action: 'acknowledge', by: 'Nora' });
  assert.deepEqual(parseInbound({ action: 'Acknowledge', alert: { alias: 'INC000012', username: 'dba@example.com' } }), { refs: ['INC000012'], bulk: null, action: 'acknowledge', by: 'dba@example.com' });
  assert.equal(parseInbound({ alert_uid: 'INC000012', state: 'ok' })?.action, 'resolve');
  assert.equal(parseInbound({ event: { event_type: 'incident.resolved', data: { title: 'INC000012' } } })?.action, 'resolve');
  assert.deepEqual(parseInbound({ ref: 'inc000012', action: 'resolve', by: 'sms-gw' }), { refs: ['INC000012'], bulk: null, action: 'resolve', by: 'sms-gw' });
  assert.deepEqual(parseInbound({ ref: 'INC000012', note: 'see INC000099', action: 'ack' })?.refs, ['INC000012', 'INC000099'], 'explicit ref first');
  assert.equal(parseInbound({ action: 'acknowledge' }), null, 'no ref');
  // A bulk page (#125) is known by its key, alone or next to the refs it names.
  const key = 'bulk:0f8b6c1e-2d3a-4b5c-8d9e-0a1b2c3d4e5f';
  assert.deepEqual(parseInbound({ alert: { alias: key, username: 'dba' }, action: 'Acknowledge' }), { refs: [], bulk: key, action: 'acknowledge', by: 'dba' });
  assert.equal(parseInbound({ event: { event_type: 'incident.acknowledged', data: { incident_key: key.toUpperCase(), title: '5 incidents: INC000001, INC000002' } } })?.bulk, key);
  assert.equal(parseInbound({ ref: 'bulk:not-a-key', action: 'ack' }), null);
  assert.equal(parseInbound({ ref: 'INC000012', action: 'snooze' }), null, 'nothing Kernel acts on');
  assert.equal(parseInbound({ ref: 'INC000012', state: 'lookup' }), null, 'not an unanchored "ok"');
});
