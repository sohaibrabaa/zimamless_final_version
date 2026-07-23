import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { HttpStatus } from '@nestjs/common';
import { SlaEventKind } from './sla-clock.service';

/**
 * The supplier application state machine (requirements §5.5–5.8).
 *
 * Two things are deliberately fused here: the legal transitions and the SLA
 * effect of each one. The requirements table gives them together — SUBMITTED
 * *starts* the clock, INFORMATION_REQUIRED *pauses* it, a decision *stops*
 * it — and splitting them across two files is how a state change eventually
 * ships without its clock event. If a transition is legal, its clock
 * consequence is right here on the same line.
 */

export type ApplicationStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'AUTOMATED_VERIFICATION'
  | 'UNDER_REVIEW'
  | 'INFORMATION_REQUIRED'
  | 'INFORMATION_RESUBMITTED'
  | 'GOVERNMENT_SERVICE_UNAVAILABLE'
  | 'FINAL_REVIEW'
  | 'APPROVED'
  | 'APPROVED_CONDITIONAL'
  | 'REJECTED';

/** Statuses after which no further transition is possible. */
export const TERMINAL_STATUSES: ReadonlySet<ApplicationStatus> = new Set([
  'APPROVED',
  'APPROVED_CONDITIONAL',
  'REJECTED',
]);

export interface TransitionRule {
  to: ApplicationStatus;
  /** The clock event this transition implies, if any. */
  clock: SlaEventKind | null;
  /** Recorded as the event reason and in the audit trail. */
  reason: string;
}

/**
 * Legal transitions, keyed by source status.
 *
 * Anything not listed is illegal — the machine is a whitelist, so a new
 * status added to the enum is unreachable until someone writes down how it
 * is entered and what that does to the clock.
 */
const TRANSITIONS: Readonly<Record<ApplicationStatus, readonly TransitionRule[]>> = {
  DRAFT: [{ to: 'SUBMITTED', clock: 'START', reason: 'APPLICATION_SUBMITTED' }],

  SUBMITTED: [
    { to: 'AUTOMATED_VERIFICATION', clock: null, reason: 'AUTOMATED_VERIFICATION_STARTED' },
  ],

  AUTOMATED_VERIFICATION: [
    { to: 'UNDER_REVIEW', clock: null, reason: 'AUTOMATED_VERIFICATION_PASSED' },
    // ZM-SON-010: an unavailable source pauses; it never rejects.
    {
      to: 'GOVERNMENT_SERVICE_UNAVAILABLE',
      clock: 'PAUSE',
      reason: 'GOVERNMENT_SERVICE_UNAVAILABLE',
    },
    // ZM-SON-012/013 hard rejections are decided on registry facts, not by
    // a reviewer, so they may terminate straight from automated checks.
    { to: 'REJECTED', clock: 'STOP', reason: 'HARD_REJECTION' },
  ],

  GOVERNMENT_SERVICE_UNAVAILABLE: [
    { to: 'AUTOMATED_VERIFICATION', clock: 'RESUME', reason: 'GOVERNMENT_SERVICE_RESTORED' },
    { to: 'UNDER_REVIEW', clock: 'RESUME', reason: 'GOVERNMENT_SERVICE_RESTORED' },
  ],

  UNDER_REVIEW: [
    { to: 'INFORMATION_REQUIRED', clock: 'PAUSE', reason: 'INFORMATION_REQUESTED' },
    { to: 'FINAL_REVIEW', clock: null, reason: 'MOVED_TO_FINAL_REVIEW' },
    { to: 'APPROVED', clock: 'STOP', reason: 'DECISION_APPROVED' },
    { to: 'APPROVED_CONDITIONAL', clock: 'STOP', reason: 'DECISION_APPROVED_CONDITIONAL' },
    { to: 'REJECTED', clock: 'STOP', reason: 'DECISION_REJECTED' },
    {
      to: 'GOVERNMENT_SERVICE_UNAVAILABLE',
      clock: 'PAUSE',
      reason: 'GOVERNMENT_SERVICE_UNAVAILABLE',
    },
  ],

  INFORMATION_REQUIRED: [
    // The supplier answering is what resumes the clock — the platform is no
    // longer the one being waited on.
    { to: 'INFORMATION_RESUBMITTED', clock: 'RESUME', reason: 'INFORMATION_PROVIDED' },
    // A reviewer may still reject outright while waiting (e.g. a sanctions
    // hit arrives). The clock is already paused, so there is nothing to stop
    // — a STOP here would be a second clock event for one decision.
    { to: 'REJECTED', clock: 'STOP', reason: 'DECISION_REJECTED' },
  ],

  INFORMATION_RESUBMITTED: [
    { to: 'UNDER_REVIEW', clock: null, reason: 'REVIEW_RESUMED' },
    { to: 'FINAL_REVIEW', clock: null, reason: 'MOVED_TO_FINAL_REVIEW' },
    { to: 'INFORMATION_REQUIRED', clock: 'PAUSE', reason: 'INFORMATION_REQUESTED' },
    { to: 'APPROVED', clock: 'STOP', reason: 'DECISION_APPROVED' },
    { to: 'APPROVED_CONDITIONAL', clock: 'STOP', reason: 'DECISION_APPROVED_CONDITIONAL' },
    { to: 'REJECTED', clock: 'STOP', reason: 'DECISION_REJECTED' },
  ],

  // RESERVED — currently unreachable by design, not by accident. The exits
  // are defined but nothing transitions INTO this state: DecideDto does not
  // accept it and no automated rule produces it. It exists for a later
  // phase's two-step review (analyst → final approver). If you are adding
  // that phase, add the entry transition and a DecideDto value; if you are
  // reading this wondering why FINAL_REVIEW never appears in data — this is
  // why.
  FINAL_REVIEW: [
    { to: 'APPROVED', clock: 'STOP', reason: 'DECISION_APPROVED' },
    { to: 'APPROVED_CONDITIONAL', clock: 'STOP', reason: 'DECISION_APPROVED_CONDITIONAL' },
    { to: 'REJECTED', clock: 'STOP', reason: 'DECISION_REJECTED' },
    { to: 'INFORMATION_REQUIRED', clock: 'PAUSE', reason: 'INFORMATION_REQUESTED' },
  ],

  APPROVED: [],
  APPROVED_CONDITIONAL: [],
  REJECTED: [],
};

export function allowedTransitionsFrom(status: ApplicationStatus): readonly TransitionRule[] {
  return TRANSITIONS[status] ?? [];
}

export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return allowedTransitionsFrom(from).some((rule) => rule.to === to);
}

/**
 * Resolve a transition or refuse it.
 *
 * Refusal is a 409 with `INVALID_STATE_TRANSITION` rather than a 422: the
 * request was well-formed, and it is the resource's current state that makes
 * it impossible. The distinction matters to Agent B, who branches on the
 * code — a supplier double-submitting should be told "already submitted",
 * not "your input is invalid".
 */
export function requireTransition(
  from: ApplicationStatus,
  to: ApplicationStatus,
): TransitionRule {
  const rule = allowedTransitionsFrom(from).find((r) => r.to === to);
  if (!rule) {
    throw new AppException(
      ErrorCode.INVALID_STATE_TRANSITION,
      `An application in ${from} cannot move to ${to}.`,
      HttpStatus.CONFLICT,
      { from, to, allowed: allowedTransitionsFrom(from).map((r) => r.to) },
    );
  }
  return rule;
}

/**
 * The organization status implied by a decided application.
 *
 * ZM-SON-011: APPROVED_CONDITIONAL is a real, distinct organization status,
 * not an approval with a flag. The supplier can log in and finish
 * outstanding items; financing actions are blocked. Modelling it as
 * ACTIVE-plus-a-note is how that block gets forgotten in Phase 4.
 */
export function organizationStatusFor(status: ApplicationStatus): string | null {
  switch (status) {
    case 'APPROVED':
      return 'ACTIVE';
    case 'APPROVED_CONDITIONAL':
      return 'APPROVED_CONDITIONAL';
    case 'REJECTED':
      return 'REJECTED';
    default:
      return null;
  }
}

/**
 * Hard-rejection assessment from registry facts (ZM-SON-012/013).
 *
 * Returns a structured reason code, or null when nothing disqualifies the
 * applicant. Note what is absent: there is no branch for an unavailable
 * source. ZM-SON-010 is explicit that downtime must not cause rejection,
 * and the only way to guarantee that is for this function never to see
 * availability at all — it is given the facts a source actually reported.
 */
export interface RegistryFacts {
  companyType?: string;
  registryStatus?: string;
  licenceStatus?: string;
  /** True when CCD answered "no such entity" — an answer, not an outage. */
  notFoundInCcd?: boolean;
}

export interface HardRejection {
  reasonCode: string;
  /**
   * Non-pejorative, as ZM-SON-013 requires. These are read by a person
   * whose business has just been refused; they state the rule and the fact,
   * and pass no judgement.
   */
  message: string;
}

export function assessHardRejection(facts: RegistryFacts): HardRejection | null {
  if (facts.notFoundInCcd) {
    return {
      reasonCode: 'ENTITY_NOT_FOUND_IN_REGISTRY',
      message:
        'We could not find this establishment number in the Companies Control Department register. ' +
        'Please check the number and apply again.',
    };
  }

  if (facts.companyType === 'SOLE_PROPRIETORSHIP') {
    return {
      reasonCode: 'SOLE_PROPRIETORSHIP_NOT_ELIGIBLE',
      message:
        'Zimmamless currently works with registered companies only. Sole proprietorships are not ' +
        'eligible in this version of the platform. This is a limitation of our current scope and ' +
        'not a judgement about your business.',
    };
  }

  if (facts.registryStatus && facts.registryStatus !== 'ACTIVE') {
    const reasons: Record<string, string> = {
      SUSPENDED: 'the company is recorded as suspended',
      STRUCK_OFF: 'the company is recorded as struck off',
      UNDER_LIQUIDATION: 'the company is recorded as being under liquidation',
    };
    const detail = reasons[facts.registryStatus] ?? 'the company is not recorded as active';
    return {
      reasonCode: `REGISTRY_STATUS_${facts.registryStatus}`,
      message:
        `According to the Companies Control Department register, ${detail}. ` +
        'An active registration is required to use the platform. If the register is out of date, ' +
        'please update it and apply again.',
    };
  }

  if (facts.licenceStatus === 'SUSPENDED' || facts.licenceStatus === 'CANCELLED') {
    return {
      reasonCode: `LICENCE_${facts.licenceStatus}`,
      message:
        'The profession licence on record is not currently valid. A valid licence is required to ' +
        'use the platform. Please renew it and apply again.',
    };
  }

  return null;
}
