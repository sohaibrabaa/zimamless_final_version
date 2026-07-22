import { reconstructSlaClock, SlaClockEvent } from './sla-clock.service';
import { ONBOARDING_SLA_BUSINESS_SECONDS } from '../../common/time/business-time';

/**
 * SLA clock reconstruction (ZM-SON-008).
 *
 * The property under test is that elapsed business time is *derivable from
 * the event log alone* — no running total, no stored counter. Each case
 * builds an event sequence and asserts the reconstruction, because that is
 * the only thing the API ever reads.
 *
 * Times are Amman wall clock (UTC+3). 2026-07-19 is a Sunday.
 */

const NO_HOLIDAYS: ReadonlySet<string> = new Set();
const amman = (iso: string): Date => new Date(`${iso}+03:00`);

const ev = (event: SlaClockEvent['event'], iso: string, reason = 'test'): SlaClockEvent => ({
  event,
  reason,
  occurred_at: amman(iso),
});

const HOURS = 3600;

describe('reconstructSlaClock', () => {
  it('reports an unstarted clock as neither running nor paused', () => {
    const state = reconstructSlaClock([], amman('2026-07-20T10:00:00'), NO_HOLIDAYS);
    expect(state.started).toBe(false);
    expect(state.paused).toBe(false);
    expect(state.elapsedBusinessSeconds).toBe(0);
    expect(state.remainingBusinessSeconds).toBe(ONBOARDING_SLA_BUSINESS_SECONDS);
    // A draft application has no deadline — it has not been submitted.
    expect(state.deadlineAt).toBeNull();
  });

  it('accrues business time from START to now while running', () => {
    const events = [ev('START', '2026-07-19T09:00:00', 'SUBMITTED')];
    const state = reconstructSlaClock(events, amman('2026-07-19T12:00:00'), NO_HOLIDAYS);
    expect(state.elapsedBusinessSeconds).toBe(3 * HOURS);
    expect(state.remainingBusinessSeconds).toBe(ONBOARDING_SLA_BUSINESS_SECONDS - 3 * HOURS);
    expect(state.paused).toBe(false);
    expect(state.deadlineAt).not.toBeNull();
  });

  it('does not accrue time overnight or across a weekend', () => {
    const events = [ev('START', '2026-07-23T16:00:00', 'SUBMITTED')]; // Thursday
    // "Now" is the following Sunday morning — 65 wall-clock hours later.
    const state = reconstructSlaClock(events, amman('2026-07-26T09:00:00'), NO_HOLIDAYS);
    expect(state.elapsedBusinessSeconds).toBe(2 * HOURS);
  });

  it('stops accruing while paused — the defining behaviour', () => {
    const events = [
      ev('START', '2026-07-19T09:00:00', 'SUBMITTED'),
      ev('PAUSE', '2026-07-19T11:00:00', 'INFORMATION_REQUIRED'),
    ];
    // Two hours ran, then the clock stopped. Six hours of wall clock later
    // the elapsed total must be unchanged.
    const atPause = reconstructSlaClock(events, amman('2026-07-19T11:00:00'), NO_HOLIDAYS);
    const muchLater = reconstructSlaClock(events, amman('2026-07-20T15:00:00'), NO_HOLIDAYS);
    expect(atPause.elapsedBusinessSeconds).toBe(2 * HOURS);
    expect(muchLater.elapsedBusinessSeconds).toBe(2 * HOURS);
    expect(muchLater.paused).toBe(true);
    expect(muchLater.pausedReason).toBe('INFORMATION_REQUIRED');
  });

  it('exposes no deadline while paused', () => {
    const events = [
      ev('START', '2026-07-19T09:00:00'),
      ev('PAUSE', '2026-07-19T11:00:00', 'INFORMATION_REQUIRED'),
    ];
    const state = reconstructSlaClock(events, amman('2026-07-20T15:00:00'), NO_HOLIDAYS);
    // A paused clock has no deadline. Projecting one from "if it resumed
    // now" would show the supplier a date that moves on every refresh.
    expect(state.deadlineAt).toBeNull();
    expect(state.remainingBusinessSeconds).toBe(ONBOARDING_SLA_BUSINESS_SECONDS - 2 * HOURS);
  });

  it('resumes accruing from the RESUME instant, not from the pause', () => {
    const events = [
      ev('START', '2026-07-19T09:00:00'),
      ev('PAUSE', '2026-07-19T11:00:00', 'INFORMATION_REQUIRED'),
      ev('RESUME', '2026-07-20T09:00:00', 'INFORMATION_PROVIDED'),
    ];
    const state = reconstructSlaClock(events, amman('2026-07-20T12:00:00'), NO_HOLIDAYS);
    // 2h before the pause + 3h after the resume. The 15 business hours the
    // supplier spent responding are not charged to the platform.
    expect(state.elapsedBusinessSeconds).toBe(5 * HOURS);
    expect(state.paused).toBe(false);
    expect(state.pausedReason).toBeNull();
  });

  it('reconstructs a multi-pause history exactly', () => {
    const events = [
      ev('START', '2026-07-19T09:00:00'),
      ev('PAUSE', '2026-07-19T10:30:00', 'INFORMATION_REQUIRED'), // 1.5h
      ev('RESUME', '2026-07-19T14:00:00', 'INFORMATION_PROVIDED'),
      ev('PAUSE', '2026-07-19T16:00:00', 'GOVERNMENT_SERVICE_UNAVAILABLE'), // +2h
      ev('RESUME', '2026-07-20T08:00:00', 'GOVERNMENT_SERVICE_RESTORED'),
      ev('PAUSE', '2026-07-20T09:15:00', 'INFORMATION_REQUIRED'), // +1.25h
    ];
    const state = reconstructSlaClock(events, amman('2026-07-22T10:00:00'), NO_HOLIDAYS);
    expect(state.elapsedBusinessSeconds).toBe(4.75 * HOURS);
    expect(state.paused).toBe(true);
    expect(state.pausedReason).toBe('INFORMATION_REQUIRED');
  });

  it('freezes the total at STOP and ignores anything after it', () => {
    const events = [
      ev('START', '2026-07-19T09:00:00'),
      ev('STOP', '2026-07-19T13:00:00', 'APPROVED'),
      // A stray event after the decision must not resurrect the clock.
      ev('RESUME', '2026-07-20T09:00:00', 'spurious'),
    ];
    const state = reconstructSlaClock(events, amman('2026-07-21T16:00:00'), NO_HOLIDAYS);
    expect(state.elapsedBusinessSeconds).toBe(4 * HOURS);
    expect(state.stopped).toBe(true);
    expect(state.paused).toBe(false);
    expect(state.deadlineAt).toBeNull();
  });

  it('excludes holidays from a running interval', () => {
    const holidays = new Set(['2026-07-20']); // the Monday
    const events = [ev('START', '2026-07-19T16:00:00')];
    const now = amman('2026-07-21T09:00:00');
    // Sun 16:00→17:00 = 1h, Monday is a holiday, Tue 08:00→09:00 = 1h.
    expect(reconstructSlaClock(events, now, holidays).elapsedBusinessSeconds).toBe(2 * HOURS);
    // Without the holiday the same window is 1h + 9h + 1h.
    expect(reconstructSlaClock(events, now, NO_HOLIDAYS).elapsedBusinessSeconds).toBe(11 * HOURS);
  });

  it('marks a breach once the budget is spent, without going negative', () => {
    const events = [ev('START', '2026-07-19T08:00:00')];
    // 24 business hours from Sunday 08:00 lands Tuesday 14:00; ask later.
    const state = reconstructSlaClock(events, amman('2026-07-22T12:00:00'), NO_HOLIDAYS);
    expect(state.remainingBusinessSeconds).toBe(0);
    expect(state.breached).toBe(true);
    expect(state.elapsedBusinessSeconds).toBeGreaterThan(ONBOARDING_SLA_BUSINESS_SECONDS);
  });

  it('places the deadline exactly at the end of the remaining budget', () => {
    const events = [ev('START', '2026-07-19T09:00:00')];
    const now = amman('2026-07-19T12:00:00'); // 3h spent, 21h left
    const state = reconstructSlaClock(events, now, NO_HOLIDAYS);
    // 21 business hours from Sunday 12:00: 5h Sun, 9h Mon, 7h Tue → Tue 15:00.
    expect(state.deadlineAt?.toISOString()).toBe(amman('2026-07-21T15:00:00').toISOString());
  });

  describe('tolerating a messy log', () => {
    // These cases are why reconstruction is permissive. A retried request or
    // a double-click must not corrupt the total — the SLA tracker staying up
    // and slightly generous beats it refusing to render.
    it('ignores a duplicate PAUSE', () => {
      const clean = [
        ev('START', '2026-07-19T09:00:00'),
        ev('PAUSE', '2026-07-19T11:00:00', 'INFORMATION_REQUIRED'),
      ];
      const duplicated = [...clean, ev('PAUSE', '2026-07-19T11:00:05', 'INFORMATION_REQUIRED')];
      const now = amman('2026-07-20T10:00:00');
      expect(reconstructSlaClock(duplicated, now, NO_HOLIDAYS).elapsedBusinessSeconds).toBe(
        reconstructSlaClock(clean, now, NO_HOLIDAYS).elapsedBusinessSeconds,
      );
    });

    it('ignores a RESUME while already running', () => {
      const events = [
        ev('START', '2026-07-19T09:00:00'),
        ev('RESUME', '2026-07-19T10:00:00', 'spurious'),
      ];
      // Honouring it would reset the run start and lose the first hour.
      const state = reconstructSlaClock(events, amman('2026-07-19T12:00:00'), NO_HOLIDAYS);
      expect(state.elapsedBusinessSeconds).toBe(3 * HOURS);
    });

    it('ignores a second START rather than handing back spent time', () => {
      const events = [
        ev('START', '2026-07-19T09:00:00'),
        ev('START', '2026-07-19T14:00:00', 'resubmitted'),
      ];
      const state = reconstructSlaClock(events, amman('2026-07-19T16:00:00'), NO_HOLIDAYS);
      expect(state.elapsedBusinessSeconds).toBe(7 * HOURS);
    });

    it('ignores a RESUME that arrives before any START', () => {
      const events = [ev('RESUME', '2026-07-19T09:00:00', 'orphan')];
      const state = reconstructSlaClock(events, amman('2026-07-19T12:00:00'), NO_HOLIDAYS);
      expect(state.started).toBe(false);
      expect(state.elapsedBusinessSeconds).toBe(0);
    });
  });

  it('is a pure function of the log — replaying gives the same answer', () => {
    const events = [
      ev('START', '2026-07-19T09:00:00'),
      ev('PAUSE', '2026-07-19T11:00:00', 'INFORMATION_REQUIRED'),
      ev('RESUME', '2026-07-20T09:00:00', 'INFORMATION_PROVIDED'),
      ev('STOP', '2026-07-20T15:00:00', 'APPROVED'),
    ];
    const now = amman('2026-07-22T09:00:00');
    const first = reconstructSlaClock(events, now, NO_HOLIDAYS);
    const second = reconstructSlaClock([...events], now, NO_HOLIDAYS);
    expect(second).toEqual(first);
    // 2h + 6h, decided inside the 24-hour SLA.
    expect(first.elapsedBusinessSeconds).toBe(8 * HOURS);
    expect(first.elapsedBusinessSeconds).toBeLessThan(ONBOARDING_SLA_BUSINESS_SECONDS);
  });
});
