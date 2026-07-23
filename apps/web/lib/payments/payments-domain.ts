/**
 * Post-funding — the pure half.
 *
 * One rule dominates this file and it is a rule about **words**:
 * `OVERDUE_UNCONFIRMED` must never be rendered as a claim that the buyer
 * failed to pay. The platform cannot see a buyer's bank account; only the
 * funding bank can. A screen that shows a Jordanian SME the word "defaulted"
 * because a date passed is making an accusation the system has no evidence
 * for, and the damage from that is not symmetric with the cost of waiting.
 *
 * So the state→label mapping lives here, as data, with a test that asserts the
 * banned words never appear. A label chosen inline in JSX is a label nobody
 * tests.
 */

export type PostFundingState =
  | 'FUNDED'
  | 'PARTIALLY_PAID'
  | 'PAID'
  | 'OVERDUE_UNCONFIRMED'
  | 'OVERDUE'
  | 'RECOURSE_ACTIVE'
  | 'DISPUTED'
  | 'FRAUD_REVIEW'
  | 'CLOSED';

export type CaseType = 'FRAUD' | 'DISPUTE' | 'WITHDRAWAL' | 'RECOURSE';

/**
 * The i18n key for a state's label.
 *
 * `OVERDUE_UNCONFIRMED` deliberately maps to `awaitingConfirmation`, not to
 * anything containing "overdue". The state name is an internal fact; what a
 * supplier reads is that the platform is waiting on the bank.
 */
export function stateLabelKey(state: string): string {
  return `payments.state.${state}`;
}

/**
 * Badge tone per state.
 *
 * `OVERDUE_UNCONFIRMED` is **neutral**, not warning. Brief §5 forbids
 * presenting a non-adverse state with warning colours, and "we have not heard
 * from the bank yet" is not adverse — colouring it amber would say in design
 * what the copy is careful not to say in words.
 */
export function stateTone(state: string): 'neutral' | 'success' | 'warning' | 'danger' | 'info' {
  switch (state) {
    case 'PAID':
      return 'success';
    case 'PARTIALLY_PAID':
    case 'FUNDED':
      return 'info';
    case 'OVERDUE_UNCONFIRMED':
      return 'neutral';
    case 'OVERDUE':
      return 'warning';
    case 'RECOURSE_ACTIVE':
    case 'FRAUD_REVIEW':
      return 'danger';
    case 'DISPUTED':
      return 'warning';
    default:
      return 'neutral';
  }
}

/** Whether the platform is waiting on a bank rather than asserting anything. */
export function isAwaitingBankConfirmation(state: string): boolean {
  return state === 'OVERDUE_UNCONFIRMED';
}

/** ZM-REC-013 — while this is true, the platform's automation is paused. */
export function isAutomationPaused(state: string): boolean {
  return state === 'DISPUTED' || state === 'FRAUD_REVIEW';
}

/**
 * What the bank may do on a post-funding transaction.
 *
 * `canConfirmStatus` is the only route to `OVERDUE` anywhere in the product,
 * which is why it is offered exactly where a confirmation is genuinely
 * outstanding and nowhere else.
 */
export function bankPostFundingActions(state: string) {
  return {
    canReportPayment: ['FUNDED', 'PARTIALLY_PAID', 'OVERDUE_UNCONFIRMED', 'OVERDUE'].includes(state),
    canConfirmStatus: ['OVERDUE_UNCONFIRMED', 'PARTIALLY_PAID', 'FUNDED'].includes(state),
    // Recourse follows a CONFIRMED overdue. Offering it on an unconfirmed one
    // would invite a bank into a 409 and, worse, suggest the platform thinks
    // an unconfirmed overdue is grounds for a claim.
    canInitiateRecourse: state === 'OVERDUE',
    canDispute: !isAutomationPaused(state) && state !== 'CLOSED',
  };
}

export function supplierPostFundingActions(state: string) {
  return {
    // A supplier never reports a buyer payment: they do not see the bank's
    // account either. They read the record and may contest it.
    canDispute: !isAutomationPaused(state) && state !== 'CLOSED',
    isSettled: state === 'PAID' || state === 'CLOSED',
  };
}

/** Case types a non-platform user may see at all. Fraud is never in this list. */
export const PARTY_VISIBLE_CASE_TYPES: readonly CaseType[] = ['DISPUTE', 'WITHDRAWAL', 'RECOURSE'];

export function isCaseTypeVisibleTo(
  type: CaseType,
  organizationType: string | undefined,
): boolean {
  if (organizationType === 'PLATFORM') return true;
  return PARTY_VISIBLE_CASE_TYPES.includes(type);
}

/** Days past due, for display. Never negative. */
export function overdueDaysFrom(dueDate: string | undefined, now: Date): number {
  if (!dueDate) return 0;
  const due = new Date(`${dueDate}T00:00:00.000Z`);
  if (Number.isNaN(due.getTime())) return 0;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, (today - due.getTime()) / 86_400_000);
}
