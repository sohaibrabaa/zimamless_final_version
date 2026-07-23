import { Money } from '../../common/money/money';

/**
 * Offer money: the server's arithmetic, and the only arithmetic that counts.
 *
 * ZM-OFR-002 puts the net formula in the database as a CHECK constraint, and
 * this file is the layer above it. The division of labour matters:
 *
 *   - The **bank supplies** gross, its own discount, its own fees, and any
 *     other deductions. Those are its commercial decision.
 *   - The **platform computes** the commission (from the active tier) and the
 *     listing fee (the unpaid portion). A bank cannot set either, and neither
 *     is read from the request body at all — not validated-and-overwritten,
 *     but never read, so a client that sends them gets them ignored rather
 *     than silently honoured.
 *   - The **net is recomputed**, never accepted. If the client's figure
 *     disagrees, the offer is rejected rather than quietly corrected: a bank
 *     whose UI computed a different net has a bug, and silently overwriting
 *     it would let the bank believe it offered one number while the supplier
 *     sees another.
 *
 * Every value here is `Money` — decimal, 3 dp, half-up. There is no `number`
 * in this file, which is the point of hard rule 2: JOD arithmetic in
 * floating point is a defect, and a marketplace is where it would cost real
 * money.
 */

export interface OfferComponents {
  readonly grossFundingAmount: Money;
  readonly bankDiscountAmount: Money;
  readonly bankFeesAmount: Money;
  readonly platformCommissionAmount: Money;
  readonly listingFeeAmount: Money;
  readonly otherDeductionsAmount: Money;
}

/**
 * net = gross − discount − fees − commission − listingFee − other
 *
 * The same expression as `chk_net_formula`, deliberately. Two places compute
 * it and they must agree; the database is the backstop that catches it if
 * they ever stop agreeing.
 */
export function netPayoutOf(components: OfferComponents): Money {
  return components.grossFundingAmount
    .subtract(components.bankDiscountAmount)
    .subtract(components.bankFeesAmount)
    .subtract(components.platformCommissionAmount)
    .subtract(components.listingFeeAmount)
    .subtract(components.otherDeductionsAmount);
}

export type OfferRejection =
  | 'GROSS_NOT_POSITIVE'
  | 'GROSS_EXCEEDS_OUTSTANDING'
  | 'NET_NOT_POSITIVE'
  | 'DEDUCTIONS_NEGATIVE'
  | 'NET_MISMATCH';

export interface OfferValidation {
  readonly ok: boolean;
  readonly rejection?: OfferRejection;
  readonly net: Money;
}

/**
 * Validates the components against the invoice, and against the client's own
 * net if it supplied one.
 *
 * Note what is NOT checked here: the supplier's floor. That check lives in
 * the service, deliberately separated, because it is the one rejection whose
 * *reason must not be explained* (ZM-MKT-012) — keeping it out of this
 * function means no caller can accidentally fold a floor breach into a
 * detailed validation error alongside the numbers that caused it.
 */
export function validateOffer(
  components: OfferComponents,
  outstandingAmount: Money,
  clientNet?: Money,
): OfferValidation {
  const net = netPayoutOf(components);

  if (!components.grossFundingAmount.isPositive()) {
    return { ok: false, rejection: 'GROSS_NOT_POSITIVE', net };
  }

  for (const deduction of [
    components.bankDiscountAmount,
    components.bankFeesAmount,
    components.otherDeductionsAmount,
  ]) {
    if (deduction.isNegative()) {
      return { ok: false, rejection: 'DEDUCTIONS_NEGATIVE', net };
    }
  }

  // A bank may not advance more than the receivable is worth: the platform
  // would be brokering an advance the invoice cannot repay. Expressed as
  // "outstanding must be at least gross" rather than the negation of a
  // greater-than, which reads the same and does not need a not-equals rider.
  if (!outstandingAmount.greaterThanOrEqual(components.grossFundingAmount)) {
    return { ok: false, rejection: 'GROSS_EXCEEDS_OUTSTANDING', net };
  }

  if (!net.isPositive()) {
    return { ok: false, rejection: 'NET_NOT_POSITIVE', net };
  }

  // The client's own figure, if it sent one, must match ours exactly. This is
  // the "reject, do not correct" rule from the header comment.
  if (clientNet && !clientNet.equals(net)) {
    return { ok: false, rejection: 'NET_MISMATCH', net };
  }

  return { ok: true, net };
}

/**
 * Whether the offer clears the supplier's private floor.
 *
 * Returns a bare boolean on purpose. The caller has the floor and the net;
 * this function refuses to hand back a difference, a percentage, or a
 * "shortfall" — because every one of those would be a number that must never
 * reach a bank, and the easiest way to guarantee it never leaks is for it
 * never to be computed. ZM-MKT-012's design note, made mechanical.
 */
export function meetsFloor(net: Money, floor: Money | null): boolean {
  if (floor === null) return true;
  return net.greaterThanOrEqual(floor);
}
