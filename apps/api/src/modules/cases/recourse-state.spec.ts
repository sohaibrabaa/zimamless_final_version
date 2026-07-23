import {
  canProgress,
  claimExceedsAdvance,
  commissionRefundOnRecourse,
  InvalidRecourseTransition,
  isOpen,
  maximumClaim,
  remainingAfter,
  requireProgress,
  settlesCase,
  totalRepaid,
} from './recourse-state';
import { Money } from '../../common/money/money';

const ADVANCE = Money.from('9000.000');

describe('the recourse state machine', () => {
  it('starts at RECOURSE_INITIATED and notifies before demanding payment', () => {
    expect(canProgress('RECOURSE_INITIATED', 'SUPPLIER_NOTIFIED')).toBe(true);
    // A supplier cannot be moved to PAYMENT_PENDING without first being told
    // a claim exists against them.
    expect(canProgress('RECOURSE_INITIATED', 'PAYMENT_PENDING')).toBe(false);
    expect(canProgress('RECOURSE_INITIATED', 'SETTLED')).toBe(false);
  });

  it('lets a supplier dispute at any point before settlement', () => {
    for (const from of [
      'RECOURSE_INITIATED',
      'SUPPLIER_NOTIFIED',
      'PAYMENT_PENDING',
      'LEGAL_ESCALATION',
    ] as const) {
      expect(canProgress(from, 'DISPUTED')).toBe(true);
    }
  });

  it('returns a resolved dispute to where the case was, not to SETTLED', () => {
    // A dispute resolved in the bank's favour does not discharge the debt.
    expect(canProgress('DISPUTED', 'PAYMENT_PENDING')).toBe(true);
    expect(canProgress('DISPUTED', 'SUPPLIER_NOTIFIED')).toBe(true);
  });

  it('makes SETTLED terminal — a new claim is a new case', () => {
    for (const to of [
      'RECOURSE_INITIATED',
      'SUPPLIER_NOTIFIED',
      'PAYMENT_PENDING',
      'DISPUTED',
      'LEGAL_ESCALATION',
    ] as const) {
      expect(canProgress('SETTLED', to)).toBe(false);
    }
    expect(isOpen('SETTLED')).toBe(false);
    expect(isOpen('PAYMENT_PENDING')).toBe(true);
  });

  it('names both statuses when it refuses', () => {
    expect(() => requireProgress('SETTLED', 'DISPUTED')).toThrow(InvalidRecourseTransition);
    try {
      requireProgress('RECOURSE_INITIATED', 'SETTLED');
    } catch (err) {
      expect((err as Error).message).toContain('RECOURSE_INITIATED');
      expect((err as Error).message).toContain('SETTLED');
    }
  });
});

describe('ZM-REC-004 — a bank may claim what it advanced, and no more', () => {
  it('caps the claim at the gross funding amount', () => {
    expect(maximumClaim(ADVANCE).toString()).toBe('9000.000');
  });

  it('permits a claim for exactly the advance', () => {
    expect(claimExceedsAdvance(Money.from('9000.000'), ADVANCE)).toBe(false);
  });

  it('refuses a claim for more than was advanced', () => {
    // The face value is 11,600 and the advance was 9,000. Letting the bank
    // claim the face value would recover more than it ever paid out and turn
    // a failed receivable into a profit.
    expect(claimExceedsAdvance(Money.from('11600.000'), ADVANCE)).toBe(true);
    // One fils over is over.
    expect(claimExceedsAdvance(Money.from('9000.001'), ADVANCE)).toBe(true);
  });

  it('permits a partial claim', () => {
    expect(claimExceedsAdvance(Money.from('4000.000'), ADVANCE)).toBe(false);
  });
});

describe('repayment arithmetic', () => {
  it('reduces the remaining balance by each repayment', () => {
    const repayments = [Money.from('3000.000'), Money.from('2000.000')];
    expect(remainingAfter(ADVANCE, repayments).toString()).toBe('4000.000');
    expect(totalRepaid(repayments).toString()).toBe('5000.000');
  });

  it('settles only on the exact amount — one fils short is not settled', () => {
    expect(settlesCase(ADVANCE, [Money.from('8999.999')])).toBe(false);
    expect(settlesCase(ADVANCE, [Money.from('9000.000')])).toBe(true);
  });

  it('is exact across many small repayments', () => {
    const repayments = Array.from({ length: 1000 }, () => Money.from('9.000'));
    expect(remainingAfter(ADVANCE, repayments).toString()).toBe('0.000');
    expect(settlesCase(ADVANCE, repayments)).toBe(true);
  });

  it('clamps an overpayment at zero rather than reporting a negative debt', () => {
    expect(remainingAfter(ADVANCE, [Money.from('10000.000')]).toString()).toBe('0.000');
  });

  it('starts at the full requested amount with nothing repaid', () => {
    expect(remainingAfter(ADVANCE, []).toString()).toBe('9000.000');
  });
});

describe('ZM-FEE-016 — recourse does not automatically refund the commission', () => {
  it('proposes no refund, ever', () => {
    // Stated as a named function with a test rather than existing only as the
    // absence of code. The platform earned its fee for matching, verifying,
    // contracting and settling a transaction that funded; whether the buyer
    // later paid the bank is not something it was paid to guarantee.
    //
    // If this ever returns an amount, the platform's income has quietly been
    // made contingent on credit outcomes it does not underwrite.
    expect(commissionRefundOnRecourse()).toBeNull();
  });
});
