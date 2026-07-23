/**
 * The ZM-OFR-001/11.2 money formula, in one place so the client-side preview
 * (offer form, live as the bank types) and the mock "server" recomputation
 * (marketplace-store.ts, which is what actually decides ACCEPT/reject) run
 * the identical arithmetic. ZM-OFR-003 requires the server figure to win —
 * a client preview that could ever disagree with its own store would defeat
 * the point of "always reconciled to the server figure."
 *
 * Money in, money out, decimal.js throughout — never a JS number touches
 * this file (lib/money.ts's rule, not just this file's).
 */

import Decimal from "decimal.js";
import { addMoney, compareMoney, subtractMoney, type MoneyString } from "@/lib/money";

export interface OfferMoneyInput {
  grossFundingAmount: MoneyString;
  bankDiscountAmount: MoneyString;
  bankFeesAmount: MoneyString;
  platformCommissionAmount: MoneyString;
  unpaidListingFeeAmount: MoneyString;
  otherDeductionsAmount: MoneyString;
}

/**
 * netSupplierPayout = gross − discount − fees − commission − unpaidListingFee − otherDeductions
 */
export function computeNetSupplierPayout(input: OfferMoneyInput): MoneyString {
  let net = input.grossFundingAmount;
  net = subtractMoney(net, input.bankDiscountAmount);
  net = subtractMoney(net, input.bankFeesAmount);
  net = subtractMoney(net, input.platformCommissionAmount);
  net = subtractMoney(net, input.unpaidListingFeeAmount);
  net = subtractMoney(net, input.otherDeductionsAmount);
  return net;
}

/**
 * ZM-FEE-011: commission is calculated from `grossFundingAmount` under the
 * active `CommissionTier`, never from faceValue or the supplier's floor.
 * V3's competition default has no configured tier admin screen yet (Phase 9,
 * out of this phase's scope), so a single flat rate stands in — documented
 * as an assumption rather than silently presented as a real tier lookup.
 * `ZM-FEE-009` (default fee-payer SUPPLIER) is what makes this deduction
 * land on the supplier's net at all, matching the formula above.
 */
const DEMO_COMMISSION_RATE = "0.015"; // 1.5% flat, demo-only stand-in for a real CommissionTier

export function computeCommission(grossFundingAmount: MoneyString): MoneyString {
  // Local, single-purpose multiply — lib/money.ts deliberately has no
  // generic multiply (Money.multiply's float-argument hole was a real
  // Phase-1 defect on the API side). Both factors here are fixed strings
  // this module controls, never user input.
  return new Decimal(grossFundingAmount).times(new Decimal(DEMO_COMMISSION_RATE)).toFixed(3);
}

/**
 * The listing fee (ZM-FEE-001..007). `CONFIGURABLE` per the requirement;
 * this is a fixed demo value, shown to the supplier before activation and
 * carried into every subsequent offer's `unpaidListingFeeAmount` until a
 * real payment flow exists (none of Phase 5's endpoints settle it).
 */
export const LISTING_FEE_AMOUNT: MoneyString = "150.000";

export function isBelowFloor(netSupplierPayout: MoneyString, minimumAcceptableAmount: MoneyString): boolean {
  return compareMoney(netSupplierPayout, minimumAcceptableAmount) < 0;
}

export function sumMoney(values: MoneyString[]): MoneyString {
  return values.reduce((acc, v) => addMoney(acc, v), "0.000");
}
