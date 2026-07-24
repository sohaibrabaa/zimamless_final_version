import {
  automationPaused,
  daysPastDue,
  daysUntilDue,
  derivedOutstanding,
  isSweepable,
  maturityAction,
  overdueDays,
  reminderDue,
  stateAfterPayment,
  totalPaid,
} from './maturity';
import { Money } from '../../common/money/money';

/**
 * ZM-PMT-008..011 — the platform never asserts a default it cannot see.
 *
 * The headline test here asserts an *absence*: there is no input for which
 * `maturityAction` proposes `OVERDUE`. That is the phase's defining behaviour,
 * and an absence is the only way to state it that a future change cannot
 * quietly weaken.
 */

const DUE = new Date('2026-08-30T00:00:00.000Z');

describe('ZM-PMT-008..011 — a passed due date is not proof of default', () => {
  it('NEVER proposes OVERDUE, from any state, at any distance past due', () => {
    for (const state of ['FUNDED', 'PARTIALLY_PAID', 'OVERDUE_UNCONFIRMED'] as const) {
      for (const daysLate of [1, 7, 30, 365, 3650]) {
        const now = new Date(DUE.getTime() + daysLate * 86_400_000);
        // Not "is not OVERDUE" — the return type cannot express it. This
        // asserts the behaviour the type is protecting.
        expect(maturityAction(state, DUE, now)).not.toBe('OVERDUE');
      }
    }
  });

  it('moves a funded transaction to OVERDUE_UNCONFIRMED the day after it falls due', () => {
    const dayAfter = new Date('2026-08-31T00:00:00.000Z');
    expect(maturityAction('FUNDED', DUE, dayAfter)).toBe('OVERDUE_UNCONFIRMED');
  });

  it('does nothing ON the due date — an invoice due today is not late', () => {
    // 23:59 on the due date is still the due date. A timezone-naive comparison
    // would make a Jordanian invoice overdue while it is still the 30th in
    // Amman, which is how a supplier gets a default notice for paying on time.
    expect(maturityAction('FUNDED', DUE, new Date('2026-08-30T00:00:00.000Z'))).toBeNull();
    expect(maturityAction('FUNDED', DUE, new Date('2026-08-30T23:59:59.999Z'))).toBeNull();
  });

  it('does nothing before the due date', () => {
    expect(maturityAction('FUNDED', DUE, new Date('2026-08-29T23:59:00.000Z'))).toBeNull();
  });

  it('acts on a partly-paid transaction too — part payment does not stop the clock', () => {
    const dayAfter = new Date('2026-08-31T00:00:00.000Z');
    expect(maturityAction('PARTIALLY_PAID', DUE, dayAfter)).toBe('OVERDUE_UNCONFIRMED');
  });

  it('does not re-move a transaction already awaiting confirmation', () => {
    const late = new Date('2026-09-30T00:00:00.000Z');
    expect(maturityAction('OVERDUE_UNCONFIRMED', DUE, late)).toBeNull();
  });

  it('never acts on a state it does not own', () => {
    const late = new Date('2026-09-30T00:00:00.000Z');
    for (const state of ['CONTRACTED', 'PAID', 'OVERDUE', 'CLOSED', 'RECOURSE_ACTIVE'] as const) {
      expect(maturityAction(state, DUE, late)).toBeNull();
    }
  });
});

describe('ZM-REC-013 — an open dispute pauses automation', () => {
  it('pauses on DISPUTED and FRAUD_REVIEW', () => {
    expect(automationPaused('DISPUTED')).toBe(true);
    expect(automationPaused('FRAUD_REVIEW')).toBe(true);
    expect(automationPaused('FUNDED')).toBe(false);
  });

  it('makes a disputed transaction unsweepable however late it is', () => {
    const veryLate = new Date('2027-08-30T00:00:00.000Z');
    expect(isSweepable('DISPUTED')).toBe(false);
    expect(maturityAction('DISPUTED', DUE, veryLate)).toBeNull();
    expect(maturityAction('FRAUD_REVIEW', DUE, veryLate)).toBeNull();
  });
});

describe('day arithmetic', () => {
  it('counts whole days, in UTC, from the due date', () => {
    expect(daysPastDue(DUE, new Date('2026-08-30T00:00:00.000Z'))).toBe(0);
    expect(daysPastDue(DUE, new Date('2026-08-31T00:00:00.000Z'))).toBe(1);
    expect(daysPastDue(DUE, new Date('2026-08-29T00:00:00.000Z'))).toBe(-1);
    expect(daysUntilDue(DUE, new Date('2026-08-23T00:00:00.000Z'))).toBe(7);
  });

  it('ignores the time of day, so the count does not flicker within a day', () => {
    expect(daysPastDue(DUE, new Date('2026-08-31T00:00:01.000Z'))).toBe(1);
    expect(daysPastDue(DUE, new Date('2026-08-31T23:59:59.000Z'))).toBe(1);
  });

  it('crosses a month boundary correctly', () => {
    expect(daysPastDue(DUE, new Date('2026-09-06T00:00:00.000Z'))).toBe(7);
  });

  it('reports overdueDays as zero before due, never negative', () => {
    expect(overdueDays(DUE, new Date('2026-08-01T00:00:00.000Z'))).toBe(0);
    expect(overdueDays(DUE, new Date('2026-09-06T00:00:00.000Z'))).toBe(7);
  });
});

describe('pre-maturity reminders', () => {
  const thresholds = [30, 14, 7];

  it('sends nothing while the invoice is far from due', () => {
    expect(reminderDue(DUE, new Date('2026-07-01T00:00:00.000Z'), thresholds)).toBeNull();
  });

  it('sends the 30-day reminder at exactly 30 days out', () => {
    expect(reminderDue(DUE, new Date('2026-07-31T00:00:00.000Z'), thresholds)).toBe(30);
  });

  it('fires each threshold exactly once as the due date approaches', () => {
    expect(reminderDue(DUE, new Date('2026-07-31T00:00:00.000Z'), thresholds)).toBe(30);
    expect(reminderDue(DUE, new Date('2026-08-16T00:00:00.000Z'), thresholds)).toBe(14);
    expect(reminderDue(DUE, new Date('2026-08-23T00:00:00.000Z'), thresholds)).toBe(7);
  });

  it('never backfills the thresholds it missed', () => {
    // This replaces a test that asserted the opposite, and the old one was
    // wrong. It returned [30, 14, 7] here and called it "catching up" — but an
    // invoice funded five days before maturity has reached all three at once,
    // so the supplier got three notifications in the same minute claiming the
    // invoice was due in 30, 14 and 7 days when it was due in five. A reminder
    // is a claim about a date; a backfilled one is simply false. Only the
    // nearest reached threshold fires.
    expect(reminderDue(DUE, new Date('2026-08-20T00:00:00.000Z'), thresholds)).toBe(14);
    expect(reminderDue(DUE, new Date('2026-08-25T00:00:00.000Z'), thresholds)).toBe(7);
  });

  it('sends nothing at all past the due date — the sweep takes over there', () => {
    // Not the nearest reached threshold, *nothing*: relying on "the caller
    // already sent 7" breaks the moment a due date is jumped over (demo time
    // machine) or slept through (downed scheduler) — the next sweep would
    // then deliver "due in 7 days" on an invoice already past due, in the
    // same pass that marks it OVERDUE_UNCONFIRMED. Past due, reminders stop
    // and `maturityAction` owns the transaction.
    expect(reminderDue(DUE, new Date('2026-09-15T00:00:00.000Z'), thresholds)).toBeNull();
    // The due-date reminder itself still fires on the due date...
    expect(reminderDue(DUE, new Date('2026-08-30T00:00:00.000Z'), [...thresholds, 0])).toBe(0);
    // ...but never after it.
    expect(reminderDue(DUE, new Date('2026-08-31T00:00:00.000Z'), [...thresholds, 0])).toBeNull();
  });

  it('ignores nonsense thresholds rather than throwing on bad settings', () => {
    expect(reminderDue(DUE, new Date('2026-08-29T00:00:00.000Z'), [7, -3, NaN])).toBe(7);
  });
});

describe('D-13 / PA-06 — the outstanding balance is derived, never stored', () => {
  const frozen = Money.from('11600.000');

  it('is the frozen outstanding when nothing has been paid', () => {
    expect(derivedOutstanding(frozen, []).toString()).toBe('11600.000');
  });

  it('subtracts every reported payment', () => {
    const payments = [{ amount: Money.from('5000.000') }, { amount: Money.from('1600.000') }];
    expect(derivedOutstanding(frozen, payments).toString()).toBe('5000.000');
    expect(totalPaid(payments).toString()).toBe('6600.000');
  });

  it('is exact at three decimal places — no float drift across many payments', () => {
    // 3 × 0.001 must be 0.003, not 0.0030000000000000005.
    const payments = Array.from({ length: 3 }, () => ({ amount: Money.from('0.001') }));
    expect(derivedOutstanding(Money.from('0.003'), payments).toString()).toBe('0.000');
  });

  it('clamps an overpayment at zero rather than reporting a negative balance', () => {
    // A buyer paying a rounded figure is ordinary. A negative outstanding on
    // a screen is not; reconciling the excess is a separate conversation.
    const payments = [{ amount: Money.from('12000.000') }];
    expect(derivedOutstanding(frozen, payments).toString()).toBe('0.000');
  });

  it('calls it PAID only when the balance is exactly zero', () => {
    expect(stateAfterPayment(frozen, [{ amount: Money.from('11599.999') }])).toBe('PARTIALLY_PAID');
    expect(stateAfterPayment(frozen, [{ amount: Money.from('11600.000') }])).toBe('PAID');
    // One fils short is not paid. This is the assertion that would fail first
    // if anyone reintroduced float arithmetic here.
    expect(stateAfterPayment(frozen, [{ amount: Money.from('11599.999') }])).not.toBe('PAID');
  });

  it('treats an overpayment as PAID', () => {
    expect(stateAfterPayment(frozen, [{ amount: Money.from('11700.000') }])).toBe('PAID');
  });
});
