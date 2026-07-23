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
    // Was FUNDED → PAID until Phase 8 made that a real edge. Replaced with a
    // pairing that is genuinely nonsense rather than weakening the assertion.
    expect(canTransition('FUNDED', 'DRAFT')).toBe(false);
    expect(canTransition('PAID', 'FUNDED')).toBe(false);
  });

  it('moves between OFFER_ACCEPTED and CONDITIONS_PENDING in both directions', () => {
    // The state is derived from whether a mandatory condition is unresolved,
    // so it has to be able to move back when the last one is fulfilled — and
    // forward again if a bank records something late.
    expect(canTransition('OFFER_ACCEPTED', 'CONDITIONS_PENDING')).toBe(true);
    expect(canTransition('CONDITIONS_PENDING', 'OFFER_ACCEPTED')).toBe(true);
  });

  it('reaches CONTRACTED from either accepted state', () => {
    // Directly when the accepted offer carried no mandatory conditions at all.
    expect(canTransition('OFFER_ACCEPTED', 'CONTRACTED')).toBe(true);
    expect(canTransition('CONDITIONS_PENDING', 'CONTRACTED')).toBe(true);
  });

  it('cannot go back to the marketplace once an offer is accepted', () => {
    // Acceptance is irreversible (INV-1/INV-4). Unwinding it is a withdrawal
    // case in Phase 8, not a state change.
    expect(canTransition('OFFER_ACCEPTED', 'OPEN_FOR_OFFERS')).toBe(false);
    expect(canTransition('OFFER_ACCEPTED', 'ELIGIBLE')).toBe(false);
    expect(canTransition('CONTRACTED', 'OFFER_ACCEPTED')).toBe(false);
  });

  it('still does not declare READY_FOR_DISBURSEMENT, which nothing sets', () => {
    // The enum carries it and it is a plausible staging state, but no code in
    // any phase performs it. A declared transition nothing can take is a lie
    // about the system's shape.
    expect(canTransition('CONTRACTED', 'READY_FOR_DISBURSEMENT')).toBe(false);
  });

  // ------------------------------------------------------------------
  // Phase 8 — ZM-PMT-008..011
  // ------------------------------------------------------------------

  describe('the overdue discipline', () => {
    it('CANNOT move a funded transaction straight to OVERDUE', () => {
      // The single most important edge in this phase, asserted as an absence.
      // A due date passing is not evidence that a buyer failed to pay; only a
      // bank can say that. If this ever returns true, the platform has begun
      // accusing suppliers of default on the strength of a calendar.
      expect(canTransition('FUNDED', 'OVERDUE')).toBe(false);
      expect(canTransition('PARTIALLY_PAID', 'OVERDUE_UNCONFIRMED')).toBe(true);
    });

    it('routes a passed due date to OVERDUE_UNCONFIRMED', () => {
      expect(canTransition('FUNDED', 'OVERDUE_UNCONFIRMED')).toBe(true);
    });

    it('lets only a confirmation leave OVERDUE_UNCONFIRMED, in any of three directions', () => {
      // The bank may report that the buyer paid after all, paid partly, or
      // genuinely defaulted. All three are confirmations; none is assumed.
      expect(canTransition('OVERDUE_UNCONFIRMED', 'PAID')).toBe(true);
      expect(canTransition('OVERDUE_UNCONFIRMED', 'PARTIALLY_PAID')).toBe(true);
      expect(canTransition('OVERDUE_UNCONFIRMED', 'OVERDUE')).toBe(true);
    });

    it('allows late payment of a confirmed overdue', () => {
      // Buyers settle after the due date all the time; making that
      // unrepresentable would force a false closure.
      expect(canTransition('OVERDUE', 'PAID')).toBe(true);
      expect(canTransition('OVERDUE', 'PARTIALLY_PAID')).toBe(true);
    });

    it('reaches recourse only from a CONFIRMED overdue', () => {
      // Recourse is a claim against the supplier. Starting one from an
      // unconfirmed overdue would act on the assumption the state exists to
      // avoid making.
      expect(canTransition('OVERDUE', 'RECOURSE_ACTIVE')).toBe(true);
      expect(canTransition('OVERDUE_UNCONFIRMED', 'RECOURSE_ACTIVE')).toBe(false);
      expect(canTransition('FUNDED', 'RECOURSE_ACTIVE')).toBe(false);
    });
  });

  describe('disputes and closure', () => {
    it('can be disputed from every post-funding state', () => {
      for (const state of [
        'FUNDED',
        'PARTIALLY_PAID',
        'PAID',
        'OVERDUE_UNCONFIRMED',
        'OVERDUE',
        'RECOURSE_ACTIVE',
      ] as const) {
        expect(canTransition(state, 'DISPUTED')).toBe(true);
      }
    });

    it('returns a resolved dispute to a state the resolver names', () => {
      expect(canTransition('DISPUTED', 'OVERDUE')).toBe(true);
      expect(canTransition('DISPUTED', 'FUNDED')).toBe(true);
      expect(canTransition('DISPUTED', 'CLOSED')).toBe(true);
    });

    it('makes CLOSED terminal — nothing leaves it, and nothing is deleted (INV-7)', () => {
      for (const state of ['FUNDED', 'PAID', 'OVERDUE', 'DISPUTED', 'DRAFT'] as const) {
        expect(canTransition('CLOSED', state)).toBe(false);
      }
    });

    it('closes a fraud-reviewed transaction rather than removing it', () => {
      expect(canTransition('FRAUD_REVIEW', 'CLOSED')).toBe(true);
      // And a cleared review returns a funded transaction to FUNDED.
      expect(canTransition('FRAUD_REVIEW', 'FUNDED')).toBe(true);
    });
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
