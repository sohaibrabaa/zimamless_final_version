import {
  BUSINESS_SECONDS_PER_DAY,
  ONBOARDING_SLA_BUSINESS_SECONDS,
  addBusinessSeconds,
  businessDateKey,
  businessSecondsBetween,
  isWithinBusinessHours,
} from './business-time';

/**
 * Business-time arithmetic (ZM-SON-008).
 *
 * The phase file is explicit that holiday spans and pause/resume
 * reconstruction get unit tests in Phase 2 rather than Phase 9, because
 * every one of these cases is invisible in a demo that happens to run on a
 * Tuesday morning.
 *
 * Jordan sits on UTC+3 year-round, so an Amman wall-clock time of 08:00 is
 * 05:00Z. The fixtures below are written in UTC with the local time named
 * in a comment, so a timezone regression shows up as a failing assertion
 * rather than as a test that quietly agrees with the bug.
 */

const NO_HOLIDAYS: ReadonlySet<string> = new Set();

/** An Amman wall-clock time expressed as the UTC instant it denotes. */
const amman = (iso: string): Date => new Date(`${iso}+03:00`);

describe('business-time', () => {
  describe('the working week', () => {
    // 2026-07-19 is a Sunday; 2026-07-23 a Thursday; 24th Fri, 25th Sat.
    it('counts Sunday through Thursday as working days', () => {
      for (const day of ['19', '20', '21', '22', '23']) {
        const noon = amman(`2026-07-${day}T12:00:00`);
        expect(isWithinBusinessHours(noon, NO_HOLIDAYS)).toBe(true);
      }
    });

    it('treats Friday and Saturday as the weekend, not Saturday and Sunday', () => {
      expect(isWithinBusinessHours(amman('2026-07-24T12:00:00'), NO_HOLIDAYS)).toBe(false);
      expect(isWithinBusinessHours(amman('2026-07-25T12:00:00'), NO_HOLIDAYS)).toBe(false);
      // The Gregorian-Monday mistake would make Sunday non-working.
      expect(isWithinBusinessHours(amman('2026-07-26T12:00:00'), NO_HOLIDAYS)).toBe(true);
    });

    it('opens at 08:00 and closes at 17:00 Amman time', () => {
      expect(isWithinBusinessHours(amman('2026-07-21T07:59:59'), NO_HOLIDAYS)).toBe(false);
      expect(isWithinBusinessHours(amman('2026-07-21T08:00:00'), NO_HOLIDAYS)).toBe(true);
      expect(isWithinBusinessHours(amman('2026-07-21T16:59:59'), NO_HOLIDAYS)).toBe(true);
      // 17:00 is the close, so it is outside — the window is half-open.
      expect(isWithinBusinessHours(amman('2026-07-21T17:00:00'), NO_HOLIDAYS)).toBe(false);
    });

    it('interprets instants in Amman time, not the machine timezone', () => {
      // 06:00Z is 09:00 in Amman — inside hours. A UTC-based implementation
      // would call it outside.
      expect(isWithinBusinessHours(new Date('2026-07-21T06:00:00Z'), NO_HOLIDAYS)).toBe(true);
      // 15:00Z is 18:00 in Amman — outside. A UTC-based one would say inside.
      expect(isWithinBusinessHours(new Date('2026-07-21T15:00:00Z'), NO_HOLIDAYS)).toBe(false);
      expect(businessDateKey(new Date('2026-07-21T22:00:00Z'))).toBe('2026-07-22');
    });
  });

  describe('businessSecondsBetween', () => {
    it('counts a plain interval inside one working day', () => {
      const from = amman('2026-07-21T09:00:00');
      const to = amman('2026-07-21T11:30:00');
      expect(businessSecondsBetween(from, to, NO_HOLIDAYS)).toBe(2.5 * 3600);
    });

    it('excludes the overnight gap between two working days', () => {
      // 16:00 Tue → 09:00 Wed = 1h before close + 1h after open.
      const from = amman('2026-07-21T16:00:00');
      const to = amman('2026-07-22T09:00:00');
      expect(businessSecondsBetween(from, to, NO_HOLIDAYS)).toBe(2 * 3600);
    });

    it('excludes the whole weekend', () => {
      // Thu 16:00 → Sun 09:00. One hour Thursday, nothing Fri/Sat, one hour
      // Sunday. A wall-clock implementation would report 65 hours.
      const from = amman('2026-07-23T16:00:00');
      const to = amman('2026-07-26T09:00:00');
      expect(businessSecondsBetween(from, to, NO_HOLIDAYS)).toBe(2 * 3600);
    });

    it('excludes a holiday that falls mid-week', () => {
      const holidays = new Set(['2026-07-22']); // the Wednesday
      const from = amman('2026-07-21T16:00:00');
      const to = amman('2026-07-23T09:00:00');
      // Without the holiday: 1h Tue + 9h Wed + 1h Thu = 11h.
      expect(businessSecondsBetween(from, to, NO_HOLIDAYS)).toBe(11 * 3600);
      // With it, Wednesday contributes nothing.
      expect(businessSecondsBetween(from, to, holidays)).toBe(2 * 3600);
    });

    it('excludes a holiday span that swallows a full working week', () => {
      const holidays = new Set([
        '2026-07-19',
        '2026-07-20',
        '2026-07-21',
        '2026-07-22',
        '2026-07-23',
      ]);
      const from = amman('2026-07-19T08:00:00');
      const to = amman('2026-07-23T17:00:00');
      expect(businessSecondsBetween(from, to, NO_HOLIDAYS)).toBe(5 * BUSINESS_SECONDS_PER_DAY);
      expect(businessSecondsBetween(from, to, holidays)).toBe(0);
    });

    it('contributes nothing for an interval entirely outside working hours', () => {
      const from = amman('2026-07-24T09:00:00'); // Friday
      const to = amman('2026-07-25T17:00:00'); // Saturday
      expect(businessSecondsBetween(from, to, NO_HOLIDAYS)).toBe(0);
    });

    it('clamps a range that starts before opening and ends after closing', () => {
      const from = amman('2026-07-21T03:00:00');
      const to = amman('2026-07-21T23:00:00');
      expect(businessSecondsBetween(from, to, NO_HOLIDAYS)).toBe(BUSINESS_SECONDS_PER_DAY);
    });

    it('returns 0 rather than a negative count when the interval is inverted', () => {
      const from = amman('2026-07-21T11:00:00');
      const to = amman('2026-07-21T09:00:00');
      // A negative contribution would silently cancel out real elapsed time
      // in the event-sourced sum.
      expect(businessSecondsBetween(from, to, NO_HOLIDAYS)).toBe(0);
      expect(businessSecondsBetween(from, from, NO_HOLIDAYS)).toBe(0);
    });

    it('rejects an invalid Date instead of returning NaN', () => {
      expect(() => businessSecondsBetween(new Date('nope'), amman('2026-07-21T09:00:00'), NO_HOLIDAYS)).toThrow(
        /invalid Date/,
      );
    });
  });

  describe('addBusinessSeconds', () => {
    it('adds within a single working day', () => {
      const from = amman('2026-07-21T09:00:00');
      expect(addBusinessSeconds(from, 2 * 3600, NO_HOLIDAYS).toISOString()).toBe(
        amman('2026-07-21T11:00:00').toISOString(),
      );
    });

    it('rolls over the overnight gap', () => {
      // 16:00 + 3h = 1h today, 2h tomorrow → 10:00 next working day.
      const from = amman('2026-07-21T16:00:00');
      expect(addBusinessSeconds(from, 3 * 3600, NO_HOLIDAYS).toISOString()).toBe(
        amman('2026-07-22T10:00:00').toISOString(),
      );
    });

    it('skips the weekend', () => {
      // Thursday 16:00 + 3h → Sunday 10:00.
      const from = amman('2026-07-23T16:00:00');
      expect(addBusinessSeconds(from, 3 * 3600, NO_HOLIDAYS).toISOString()).toBe(
        amman('2026-07-26T10:00:00').toISOString(),
      );
    });

    it('skips holidays', () => {
      const holidays = new Set(['2026-07-22']);
      const from = amman('2026-07-21T16:00:00');
      // Without the holiday, 3h lands Wednesday 10:00; with it, Thursday.
      expect(addBusinessSeconds(from, 3 * 3600, NO_HOLIDAYS).toISOString()).toBe(
        amman('2026-07-22T10:00:00').toISOString(),
      );
      expect(addBusinessSeconds(from, 3 * 3600, holidays).toISOString()).toBe(
        amman('2026-07-23T10:00:00').toISOString(),
      );
    });

    it('starts the budget at the next opening when it begins out of hours', () => {
      // Submitted Friday morning — the clock cannot start until Sunday 08:00.
      const from = amman('2026-07-24T09:00:00');
      expect(addBusinessSeconds(from, 3600, NO_HOLIDAYS).toISOString()).toBe(
        amman('2026-07-26T09:00:00').toISOString(),
      );
      // A zero budget resolves to the moment work could begin.
      expect(addBusinessSeconds(from, 0, NO_HOLIDAYS).toISOString()).toBe(
        amman('2026-07-26T08:00:00').toISOString(),
      );
    });

    it('places the 24-business-hour onboarding SLA correctly', () => {
      // Sunday 09:00 + 24 business hours: 8h Sun (to 17:00), 9h Mon, 7h Tue
      // → Tuesday 15:00. Three calendar days for a "24 hour" SLA, which is
      // exactly why it is expressed in business time.
      const submitted = amman('2026-07-19T09:00:00');
      const deadline = addBusinessSeconds(submitted, ONBOARDING_SLA_BUSINESS_SECONDS, NO_HOLIDAYS);
      expect(deadline.toISOString()).toBe(amman('2026-07-21T15:00:00').toISOString());
    });

    it('pushes the SLA deadline across the weekend when submitted late in the week', () => {
      // Wednesday 15:00 + 24 business hours: 2h Wed, 9h Thu, 9h Sun, 4h Mon
      // → Monday 12:00.
      const submitted = amman('2026-07-22T15:00:00');
      const deadline = addBusinessSeconds(submitted, ONBOARDING_SLA_BUSINESS_SECONDS, NO_HOLIDAYS);
      expect(deadline.toISOString()).toBe(amman('2026-07-27T12:00:00').toISOString());
    });

    it('rejects a negative or fractional budget', () => {
      const from = amman('2026-07-21T09:00:00');
      expect(() => addBusinessSeconds(from, -1, NO_HOLIDAYS)).toThrow(/negative/);
      expect(() => addBusinessSeconds(from, 1.5, NO_HOLIDAYS)).toThrow(/whole number/);
    });

    it('fails loudly rather than looping forever on an unsatisfiable budget', () => {
      const from = amman('2026-07-21T09:00:00');
      expect(() => addBusinessSeconds(from, 100 * 365 * 24 * 3600, NO_HOLIDAYS)).toThrow(
        /without exhausting the budget/,
      );
    });
  });

  describe('the two operations agree', () => {
    it('round-trips: elapsed between start and deadline equals the budget', () => {
      const cases = [
        amman('2026-07-19T08:00:00'),
        amman('2026-07-21T13:37:00'),
        amman('2026-07-23T16:59:00'),
        amman('2026-07-24T11:00:00'), // starts on a Friday
      ];
      const holidays = new Set(['2026-07-27']);
      for (const start of cases) {
        const deadline = addBusinessSeconds(start, ONBOARDING_SLA_BUSINESS_SECONDS, holidays);
        expect(businessSecondsBetween(start, deadline, holidays)).toBe(
          ONBOARDING_SLA_BUSINESS_SECONDS,
        );
      }
    });
  });
});
