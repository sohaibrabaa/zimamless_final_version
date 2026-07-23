import { Money } from '../../common/money/money';

/**
 * The recourse case state machine and its money (ZM-REC-*).
 *
 * Recourse is the bank coming back to the supplier because the receivable did
 * not perform. It is the most adversarial thing the platform mediates, so the
 * rules about who may start one and what it costs are worth stating as code
 * rather than as prose in a service method.
 */

export type RecourseStatus =
  | 'RECOURSE_INITIATED'
  | 'SUPPLIER_NOTIFIED'
  | 'PAYMENT_PENDING'
  | 'SETTLED'
  | 'DISPUTED'
  | 'LEGAL_ESCALATION';

export type RecourseReason =
  | 'INVALID_INVOICE'
  | 'HIDDEN_DISPUTE_OR_RETURN'
  | 'DOUBLE_FINANCING'
  | 'NON_DELIVERY'
  | 'NON_PAYMENT'
  | 'OTHER';

/**
 * Allowed progressions.
 *
 * `DISPUTED` is reachable from every live status because a supplier can
 * contest a recourse claim at any point before it settles — including after
 * agreeing to pay, if what they learn changes their mind. `LEGAL_ESCALATION`
 * is likewise reachable from the middle of the process rather than only at
 * the end.
 *
 * `SETTLED` is terminal. A settled case is not reopened; a new claim is a new
 * case, so the history of what was claimed and what was paid stays legible.
 */
const TRANSITIONS: ReadonlyMap<RecourseStatus, ReadonlySet<RecourseStatus>> = new Map([
  [
    'RECOURSE_INITIATED',
    new Set<RecourseStatus>(['SUPPLIER_NOTIFIED', 'DISPUTED', 'LEGAL_ESCALATION']),
  ],
  [
    'SUPPLIER_NOTIFIED',
    new Set<RecourseStatus>(['PAYMENT_PENDING', 'SETTLED', 'DISPUTED', 'LEGAL_ESCALATION']),
  ],
  ['PAYMENT_PENDING', new Set<RecourseStatus>(['SETTLED', 'DISPUTED', 'LEGAL_ESCALATION'])],
  // A dispute resolved in the bank's favour returns the case to where it was,
  // rather than jumping it to SETTLED — the supplier still has to pay.
  [
    'DISPUTED',
    new Set<RecourseStatus>(['SUPPLIER_NOTIFIED', 'PAYMENT_PENDING', 'SETTLED', 'LEGAL_ESCALATION']),
  ],
  ['LEGAL_ESCALATION', new Set<RecourseStatus>(['SETTLED', 'DISPUTED'])],
  ['SETTLED', new Set<RecourseStatus>([])],
]);

export function canProgress(from: RecourseStatus, to: RecourseStatus): boolean {
  return TRANSITIONS.get(from)?.has(to) ?? false;
}

export class InvalidRecourseTransition extends Error {
  constructor(
    readonly from: RecourseStatus,
    readonly to: RecourseStatus,
  ) {
    super(`A recourse case cannot move from ${from} to ${to}.`);
  }
}

export function requireProgress(from: RecourseStatus, to: RecourseStatus): void {
  if (!canProgress(from, to)) throw new InvalidRecourseTransition(from, to);
}

/** Live statuses — a case still owed money. */
export function isOpen(status: RecourseStatus): boolean {
  return status !== 'SETTLED';
}

/**
 * What remains after a repayment.
 *
 * Clamped at zero for the same reason the invoice balance is: an overpayment
 * is a reconciliation conversation, not a negative debt.
 */
export function remainingAfter(requested: Money, repayments: readonly Money[]): Money {
  const repaid = repayments.reduce((sum, r) => sum.add(r), Money.zero());
  const remaining = requested.subtract(repaid);
  return remaining.isNegative() ? Money.zero() : remaining;
}

export function totalRepaid(repayments: readonly Money[]): Money {
  return repayments.reduce((sum, r) => sum.add(r), Money.zero());
}

/**
 * Whether a repayment settles the case.
 *
 * Exact: one fils short is not settled. The supplier's obligation ending is
 * not a thing to be approximately right about.
 */
export function settlesCase(requested: Money, repayments: readonly Money[]): boolean {
  return remainingAfter(requested, repayments).isZero();
}

/**
 * ZM-REC-004 — how much a bank may claim.
 *
 * Capped at the gross funding amount: the bank advanced that, and recourse
 * recovers what was advanced. It is not a route to claim the invoice's face
 * value, which would let the bank recover more than it ever paid out and turn
 * a failed receivable into a profit.
 *
 * The bank's own discount and fees are deliberately *not* recoverable here
 * either — those were its margin on a deal that did not work out, and folding
 * them into a recourse claim would charge the supplier for the bank's lost
 * profit on top of returning the principal.
 */
export function maximumClaim(grossFundingAmount: Money): Money {
  return grossFundingAmount;
}

export function claimExceedsAdvance(requested: Money, grossFundingAmount: Money): boolean {
  // "not less than or equal" rather than a `greaterThan` that Money does not
  // expose — equal to the advance is a legitimate full claim.
  return !requested.lessThan(maximumClaim(grossFundingAmount)) &&
    !requested.equals(maximumClaim(grossFundingAmount));
}

/**
 * ZM-FEE-016 — recourse does NOT automatically refund the platform commission.
 *
 * Stated as a function so the rule has a name and a test, rather than existing
 * only as the absence of code somewhere.
 *
 * The platform earned its fee for work it actually did: matching, verifying,
 * contracting and settling a transaction that funded. Whether the buyer later
 * paid the bank is not something the platform was paid to guarantee. Reversing
 * the commission automatically would be a revenue decision nobody made, taken
 * silently by a job — and it would mean the platform's income depended on
 * credit outcomes it does not underwrite.
 *
 * A refund remains possible; it is a compensating ledger entry someone
 * deliberately posts, with a reason, not a side effect of a status change.
 */
export function commissionRefundOnRecourse(): null {
  return null;
}
