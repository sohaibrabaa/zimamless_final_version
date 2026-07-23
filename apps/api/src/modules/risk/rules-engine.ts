import { BLOCK_CODES } from './reason-codes';
import type { RiskFacts } from './facts';
import { DEFAULT_BAND_THRESHOLDS } from './scoring';

/**
 * Deterministic rules: hard eligibility and hard fraud blockers.
 *
 * ZM-RSK-015 splits the architecture in two, and this is the half the model
 * may not argue with. A trained model estimates risk; it does not get a vote
 * on whether a struck-off buyer is financeable. The separation is enforced by
 * *ordering* rather than by policy — see `capForBlockers` below, which is
 * applied after the model's contribution, so there is no arrangement of model
 * outputs that lifts a blocked transaction out of CRITICAL.
 *
 * Every blocker here is a fact the platform established for itself: a
 * registry status it was told, a hash it computed, a fingerprint collision it
 * detected. None of them can fire because a source was unavailable — that is
 * the INV-9 line, and it is why `Maybe` facts are only ever blockers when
 * they are `available` and adverse.
 */

export interface HardBlocker {
  readonly code: string;
  /** Operator-facing; never shown to a bank verbatim (ZM-RSK-013). */
  readonly detail: string;
}

/**
 * The ceiling a blocked transaction's composite score is held to.
 *
 * One below the CRITICAL threshold, derived from it rather than written as a
 * literal, so that changing the band thresholds in a new model version cannot
 * silently let a blocked transaction score into HIGH.
 */
export const BLOCKED_SCORE_CEILING = DEFAULT_BAND_THRESHOLDS.HIGH - 1;

export function hardBlockers(facts: RiskFacts): HardBlocker[] {
  const blockers: HardBlocker[] = [];
  const { supplier, buyer, invoice } = facts;

  if (supplier.status !== 'ACTIVE') {
    blockers.push({
      code: BLOCK_CODES.SUPPLIER_NOT_ACTIVE,
      detail: `Supplier organization status is ${supplier.status}.`,
    });
  }

  // Only an ANSWERED registry can block. An unreachable registry leaves the
  // buyer unblocked and lowers availability instead (ZM-RSK-005).
  if (buyer.registryStatus.available) {
    if (buyer.registryStatus.value === 'STRUCK_OFF') {
      blockers.push({
        code: BLOCK_CODES.BUYER_STRUCK_OFF,
        detail: 'Buyer is struck off the commercial register.',
      });
    }
    if (buyer.registryStatus.value === 'SUSPENDED') {
      blockers.push({
        code: BLOCK_CODES.BUYER_SUSPENDED,
        detail: 'Buyer is suspended in the commercial register.',
      });
    }
    // UNDER_LIQUIDATION is deliberately absent: LT-02 makes it a manual
    // review path, not a refusal. It lowers buyerProfile and shows as a risk
    // factor. Adding it here would re-break what the Phase 3 audit fixed.
  }

  if (invoice.duplicateCollision) {
    blockers.push({
      code: BLOCK_CODES.DUPLICATE_INVOICE,
      detail: 'Invoice fingerprint collides with another active invoice.',
    });
  }

  if (invoice.fileIntegrityOk.available && !invoice.fileIntegrityOk.value) {
    blockers.push({
      code: BLOCK_CODES.FILE_INTEGRITY_FAILED,
      detail: 'Stored document hash does not match the recorded hash.',
    });
  }

  if (!invoice.electronicInvoiceAttached) {
    blockers.push({
      code: BLOCK_CODES.NO_ELECTRONIC_INVOICE,
      detail: 'No electronic invoice document is attached (ZM-DOC-001).',
    });
  }

  if (invoice.pastDue) {
    blockers.push({
      code: BLOCK_CODES.INVOICE_PAST_DUE,
      detail: 'Invoice due date has already passed (AS-07).',
    });
  }

  if (invoice.tenorDays.available && invoice.tenorDays.value < invoice.minTenorDays) {
    blockers.push({
      code: BLOCK_CODES.TENOR_TOO_SHORT,
      detail: `Remaining tenor is below the ${invoice.minTenorDays}-day minimum (AS-08).`,
    });
  }

  if (!invoice.declarationsRecorded) {
    blockers.push({
      code: BLOCK_CODES.DECLARATIONS_MISSING,
      detail: 'Supplier declarations have not been recorded.',
    });
  }

  return blockers;
}

/**
 * Applies the blocker ceiling. Call this LAST, after any model adjustment.
 *
 * Returning `min` rather than a fixed value keeps a transaction that was
 * already scoring below the ceiling at its true score — a blocked transaction
 * should not be *improved* by being blocked, which a flat assignment would do.
 */
export function capForBlockers(composite: number, blockers: readonly HardBlocker[]): number {
  if (blockers.length === 0) return composite;
  return Math.min(composite, BLOCKED_SCORE_CEILING);
}
