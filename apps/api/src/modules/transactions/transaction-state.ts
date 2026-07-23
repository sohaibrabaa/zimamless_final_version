/**
 * The pre-market transaction state machine (§8.6).
 *
 *   DRAFT → SUBMITTED → AUTOMATED_CHECKS → UNDER_REVIEW → INFORMATION_REQUIRED
 *                                        → ELIGIBLE | REJECTED | FRAUD_REVIEW
 *
 * Phase 3 owns the states up to `ELIGIBLE`. The `transaction_state` enum in
 * the frozen schema carries the whole lifecycle through settlement, and the
 * later transitions are added by the phases that implement them — declaring
 * them now would assert transitions no code can perform.
 *
 * As in onboarding, transitions are a whitelist rather than a list of
 * forbidden moves. A state machine that permits anything not explicitly
 * banned grows new paths by accident every time a state is added.
 */

export type TransactionState =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'AUTOMATED_CHECKS'
  | 'UNDER_REVIEW'
  | 'INFORMATION_REQUIRED'
  | 'ELIGIBLE'
  | 'OPEN_FOR_OFFERS'
  | 'OFFER_ACCEPTED'
  | 'CONDITIONS_PENDING'
  | 'CONTRACTED'
  | 'READY_FOR_DISBURSEMENT'
  | 'FUNDING_CONFIRMATION_PENDING'
  | 'FUNDED'
  | 'PARTIALLY_PAID'
  | 'PAID'
  | 'OVERDUE_UNCONFIRMED'
  | 'OVERDUE'
  | 'RECOURSE_ACTIVE'
  | 'DISPUTED'
  | 'FRAUD_REVIEW'
  | 'CLOSED'
  | 'REJECTED'
  | 'CANCELLED';

/** Allowed transitions for the states Phase 3 implements. */
const TRANSITIONS: ReadonlyMap<TransactionState, ReadonlySet<TransactionState>> = new Map([
  ['DRAFT', new Set<TransactionState>(['SUBMITTED', 'CANCELLED'])],
  ['SUBMITTED', new Set<TransactionState>(['AUTOMATED_CHECKS'])],
  [
    'AUTOMATED_CHECKS',
    // Every outcome of the automated pipeline. FRAUD_REVIEW is reachable
    // only from here in Phase 3 — a failed check routes to review rather
    // than being treated as proven fraud (ZM-VER-002).
    new Set<TransactionState>(['ELIGIBLE', 'UNDER_REVIEW', 'FRAUD_REVIEW', 'REJECTED']),
  ],
  [
    'UNDER_REVIEW',
    new Set<TransactionState>(['ELIGIBLE', 'INFORMATION_REQUIRED', 'REJECTED', 'FRAUD_REVIEW']),
  ],
  ['INFORMATION_REQUIRED', new Set<TransactionState>(['AUTOMATED_CHECKS', 'UNDER_REVIEW', 'CANCELLED'])],
  // ELIGIBLE's onward transition to OPEN_FOR_OFFERS is Phase 5's to add,
  // when listing activation exists to perform it.
  ['ELIGIBLE', new Set<TransactionState>(['CANCELLED'])],
  ['FRAUD_REVIEW', new Set<TransactionState>(['ELIGIBLE', 'REJECTED'])],
]);

/** States in which the supplier may still edit the submission. */
const EDITABLE: ReadonlySet<TransactionState> = new Set<TransactionState>([
  'DRAFT',
  'INFORMATION_REQUIRED',
]);

/**
 * States whose invoice fingerprint stays active for duplicate detection.
 *
 * Mirrors migration 0002's trigger, which maintains
 * `invoices.is_active_fingerprint` as `state NOT IN (REJECTED, CANCELLED,
 * CLOSED)`. Kept in sync deliberately: the database is the enforcer, and
 * this constant is what lets the service explain a collision before the
 * unique index raises one.
 */
const FINGERPRINT_INACTIVE: ReadonlySet<TransactionState> = new Set<TransactionState>([
  'REJECTED',
  'CANCELLED',
  'CLOSED',
]);

export function canTransition(from: TransactionState, to: TransactionState): boolean {
  return TRANSITIONS.get(from)?.has(to) ?? false;
}

export function isEditable(state: TransactionState): boolean {
  return EDITABLE.has(state);
}

export function keepsFingerprintActive(state: TransactionState): boolean {
  return !FINGERPRINT_INACTIVE.has(state);
}

export class InvalidTransition extends Error {
  constructor(
    readonly from: TransactionState,
    readonly to: TransactionState,
  ) {
    super(`A transaction cannot move from ${from} to ${to}.`);
  }
}

export function requireTransition(from: TransactionState, to: TransactionState): void {
  if (!canTransition(from, to)) throw new InvalidTransition(from, to);
}

/**
 * Where the automated pipeline sends a transaction (§8.5, ZM-VER-002).
 *
 * The ordering is the requirement rather than a preference:
 *
 *   - A **file integrity** failure is the one signal that points at the
 *     document having been tampered with, so it goes to FRAUD_REVIEW.
 *   - A **duplicate** is handled before this function is reached: it blocks
 *     submission outright with a 409 and a review record, because letting a
 *     known-duplicate invoice into the pipeline at all risks it being
 *     financed while the review is pending.
 *   - Everything else that fails routes to UNDER_REVIEW. ZM-VER-002 is
 *     explicit that a failed check is not by itself proof of fraud, and
 *     treating, say, an OCR mismatch as fraud would accuse a supplier of a
 *     crime over a smudged scan.
 */
export function outcomeOf(
  checks: readonly { checkType: string; result: string }[],
): Extract<TransactionState, 'ELIGIBLE' | 'UNDER_REVIEW' | 'FRAUD_REVIEW'> {
  if (checks.some((c) => c.checkType === 'FILE_INTEGRITY' && c.result === 'FAIL')) {
    return 'FRAUD_REVIEW';
  }
  const unresolved = checks.some((c) => ['FAIL', 'REVIEW', 'MISSING', 'UNPARSED'].includes(c.result));
  return unresolved ? 'UNDER_REVIEW' : 'ELIGIBLE';
}
