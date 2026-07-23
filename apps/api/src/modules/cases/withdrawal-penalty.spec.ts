import {
  assessPenalty,
  canProgressWithdrawal,
  penaltyDeduction,
  statusAfterDecision,
  type PenaltyRule,
} from './withdrawal-penalty';

/** The policy exactly as migration 0002 seeds it. */
const SEEDED: Record<string, PenaltyRule> = {
  BANK_COMMERCIAL_DECISION: { applicable: true, flatAmount: '500.000' },
  SUPPLIER_MISREPRESENTATION: { applicable: false },
  FRAUD_DISCOVERED: { applicable: false },
  INVOICE_CHANGED: { applicable: null },
  CONDITION_NOT_MET: { applicable: null },
  TECHNICAL_FAILURE: { applicable: null },
  OTHER: { applicable: null },
};

describe('AS-07 / LT-12 — a penalty is recorded, never deducted', () => {
  it('proposes no deduction, ever', () => {
    // The rule stated as an assertion rather than as the absence of code.
    // "We never got round to deducting it" and "deducting it would be wrong"
    // look identical in a codebase until this test exists.
    expect(penaltyDeduction()).toBeNull();
  });
});

describe('the seeded penalty policy', () => {
  it('charges a bank that simply changed its mind', () => {
    const assessment = assessPenalty('BANK_COMMERCIAL_DECISION', SEEDED);
    expect(assessment.applicable).toBe(true);
    expect(assessment.amount?.toString()).toBe('500.000');
    expect(assessment.requiresManualReview).toBe(false);
  });

  it('charges NOTHING to a bank that withdrew because it found fraud', () => {
    // Debiting a bank for pulling out of a deal it discovered was fraudulent
    // would be exactly backwards.
    for (const reason of ['FRAUD_DISCOVERED', 'SUPPLIER_MISREPRESENTATION'] as const) {
      const assessment = assessPenalty(reason, SEEDED);
      expect(assessment.applicable).toBe(false);
      expect(assessment.amount?.toString()).toBe('0.000');
      expect(assessment.requiresManualReview).toBe(false);
    }
  });

  it('declines to guess where the policy says null', () => {
    // INVOICE_CHANGED could be an honest correction or a bad-faith rewrite.
    // A policy engine that always produced an answer would be inventing
    // certainty nobody has.
    for (const reason of ['INVOICE_CHANGED', 'CONDITION_NOT_MET', 'TECHNICAL_FAILURE', 'OTHER'] as const) {
      const assessment = assessPenalty(reason, SEEDED);
      expect(assessment.applicable).toBeNull();
      expect(assessment.amount).toBeNull();
      expect(assessment.requiresManualReview).toBe(true);
    }
  });
});

describe('a badly configured policy degrades to manual review, never to a wrong charge', () => {
  it('sends an unknown reason to a human', () => {
    expect(assessPenalty('OTHER', {})).toMatchObject({
      applicable: null,
      requiresManualReview: true,
    });
  });

  it('survives a missing policy entirely', () => {
    expect(assessPenalty('BANK_COMMERCIAL_DECISION', null)).toMatchObject({
      requiresManualReview: true,
    });
    expect(assessPenalty('BANK_COMMERCIAL_DECISION', undefined)).toMatchObject({
      requiresManualReview: true,
    });
  });

  it('sends "applicable but no amount configured" to a human', () => {
    const assessment = assessPenalty('OTHER', { OTHER: { applicable: true } });
    expect(assessment.applicable).toBe(true);
    // It knows a penalty is due and not how much. Still a question for a human.
    expect(assessment.amount).toBeNull();
    expect(assessment.requiresManualReview).toBe(true);
  });

  it('refuses a malformed amount rather than parsing it loosely', () => {
    const assessment = assessPenalty('OTHER', { OTHER: { applicable: true, flatAmount: '500' } });
    // Money on the wire is always 3-dp. "500" is not a money string, and
    // coercing it would be the first step toward float arithmetic.
    expect(assessment.amount).toBeNull();
    expect(assessment.requiresManualReview).toBe(true);
  });
});

describe('the withdrawal case status machine', () => {
  it('goes from requested to a decision', () => {
    expect(canProgressWithdrawal('WITHDRAWAL_REQUESTED', 'PENALTY_ASSESSED')).toBe(true);
    expect(canProgressWithdrawal('WITHDRAWAL_REQUESTED', 'NO_PENALTY')).toBe(true);
    expect(canProgressWithdrawal('WITHDRAWAL_REQUESTED', 'UNDER_REVIEW')).toBe(true);
  });

  it('cannot skip straight to relisting without a penalty decision', () => {
    // Relisting eligibility is part of the same admin decision; reaching it
    // without one would mean a case relisted with the penalty question open.
    expect(canProgressWithdrawal('WITHDRAWAL_REQUESTED', 'RELISTING_APPROVED')).toBe(false);
  });

  it('makes CLOSED terminal', () => {
    for (const to of ['UNDER_REVIEW', 'PENALTY_ASSESSED', 'RELISTING_APPROVED'] as const) {
      expect(canProgressWithdrawal('CLOSED', to)).toBe(false);
    }
  });

  it('derives the status from the decision so the two cannot disagree', () => {
    expect(statusAfterDecision(true)).toBe('PENALTY_ASSESSED');
    expect(statusAfterDecision(false)).toBe('NO_PENALTY');
  });
});
