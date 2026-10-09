import assert from 'node:assert/strict';
import { test } from 'node:test';
import { duration, relativeTime } from '../src/format.js';

test('relative times pick the unit from the size of the difference, past or future', () => {
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  assert.match(relativeTime(at(2 * 3600_000 + 5000)), /in 2 hours/);
  assert.match(relativeTime(at(-2 * 3600_000)), /2 hours ago/);
  assert.match(relativeTime(at(3 * 86400_000 + 60_000)), /in 3 days/);
});

test('durations in minutes read naturally', () => {
  assert.equal(duration(45), '45 min');
  assert.equal(duration(90), '1.5 h');
  assert.equal(duration(2880), '2 d');
  assert.equal(duration(null), '–');
});
