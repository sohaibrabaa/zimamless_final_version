import { Money } from '../../common/money/money';

/**
 * Withdrawal penalty policy (ZM-WDR-*, AS-07, LT-12).
 *
 * The whole point of this file is the function named `penaltyDeduction`: a
 * penalty is **calculated and recorded, never deducted**. Everything else here
 * exists to make that number defensible; nothing anywhere acts on it.
 *
 * ## Why it is not deducted
 *
 * A post-acceptance withdrawal is a bank breaking a commitment a supplier
 * relied on, often after arranging its affairs around expected funds. A
 * penalty is the platform's estimate of what that is worth. But the platform
 * holds no bank money to deduct from, it has not adjudicated whether the
 * withdrawal was justified, and two reasons on the list
 * (`SUPPLIER_MISREPRESENTATION`, `FRAUD_DISCOVERED`) describe a bank that was
 * *right* to withdraw. Automatically debiting a bank for pulling out of a deal
 * it discovered was fraudulent would be exactly backwards.
 *
 * ## The policy comes from settings, not from here
 *
 * `withdrawal_penalty_policy` (migration 0002) carries a per-reason object:
 *
 *   `{"BANK_COMMERCIAL_DECISION":{"applicable":true,"flatAmount":"500.000"},
 *     "FRAUD_DISCOVERED":{"applicable":false},
 *     "INVOICE_CHANGED":{"applicable":null}, …}`
 *
 * `applicable: null` is the interesting value and it is deliberate: it means
 * *the platform has no default opinion, send it to a human*. A policy engine
 * that always produced an answer would be inventing certainty about
 * `INVOICE_CHANGED` — which could be an honest correction or a bad-faith
 * rewrite — that nobody has.
 */

export type WithdrawalReason =
  | 'BANK_COMMERCIAL_DECISION'
  | 'SUPPLIER_MISREPRESENTATION'
  | 'FRAUD_DISCOVERED'
  | 'INVOICE_CHANGED'
  | 'CONDITION_NOT_MET'
  | 'TECHNICAL_FAILURE'
  | 'OTHER';

export type WithdrawalStatus =
  | 'WITHDRAWAL_REQUESTED'
  | 'UNDER_REVIEW'
  | 'PENALTY_ASSESSED'
  | 'NO_PENALTY'
  | 'RELISTING_APPROVED'
  | 'RELISTING_DENIED'
  | 'CLOSED';

/** One reason's entry in `withdrawal_penalty_policy`. */
export interface PenaltyRule {
  /** `null` means: no default, a human decides. */
  applicable: boolean | null;
  flatAmount?: string;
}

export interface PenaltyAssessment {
  /** `null` → the case goes to an administrator with no suggested answer. */
  applicable: boolean | null;
  amount: Money | null;
  /** Whether the platform reached this by policy or is declining to guess. */
  requiresManualReview: boolean;
}

/**
 * What the policy says about one withdrawal, before any human looks at it.
 *
 * Never throws on a malformed or missing policy: an operator editing settings
 * badly must not make withdrawal cases un-openable. An unreadable rule
 * degrades to manual review, which is the safe direction — a human sees it.
 */
export function assessPenalty(
  reason: WithdrawalReason,
  policy: Record<string, PenaltyRule> | null | undefined,
): PenaltyAssessment {
  const rule = policy?.[reason];

  if (!rule || rule.applicable === null || rule.applicable === undefined) {
    return { applicable: null, amount: null, requiresManualReview: true };
  }

  if (rule.applicable === false) {
    return { applicable: false, amount: Money.zero(), requiresManualReview: false };
  }

  // Applicable, but with no amount configured: the platform knows a penalty is
  // due and not how much. That is still a question for a human.
  if (!rule.flatAmount || !Money.isValidMoneyString(rule.flatAmount)) {
    return { applicable: true, amount: null, requiresManualReview: true };
  }

  return {
    applicable: true,
    amount: Money.from(rule.flatAmount),
    requiresManualReview: false,
  };
}

/**
 * The rule this file exists to state.
 *
 * A recorded penalty produces no ledger entry, no settlement, and no change to
 * any balance. It is a number on a case for a human to act on — which may mean
 * an invoice raised outside the platform, a commercial conversation, or
 * nothing at all.
 *
 * Written as a named function with a test so the rule is *asserted* rather
 * than merely unimplemented. "We never got round to deducting it" and
 * "deducting it would be wrong" look identical in a codebase until someone
 * writes this down.
 */
export function penaltyDeduction(): null {
  return null;
}

/** Allowed status progressions for a withdrawal case. */
const TRANSITIONS: ReadonlyMap<WithdrawalStatus, ReadonlySet<WithdrawalStatus>> = new Map([
  [
    'WITHDRAWAL_REQUESTED',
    new Set<WithdrawalStatus>(['UNDER_REVIEW', 'PENALTY_ASSESSED', 'NO_PENALTY']),
  ],
  ['UNDER_REVIEW', new Set<WithdrawalStatus>(['PENALTY_ASSESSED', 'NO_PENALTY'])],
  [
    'PENALTY_ASSESSED',
    new Set<WithdrawalStatus>(['RELISTING_APPROVED', 'RELISTING_DENIED', 'CLOSED']),
  ],
  ['NO_PENALTY', new Set<WithdrawalStatus>(['RELISTING_APPROVED', 'RELISTING_DENIED', 'CLOSED'])],
  ['RELISTING_APPROVED', new Set<WithdrawalStatus>(['CLOSED'])],
  ['RELISTING_DENIED', new Set<WithdrawalStatus>(['CLOSED'])],
  ['CLOSED', new Set<WithdrawalStatus>([])],
]);

export function canProgressWithdrawal(from: WithdrawalStatus, to: WithdrawalStatus): boolean {
  return TRANSITIONS.get(from)?.has(to) ?? false;
}

/**
 * The status an admin decision produces.
 *
 * Derived from what the admin decided rather than supplied separately, so the
 * status and the decision on one row cannot contradict each other.
 */
export function statusAfterDecision(penaltyApplicable: boolean): WithdrawalStatus {
  return penaltyApplicable ? 'PENALTY_ASSESSED' : 'NO_PENALTY';
}
