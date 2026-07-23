import { Money } from '../../common/money/money';
import type { TransactionState } from '../transactions/transaction-state';

/**
 * Maturity arithmetic and the overdue rule (ZM-PMT-008..011).
 *
 * Pure functions, so the one rule that matters most in this phase can be
 * tested without a database, a clock, or a NestJS module: **a due date passing
 * never produces `OVERDUE`.** It produces `OVERDUE_UNCONFIRMED`, which says
 * what is actually true — the invoice is past due and nobody has told us
 * whether the buyer paid.
 *
 * The platform cannot see a buyer's bank account. Only the funding bank can.
 * Treating silence as proven default would let a system with no evidence brand
 * a real Jordanian SME a defaulter, and the damage from that is not symmetric
 * with the cost of waiting for a confirmation.
 */

/** Whole days from `due` to `now`, negative before the due date. */
export function daysPastDue(dueDate: Date, now: Date): number {
  // Compared at day granularity in UTC: an invoice due on the 30th is not
  // overdue at 00:30 on the 30th, whatever the server's timezone thinks.
  const due = Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // Exact division, deliberately without rounding: both operands are UTC
  // midnights, so their difference is always a whole multiple of a day.
  // `Math.round` is lint-banned here — the rule exists for money, and reaching
  // for it on a number that does not need rounding is how that rule gets worn
  // down until someone rounds a dinar with it.
  return (today - due) / 86_400_000;
}

/** Days remaining until due; 0 on the due date itself, negative once past. */
export function daysUntilDue(dueDate: Date, now: Date): number {
  return -daysPastDue(dueDate, now);
}

/** `overdueDays` as the contract reports it: never negative. */
export function overdueDays(dueDate: Date, now: Date): number {
  return Math.max(0, daysPastDue(dueDate, now));
}

/**
 * Which pre-maturity reminder, if any, is due.
 *
 * Returns the *largest* threshold that has been reached rather than the
 * closest, so a sweep that has not run for a week still sends the 14-day
 * reminder before the 7-day one, and each is sent once (the caller keys on
 * `template_key` + `transaction_id`). `0` is the due-date reminder itself.
 */
export function remindersDue(
  dueDate: Date,
  now: Date,
  thresholds: readonly number[],
): number[] {
  const remaining = daysUntilDue(dueDate, now);
  return [...thresholds]
    .filter((t) => Number.isFinite(t) && t >= 0)
    .sort((a, b) => b - a)
    .filter((t) => remaining <= t);
}

/**
 * States the maturity sweep may act on.
 *
 * `PARTIALLY_PAID` is included: part of an invoice being settled does not stop
 * the rest from falling due. `DISPUTED` and `FRAUD_REVIEW` are excluded — see
 * `automationPaused`.
 */
const SWEEPABLE: ReadonlySet<TransactionState> = new Set<TransactionState>([
  'FUNDED',
  'PARTIALLY_PAID',
]);

/**
 * ZM-REC-013 — an open dispute pauses automation.
 *
 * A disputed transaction gets no reminders and no state changes from the
 * sweep. The whole point of a dispute is that the facts are contested; a job
 * that carried on relabelling the transaction while people argued about what
 * happened would be asserting one side of the argument automatically. Fraud
 * review is paused for the same reason and a stronger one.
 *
 * This is deliberately a function of state rather than a query for open
 * dispute rows: `DISPUTED` *is* the transaction being under dispute, and
 * reading it from one place means the sweep and the UI cannot disagree.
 */
export function automationPaused(state: TransactionState): boolean {
  return state === 'DISPUTED' || state === 'FRAUD_REVIEW';
}

export function isSweepable(state: TransactionState): boolean {
  return SWEEPABLE.has(state) && !automationPaused(state);
}

/**
 * What the sweep should do with one transaction.
 *
 * `null` means leave it alone. Note what is *not* returned anywhere in this
 * function: `'OVERDUE'`. There is no input for which this function proposes
 * that state, and there cannot be — it is not in the return type.
 */
export function maturityAction(
  state: TransactionState,
  dueDate: Date,
  now: Date,
): 'OVERDUE_UNCONFIRMED' | null {
  if (!isSweepable(state)) return null;
  if (state === 'OVERDUE_UNCONFIRMED') return null;
  return daysPastDue(dueDate, now) > 0 ? 'OVERDUE_UNCONFIRMED' : null;
}

/**
 * The derived outstanding balance (D-13 / PA-06).
 *
 * The invoice's own `paid_amount` and `outstanding_amount` freeze at listing
 * and are never mutated after funding — they are what the offer was priced
 * against, and rewriting them would retroactively change the terms of a deal
 * that already closed. The live balance is therefore *computed*: the frozen
 * outstanding minus everything the bank has since reported.
 *
 * Clamped at zero. An overpayment is a real thing that happens (a buyer pays a
 * rounded figure), and reporting a negative outstanding would be arithmetically
 * honest but operationally useless — the reconciliation of an overpayment is a
 * separate conversation, not a negative balance on a screen.
 */
export function derivedOutstanding(
  frozenOutstanding: Money,
  payments: readonly { amount: Money }[],
): Money {
  const paid = payments.reduce((sum, p) => sum.add(p.amount), Money.zero());
  const remaining = frozenOutstanding.subtract(paid);
  return remaining.isNegative() ? Money.zero() : remaining;
}

export function totalPaid(payments: readonly { amount: Money }[]): Money {
  return payments.reduce((sum, p) => sum.add(p.amount), Money.zero());
}

/**
 * The state a payment total implies — as a proposal, never as a confirmation.
 *
 * A bank *reporting* a payment is evidence and moves the transaction. Silence
 * is not evidence and moves nothing, which is why there is no branch here for
 * "no payments and past due": that case is `maturityAction`'s, and it produces
 * `OVERDUE_UNCONFIRMED`.
 */
export function stateAfterPayment(
  frozenOutstanding: Money,
  payments: readonly { amount: Money }[],
): 'PAID' | 'PARTIALLY_PAID' {
  return derivedOutstanding(frozenOutstanding, payments).isZero() ? 'PAID' : 'PARTIALLY_PAID';
}
