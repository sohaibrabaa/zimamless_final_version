import {
  InvalidTransition,
  canTransition,
  isEditable,
  keepsFingerprintActive,
  requireTransition,
} from './transaction-state';

/** The pre-market transaction state machine (§8.6). */

describe('the submission path', () => {
  it('walks DRAFT → SUBMITTED → AUTOMATED_CHECKS → ELIGIBLE', () => {
    expect(canTransition('DRAFT', 'SUBMITTED')).toBe(true);
    expect(canTransition('SUBMITTED', 'AUTOMATED_CHECKS')).toBe(true);
    expect(canTransition('AUTOMATED_CHECKS', 'ELIGIBLE')).toBe(true);
  });

  it('allows every documented outcome of the automated pipeline', () => {
    for (const outcome of ['ELIGIBLE', 'UNDER_REVIEW', 'FRAUD_REVIEW', 'REJECTED'] as const) {
      expect(canTransition('AUTOMATED_CHECKS', outcome)).toBe(true);
    }
  });

  it('lets an information request send the transaction back for re-checking', () => {
    expect(canTransition('UNDER_REVIEW', 'INFORMATION_REQUIRED')).toBe(true);
    expect(canTransition('INFORMATION_REQUIRED', 'AUTOMATED_CHECKS')).toBe(true);
  });
});

describe('transitions the machine refuses', () => {
  it('cannot skip verification', () => {
    // The single most important refusal here: a draft must not become
    // eligible without the checks having run.
    expect(canTransition('DRAFT', 'ELIGIBLE')).toBe(false);
    expect(canTransition('SUBMITTED', 'ELIGIBLE')).toBe(false);
  });

  it('cannot resubmit a rejected transaction', () => {
    expect(canTransition('REJECTED', 'SUBMITTED')).toBe(false);
    expect(canTransition('REJECTED', 'DRAFT')).toBe(false);
  });

  it('cannot reopen a cancelled transaction', () => {
    expect(canTransition('CANCELLED', 'DRAFT')).toBe(false);
  });

  it('allows listing now that Phase 5 can perform it', () => {
    // Phase 3 asserted this was false, deliberately: declaring a transition
    // no code could perform would have been a claim about behaviour that did
    // not exist. Phase 5 added listing activation, so the assertion flips
    // rather than being deleted — the pair reads as a record of when the
    // capability arrived.
    expect(canTransition('ELIGIBLE', 'OPEN_FOR_OFFERS')).toBe(true);
  });

  it('returns a lapsed listing to ELIGIBLE rather than to a terminal state', () => {
    // A missed selection deadline must not destroy the receivable's value —
    // the supplier can relist.
    expect(canTransition('OPEN_FOR_OFFERS', 'ELIGIBLE')).toBe(true);
    expect(canTransition('OPEN_FOR_OFFERS', 'OFFER_ACCEPTED')).toBe(true);
  });

  it('is a whitelist, so an unknown pairing is refused rather than allowed', () => {
    expect(canTransition('FUNDED', 'PAID')).toBe(false);
  });

  it('requireTransition throws with both states named', () => {
    expect(() => requireTransition('DRAFT', 'ELIGIBLE')).toThrow(InvalidTransition);
    try {
      requireTransition('DRAFT', 'ELIGIBLE');
    } catch (err) {
      expect((err as InvalidTransition).from).toBe('DRAFT');
      expect((err as InvalidTransition).to).toBe('ELIGIBLE');
    }
  });
});

describe('editability', () => {
  it('allows edits only in DRAFT and INFORMATION_REQUIRED', () => {
    expect(isEditable('DRAFT')).toBe(true);
    expect(isEditable('INFORMATION_REQUIRED')).toBe(true);
  });

  it('freezes a submitted transaction', () => {
    // A decided submission is a record, not a form: editing it would change
    // what the verification ran against.
    for (const state of ['SUBMITTED', 'AUTOMATED_CHECKS', 'UNDER_REVIEW', 'ELIGIBLE'] as const) {
      expect(isEditable(state)).toBe(false);
    }
  });
});

describe('fingerprint activity mirrors migration 0002', () => {
  it('keeps the fingerprint active while the transaction is live', () => {
    for (const state of ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'ELIGIBLE', 'FUNDED'] as const) {
      expect(keepsFingerprintActive(state)).toBe(true);
    }
  });

  it('releases it for the three terminal states the trigger names', () => {
    // The database trigger sets is_active_fingerprint = state NOT IN
    // (REJECTED, CANCELLED, CLOSED). If this list and that trigger ever
    // disagree, a rejected invoice would keep blocking resubmission.
    for (const state of ['REJECTED', 'CANCELLED', 'CLOSED'] as const) {
      expect(keepsFingerprintActive(state)).toBe(false);
    }
  });
});
