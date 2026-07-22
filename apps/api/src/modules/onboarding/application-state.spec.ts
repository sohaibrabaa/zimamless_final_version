import {
  ApplicationStatus,
  TERMINAL_STATUSES,
  allowedTransitionsFrom,
  assessHardRejection,
  canTransition,
  organizationStatusFor,
  requireTransition,
} from './application-state';

/**
 * The application state machine and the hard-rejection rules
 * (requirements §5.5–5.8).
 */

describe('application state machine', () => {
  it('starts the clock on submission and nowhere else', () => {
    const starts: ApplicationStatus[] = [];
    const all: ApplicationStatus[] = [
      'DRAFT',
      'SUBMITTED',
      'AUTOMATED_VERIFICATION',
      'UNDER_REVIEW',
      'INFORMATION_REQUIRED',
      'INFORMATION_RESUBMITTED',
      'GOVERNMENT_SERVICE_UNAVAILABLE',
      'FINAL_REVIEW',
      'APPROVED',
      'APPROVED_CONDITIONAL',
      'REJECTED',
    ];
    for (const from of all) {
      for (const rule of allowedTransitionsFrom(from)) {
        if (rule.clock === 'START') starts.push(rule.to);
      }
    }
    expect(starts).toEqual(['SUBMITTED']);
  });

  it('pauses the clock on INFORMATION_REQUIRED and GOVERNMENT_SERVICE_UNAVAILABLE only', () => {
    const pausing = new Set<string>();
    for (const from of Object.keys(
      { DRAFT: 1, SUBMITTED: 1, AUTOMATED_VERIFICATION: 1, UNDER_REVIEW: 1, INFORMATION_REQUIRED: 1, INFORMATION_RESUBMITTED: 1, GOVERNMENT_SERVICE_UNAVAILABLE: 1, FINAL_REVIEW: 1 },
    ) as ApplicationStatus[]) {
      for (const rule of allowedTransitionsFrom(from)) {
        if (rule.clock === 'PAUSE') pausing.add(rule.to);
      }
    }
    expect([...pausing].sort()).toEqual(['GOVERNMENT_SERVICE_UNAVAILABLE', 'INFORMATION_REQUIRED']);
  });

  it('stops the clock on every decided status', () => {
    for (const decided of ['APPROVED', 'APPROVED_CONDITIONAL', 'REJECTED'] as ApplicationStatus[]) {
      const rule = allowedTransitionsFrom('UNDER_REVIEW').find((r) => r.to === decided);
      expect(rule?.clock).toBe('STOP');
    }
  });

  it('resumes the clock when the supplier responds', () => {
    const rule = allowedTransitionsFrom('INFORMATION_REQUIRED').find(
      (r) => r.to === 'INFORMATION_RESUBMITTED',
    );
    expect(rule?.clock).toBe('RESUME');
  });

  it('resumes the clock when a government service comes back', () => {
    for (const rule of allowedTransitionsFrom('GOVERNMENT_SERVICE_UNAVAILABLE')) {
      expect(rule.clock).toBe('RESUME');
    }
  });

  it('permits no transition out of a decided application', () => {
    for (const terminal of TERMINAL_STATUSES) {
      expect(allowedTransitionsFrom(terminal)).toHaveLength(0);
    }
  });

  it('refuses a double submission with INVALID_STATE_TRANSITION, not a validation error', () => {
    expect(canTransition('DRAFT', 'SUBMITTED')).toBe(true);
    expect(canTransition('SUBMITTED', 'SUBMITTED')).toBe(false);
    try {
      requireTransition('SUBMITTED', 'SUBMITTED');
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as { code: string; getStatus(): number };
      expect(e.code).toBe('INVALID_STATE_TRANSITION');
      // 409, not 422: the request is fine; the resource's state is not.
      expect(e.getStatus()).toBe(409);
    }
  });

  it('cannot approve straight out of DRAFT', () => {
    expect(canTransition('DRAFT', 'APPROVED')).toBe(false);
    expect(() => requireTransition('DRAFT', 'APPROVED')).toThrow();
  });

  it('never rejects directly because a source was unavailable', () => {
    // GOVERNMENT_SERVICE_UNAVAILABLE has exactly two exits, both resumes.
    // ZM-SON-010: downtime must not cause rejection.
    const exits = allowedTransitionsFrom('GOVERNMENT_SERVICE_UNAVAILABLE').map((r) => r.to);
    expect(exits).not.toContain('REJECTED');
  });

  describe('organization status mapping (ZM-SON-011)', () => {
    it('maps each decided status to its organization status', () => {
      expect(organizationStatusFor('APPROVED')).toBe('ACTIVE');
      expect(organizationStatusFor('REJECTED')).toBe('REJECTED');
    });

    it('keeps APPROVED_CONDITIONAL distinct from ACTIVE', () => {
      // Modelling it as ACTIVE-with-a-flag is how the financing block gets
      // forgotten in a later phase.
      expect(organizationStatusFor('APPROVED_CONDITIONAL')).toBe('APPROVED_CONDITIONAL');
      expect(organizationStatusFor('APPROVED_CONDITIONAL')).not.toBe('ACTIVE');
    });

    it('leaves the organization alone for undecided statuses', () => {
      expect(organizationStatusFor('UNDER_REVIEW')).toBeNull();
      expect(organizationStatusFor('GOVERNMENT_SERVICE_UNAVAILABLE')).toBeNull();
    });
  });
});

describe('hard-rejection rules (ZM-SON-012/013)', () => {
  it('passes an active limited-liability company', () => {
    expect(
      assessHardRejection({
        companyType: 'LIMITED_LIABILITY',
        registryStatus: 'ACTIVE',
        licenceStatus: 'VALID',
      }),
    ).toBeNull();
  });

  it('rejects a sole proprietorship with a non-pejorative message', () => {
    const result = assessHardRejection({ companyType: 'SOLE_PROPRIETORSHIP', registryStatus: 'ACTIVE' });
    expect(result?.reasonCode).toBe('SOLE_PROPRIETORSHIP_NOT_ELIGIBLE');
    // ZM-SON-013 requires the message be clear and non-pejorative: it must
    // name the platform's limitation, not a deficiency in the applicant.
    expect(result?.message).toMatch(/not a judgement about your business/i);
    expect(result?.message).not.toMatch(/invalid|illegitimate|unqualified|too small/i);
  });

  it('rejects each blocked registry status with its own reason code', () => {
    for (const status of ['SUSPENDED', 'STRUCK_OFF', 'UNDER_LIQUIDATION']) {
      const result = assessHardRejection({ companyType: 'LIMITED_LIABILITY', registryStatus: status });
      expect(result?.reasonCode).toBe(`REGISTRY_STATUS_${status}`);
    }
  });

  it('rejects a suspended or cancelled profession licence', () => {
    expect(
      assessHardRejection({
        companyType: 'LIMITED_LIABILITY',
        registryStatus: 'ACTIVE',
        licenceStatus: 'SUSPENDED',
      })?.reasonCode,
    ).toBe('LICENCE_SUSPENDED');
  });

  it('rejects an entity the registry answered "not found" for', () => {
    expect(assessHardRejection({ notFoundInCcd: true })?.reasonCode).toBe(
      'ENTITY_NOT_FOUND_IN_REGISTRY',
    );
  });

  it('has no branch that can reject for an unavailable source — ZM-SON-010', () => {
    // The facts an unavailable source produces are simply absent. Absent
    // facts must not reject: nothing is known, so nothing is disqualifying.
    expect(assessHardRejection({})).toBeNull();
    expect(assessHardRejection({ companyType: undefined, registryStatus: undefined })).toBeNull();
  });
});
