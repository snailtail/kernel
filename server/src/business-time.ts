// Business-time arithmetic for SLA clocks (#43). Pure functions: no database and no clock, so they are tested
// directly, including daylight saving changes. Open hours are evaluated in the calendar's IANA time zone.

export interface Calendar {
  timezone: string;
  always: boolean;
  /** ISO weekday (1 = Monday … 7 = Sunday) → open intervals as [start, end] minutes after local midnight. */
  hours: Record<string, [number, number][]>;
  /** Closed days, as local dates 'YYYY-MM-DD'. */
  holidays: Set<string>;
}

const MINUTE = 60_000;
/** Searching further than this for open time means the calendar is (nearly) always closed. */
const MAX_DAYS = 3 * 366;

/** The offset of a time zone from UTC at an instant, in minutes (e.g. +120 for Stockholm in summer). */
function offsetMinutes(timezone: string, at: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((local - Math.floor(at / 1000) * 1000) / MINUTE);
}

/** The UTC instant of a local wall-clock time; nonexistent times (spring forward) move to the next valid minute. */
export function zonedToUtc(timezone: string, y: number, m: number, d: number, minuteOfDay: number) {
  const guess = Date.UTC(y, m - 1, d) + minuteOfDay * MINUTE;
  let utc = guess - offsetMinutes(timezone, guess) * MINUTE;
  utc = guess - offsetMinutes(timezone, utc) * MINUTE;
  return utc;
}

/** The local calendar date (y, m, d) and ISO weekday of an instant in a time zone. */
export function localDate(timezone: string, at: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(new Date(at)).map((p) => [p.type, p.value]),
  );
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday) + 1;
  return { y: +parts.year, m: +parts.month, d: +parts.day, weekday };
}

const pad = (n: number) => String(n).padStart(2, '0');
const nextDay = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), weekday: ((t.getUTCDay() + 6) % 7) + 1 };
};

/** Open intervals of one local day, as UTC instants. */
function openIntervals(cal: Calendar, day: { y: number; m: number; d: number; weekday: number }): [number, number][] {
  if (cal.holidays.has(`${day.y}-${pad(day.m)}-${pad(day.d)}`)) return [];
  return (cal.hours[String(day.weekday)] ?? []).map(([s, e]) => [zonedToUtc(cal.timezone, day.y, day.m, day.d, s), zonedToUtc(cal.timezone, day.y, day.m, day.d, e)]);
}

/** Business minutes between two instants (0 if end is before start). */
export function businessMinutes(cal: Calendar, start: number, end: number): number {
  if (end <= start) return 0;
  if (cal.always) return (end - start) / MINUTE;
  let total = 0;
  let day = localDate(cal.timezone, start);
  for (let n = 0; n < MAX_DAYS; n++) {
    const intervals = openIntervals(cal, day);
    for (const [s, e] of intervals) total += Math.max(0, Math.min(e, end) - Math.max(s, start)) / MINUTE;
    const dayStart = zonedToUtc(cal.timezone, day.y, day.m, day.d, 0);
    if (dayStart > end) break;
    day = nextDay(day.y, day.m, day.d);
  }
  return total;
}

/** The instant when `minutes` business minutes have passed after start. */
export function addBusinessMinutes(cal: Calendar, start: number, minutes: number): number {
  if (cal.always) return start + minutes * MINUTE;
  let left = minutes;
  let day = localDate(cal.timezone, start);
  for (let n = 0; n < MAX_DAYS; n++) {
    for (const [s, e] of openIntervals(cal, day)) {
      const from = Math.max(s, start);
      if (from >= e) continue;
      const available = (e - from) / MINUTE;
      if (available >= left) return from + left * MINUTE;
      left -= available;
    }
    day = nextDay(day.y, day.m, day.d);
  }
  throw new Error('The calendar has no open time within three years');
}

// ---- Swedish public holidays -------------------------------------------------------------------

/** Easter Sunday (Gregorian), anonymous algorithm. */
function easter(year: number) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(year, month - 1, day);
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const DAY = 86_400_000;
/** The date in [from, from + 6] that falls on a weekday (0 = Sunday … 6 = Saturday). */
const weekdayIn = (year: number, month: number, fromDay: number, weekday: number) => {
  for (let d = fromDay; d < fromDay + 7; d++) if (new Date(Date.UTC(year, month - 1, d)).getUTCDay() === weekday) return Date.UTC(year, month - 1, d);
  throw new Error('unreachable');
};

/** Swedish public holidays and the de facto closed eves (midsummer, Christmas and New Year's Eve). */
export function swedishHolidays(year: number): { day: string; name: string }[] {
  const e = easter(year);
  return [
    { day: `${year}-01-01`, name: 'Nyårsdagen' },
    { day: `${year}-01-06`, name: 'Trettondedag jul' },
    { day: iso(e - 2 * DAY), name: 'Långfredagen' },
    { day: iso(e), name: 'Påskdagen' },
    { day: iso(e + DAY), name: 'Annandag påsk' },
    { day: `${year}-05-01`, name: 'Första maj' },
    { day: iso(e + 39 * DAY), name: 'Kristi himmelsfärdsdag' },
    { day: iso(e + 49 * DAY), name: 'Pingstdagen' },
    { day: `${year}-06-06`, name: 'Sveriges nationaldag' },
    { day: iso(weekdayIn(year, 6, 19, 5)), name: 'Midsommarafton' },
    { day: iso(weekdayIn(year, 6, 20, 6)), name: 'Midsommardagen' },
    { day: iso(weekdayIn(year, 10, 31, 6)), name: 'Alla helgons dag' },
    { day: `${year}-12-24`, name: 'Julafton' },
    { day: `${year}-12-25`, name: 'Juldagen' },
    { day: `${year}-12-26`, name: 'Annandag jul' },
    { day: `${year}-12-31`, name: 'Nyårsafton' },
  ];
}
