import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addBusinessMinutes, businessMinutes, swedishHolidays, zonedToUtc, type Calendar } from '../src/business-time.js';

const TZ = 'Europe/Stockholm';
const office = (holidays: string[] = []): Calendar => ({
  timezone: TZ, always: false, holidays: new Set(holidays),
  hours: { 1: [[480, 1020]], 2: [[480, 1020]], 3: [[480, 1020]], 4: [[480, 1020]], 5: [[480, 1020]] },
});
const allDay: Calendar = { timezone: TZ, always: false, holidays: new Set(), hours: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [d, [[0, 1440]]])) };
const at = (y: number, m: number, d: number, h: number, min = 0) => zonedToUtc(TZ, y, m, d, h * 60 + min);

test('office hours are 9 h on the days the clocks change, in both directions', () => {
  // 2026-03-29 and 2026-10-25 are Sundays: use the open Monday after, and a calendar open on Sundays.
  const sundays: Calendar = { ...office(), hours: { 7: [[480, 1020]] } };
  assert.equal(businessMinutes(sundays, at(2026, 3, 29, 0), at(2026, 3, 30, 0)), 540);
  assert.equal(businessMinutes(sundays, at(2026, 10, 25, 0), at(2026, 10, 26, 0)), 540);
  assert.equal(businessMinutes(sundays, 10, 5), 0, 'end before start');
});

test('a full local day is 23 h in March and 25 h in October', () => {
  assert.equal(businessMinutes(allDay, at(2026, 3, 29, 0), at(2026, 3, 30, 0)), 23 * 60);
  assert.equal(businessMinutes(allDay, at(2026, 10, 25, 0), at(2026, 10, 26, 0)), 25 * 60);
});

test('evenings, weekends and holidays are closed', () => {
  const cal = office();
  // Friday 16:00 → Monday 09:00 is one hour on Friday and one on Monday.
  assert.equal(businessMinutes(cal, at(2026, 10, 9, 16), at(2026, 10, 12, 9)), 120);
  const xmas = office(swedishHolidays(2026).map((h) => h.day));
  // Wednesday 23 December 16:00 → Monday 28 December 10:00: 1 h + 2 h (24–27 closed).
  assert.equal(businessMinutes(xmas, at(2026, 12, 23, 16), at(2026, 12, 28, 10)), 180);
});

test('adding business time skips closed time and lands inside open hours', () => {
  const cal = office();
  // Friday 16:30 + 60 min → Monday 08:30 local.
  assert.equal(addBusinessMinutes(cal, at(2026, 10, 9, 16, 30), 60), at(2026, 10, 12, 8, 30));
  // Before opening: counted from 08:00.
  assert.equal(addBusinessMinutes(cal, at(2026, 10, 12, 6), 30), at(2026, 10, 12, 8, 30));
  const always: Calendar = { timezone: TZ, always: true, hours: {}, holidays: new Set() };
  assert.equal(addBusinessMinutes(always, at(2026, 10, 24, 23), 120) - at(2026, 10, 24, 23), 120 * 60_000);
  // Round trip.
  const due = addBusinessMinutes(cal, at(2026, 10, 9, 10), 1000);
  assert.equal(businessMinutes(cal, at(2026, 10, 9, 10), due), 1000);
});

test('Swedish holidays include the movable ones', () => {
  const days = Object.fromEntries(swedishHolidays(2026).map((h) => [h.name, h.day]));
  assert.equal(days['Långfredagen'], '2026-04-03');
  assert.equal(days['Annandag påsk'], '2026-04-06');
  assert.equal(days['Kristi himmelsfärdsdag'], '2026-05-14');
  assert.equal(days['Midsommarafton'], '2026-06-19');
  assert.equal(days['Alla helgons dag'], '2026-10-31');
  assert.deepEqual(swedishHolidays(2026).filter((h) => h.customary).map((h) => h.name), ['Midsommarafton', 'Julafton', 'Nyårsafton']);
  assert.equal(Object.fromEntries(swedishHolidays(2027).map((h) => [h.name, h.day]))['Midsommarafton'], '2027-06-25');
  assert.equal(Object.fromEntries(swedishHolidays(2027).map((h) => [h.name, h.day]))['Alla helgons dag'], '2027-11-06');
});
