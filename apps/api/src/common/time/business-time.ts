/**
 * Business-time arithmetic for the Jordanian working week.
 *
 * ZM-SON-008: the onboarding SLA is 24 *business* hours, not 24 wall-clock
 * hours, and it pauses while the platform is waiting on the supplier. Two
 * operations follow from that and nothing else in the codebase should
 * reimplement either:
 *
 *   businessSecondsBetween — how much business time elapsed between two
 *                            instants (the reconstruction half)
 *   addBusinessSeconds     — when a budget of business time runs out (the
 *                            deadline half)
 *
 * Both are pure functions of (instants, holiday set). They take no clock
 * reading of their own, which is what lets the SLA suite assert exact
 * deadlines and what keeps the demo time machine working: the caller
 * supplies "now" from the injected TimeProvider.
 *
 * This file lives in common/time rather than in the onboarding module
 * because the lint rule bans `new Date(...)` under src/modules/** — and
 * calendar arithmetic cannot be written without constructing dates. The
 * placement is the architecture, not a workaround: business time is a
 * property of the platform's clock, and Phase 5 settlement value dates will
 * want the same primitives.
 */

/**
 * Jordan's working week is Sunday–Thursday; Friday and Saturday are the
 * weekend. Getting this wrong in the Gregorian-Monday direction is the
 * classic defect here, so the days are named rather than written as a range.
 */
const SUNDAY = 0;
const MONDAY = 1;
const TUESDAY = 2;
const WEDNESDAY = 3;
const THURSDAY = 4;

const BUSINESS_WEEKDAYS: ReadonlySet<number> = new Set([
  SUNDAY,
  MONDAY,
  TUESDAY,
  WEDNESDAY,
  THURSDAY,
]);

export const BUSINESS_TIMEZONE = 'Asia/Amman';
export const BUSINESS_DAY_START_HOUR = 8;
export const BUSINESS_DAY_END_HOUR = 17;

/** Seconds of business time in one full working day (08:00–17:00 = 9h). */
export const BUSINESS_SECONDS_PER_DAY = (BUSINESS_DAY_END_HOUR - BUSINESS_DAY_START_HOUR) * 3600;

/** ZM-SON-008: the onboarding decision SLA, in business seconds (24h). */
export const ONBOARDING_SLA_BUSINESS_SECONDS = 24 * 3600;

/**
 * A holiday set is keyed by Amman-local `YYYY-MM-DD`, matching
 * `business_calendar_holidays.holiday_date` (a `date`, not a timestamp).
 */
export type HolidaySet = ReadonlySet<string>;

/**
 * Formatting through Intl rather than a fixed +03:00 offset.
 *
 * Jordan abolished seasonal time in 2022 and now sits on UTC+3 year-round,
 * so a hardcoded offset would be correct today. It would also silently
 * become wrong the moment that changes, and the failure mode — SLA
 * deadlines an hour out for part of the year — is one nobody would catch by
 * reading the code. Intl asks the platform's tz database instead.
 */
const AMMAN_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function ammanWallClock(instantMs: number): WallClock {
  const parts = AMMAN_PARTS.formatToParts(new Date(instantMs));
  const get = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new Error(`Intl did not return a "${type}" part for ${BUSINESS_TIMEZONE}.`);
    return Number(found.value);
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** The zone's UTC offset, in ms, at a given instant. */
function ammanOffsetMs(instantMs: number): number {
  const wall = ammanWallClock(instantMs);
  const asIfUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  // Compare against the instant truncated to the second, since the wall
  // clock carries no sub-second precision.
  return asIfUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The instant at which the Amman wall clock reads the given local time.
 *
 * Resolved in two passes: the first offset is looked up using the local
 * time misread as UTC, which lands within a few hours of the true instant
 * — close enough that a second lookup at that instant returns the offset
 * genuinely in force. Without the second pass an offset change between the
 * guess and the answer would be applied inconsistently.
 */
function instantFromAmman(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
  second = 0,
): number {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstPass = asIfUtc - ammanOffsetMs(asIfUtc);
  return asIfUtc - ammanOffsetMs(firstPass);
}

/** Amman-local calendar date as `YYYY-MM-DD`. */
function dateKey(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/** Day of week for a local calendar date, Sunday = 0. */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

interface LocalDate {
  year: number;
  month: number;
  day: number;
}

function nextDay(date: LocalDate): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** The working window of a local date, or null when it is not a working day. */
function businessWindow(
  date: LocalDate,
  holidays: HolidaySet,
): { start: number; end: number } | null {
  if (!BUSINESS_WEEKDAYS.has(weekdayOf(date.year, date.month, date.day))) return null;
  if (holidays.has(dateKey(date.year, date.month, date.day))) return null;
  return {
    start: instantFromAmman(date.year, date.month, date.day, BUSINESS_DAY_START_HOUR),
    end: instantFromAmman(date.year, date.month, date.day, BUSINESS_DAY_END_HOUR),
  };
}

/**
 * A runaway guard on the day-walking loops below. A single SLA is measured
 * in days; ten years of iteration means a bad argument (an epoch-zero date,
 * a holiday set that swallows every day), and spinning forever inside a
 * request is worse than failing loudly.
 */
const MAX_DAYS_WALKED = 3650;

/**
 * Business seconds elapsed between two instants.
 *
 * Counts only the parts of the interval that fall inside a working window,
 * so an interval spanning a weekend, a holiday, or an overnight gap
 * contributes nothing for those spans. Returns 0 when `to` precedes `from`
 * rather than a negative count: the callers are accumulating elapsed time,
 * and a negative contribution there would mask a clock or ordering defect
 * instead of surfacing it.
 */
export function businessSecondsBetween(from: Date, to: Date, holidays: HolidaySet): number {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new Error('businessSecondsBetween received an invalid Date.');
  }
  if (toMs <= fromMs) return 0;

  const startWall = ammanWallClock(fromMs);
  const endWall = ammanWallClock(toMs);
  const lastKey = dateKey(endWall.year, endWall.month, endWall.day);

  let cursor: LocalDate = { year: startWall.year, month: startWall.month, day: startWall.day };
  let totalMs = 0;

  for (let walked = 0; walked <= MAX_DAYS_WALKED; walked += 1) {
    const window = businessWindow(cursor, holidays);
    if (window) {
      const overlapStart = Math.max(fromMs, window.start);
      const overlapEnd = Math.min(toMs, window.end);
      if (overlapEnd > overlapStart) totalMs += overlapEnd - overlapStart;
    }

    if (dateKey(cursor.year, cursor.month, cursor.day) === lastKey) {
      return Math.floor(totalMs / 1000);
    }
    cursor = nextDay(cursor);
  }

  throw new Error(
    `businessSecondsBetween walked more than ${MAX_DAYS_WALKED} days; the interval is implausible.`,
  );
}

/**
 * The instant at which `seconds` of business time, starting at `from`, runs
 * out — the SLA deadline.
 *
 * When `from` falls outside a working window the budget starts at the next
 * window's opening, so an application submitted at 22:00 on a Thursday is
 * not charged for the night or the weekend. A zero budget therefore
 * resolves to "the next moment work could begin", which is the correct
 * answer for an SLA with nothing left: the deadline is now, business-time
 * speaking.
 */
export function addBusinessSeconds(from: Date, seconds: number, holidays: HolidaySet): Date {
  const fromMs = from.getTime();
  if (!Number.isFinite(fromMs)) throw new Error('addBusinessSeconds received an invalid Date.');
  if (seconds < 0) throw new Error('addBusinessSeconds received a negative budget.');
  if (!Number.isSafeInteger(seconds)) {
    throw new Error('addBusinessSeconds requires a whole number of seconds.');
  }

  let remainingMs = seconds * 1000;
  const startWall = ammanWallClock(fromMs);
  let cursor: LocalDate = { year: startWall.year, month: startWall.month, day: startWall.day };

  for (let walked = 0; walked <= MAX_DAYS_WALKED; walked += 1) {
    const window = businessWindow(cursor, holidays);
    if (window) {
      const effectiveStart = Math.max(fromMs, window.start);
      if (effectiveStart < window.end) {
        const capacityMs = window.end - effectiveStart;
        if (remainingMs <= capacityMs) return new Date(effectiveStart + remainingMs);
        remainingMs -= capacityMs;
      }
    }
    cursor = nextDay(cursor);
  }

  throw new Error(
    `addBusinessSeconds walked more than ${MAX_DAYS_WALKED} days without exhausting the budget.`,
  );
}

/** True when the instant falls inside a working window. */
export function isWithinBusinessHours(instant: Date, holidays: HolidaySet): boolean {
  const wall = ammanWallClock(instant.getTime());
  const window = businessWindow(
    { year: wall.year, month: wall.month, day: wall.day },
    holidays,
  );
  if (!window) return false;
  const ms = instant.getTime();
  return ms >= window.start && ms < window.end;
}

/** Amman-local `YYYY-MM-DD` for an instant — the holiday-set key format. */
export function businessDateKey(instant: Date): string {
  const wall = ammanWallClock(instant.getTime());
  return dateKey(wall.year, wall.month, wall.day);
}
