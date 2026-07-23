/**
 * Funding — the pure half.
 *
 * Everything here is a function of data with no network and no React, so the
 * rules that matter can be tested without a DOM. The rules that matter are
 * mostly about what a screen must *not* do:
 *
 *   - The bank cannot reach `FUNDED` from its own screen (INV-10). Marking
 *     sent and issuing a code are the only two actions it has, and neither
 *     completes funding.
 *   - The OTP failure message is the same sentence whatever went wrong. The
 *     server refuses to say whether a code was wrong, expired, or already
 *     used (ZM-FND-009), and a client that guessed from the shape of the
 *     response would hand back exactly the oracle the server withheld.
 *   - `minimumAcceptableAmount` appears nowhere in this feature at all. It is
 *     absent from every type below by construction, not filtered out later.
 */

/** The states this feature acts on. Anything else is not funding's business. */
export const FUNDING_STATES = [
  "CONTRACTED",
  "FUNDING_CONFIRMATION_PENDING",
  "FUNDED",
] as const;

export type FundingState = (typeof FUNDING_STATES)[number];

export type SettlementStatus =
  | "PENDING"
  | "FUNDING_RECEIVED"
  | "PAYOUT_INITIATED"
  | "PAYOUT_COMPLETED"
  | "PAYOUT_FAILED"
  | "RETRYING"
  | "MANUAL_REVIEW"
  | "REVERSED";

/** OTP codes are six digits (`randomInt(0, 1e6)` zero-padded, server-side). */
export const OTP_LENGTH = 6;

/**
 * What the bank may do right now.
 *
 * `markSent` is available only from `CONTRACTED`, and only once — a second
 * mark-sent is a 409 from the server, so offering the button again would be
 * inviting a failure. `generateOtp` becomes available exactly when the
 * transfer has been recorded, which is also when the supplier has something
 * to confirm.
 */
export function bankActions(state: string, hasSettlement: boolean) {
  return {
    canMarkSent: state === "CONTRACTED" && !hasSettlement,
    canGenerateOtp: state === "FUNDING_CONFIRMATION_PENDING",
    // Deliberately absent: there is no bank action that reaches FUNDED. If
    // this object ever grows one, INV-10 has been broken in the API and the
    // screen is only reflecting it.
  };
}

/** What the supplier may do right now. */
export function supplierActions(state: string) {
  return {
    canConfirm: state === "FUNDING_CONFIRMATION_PENDING",
    awaitingBank: state === "CONTRACTED",
    isFunded: state === "FUNDED",
  };
}

/**
 * Six digits, nothing else.
 *
 * The server deliberately declares no length or format validator on the
 * confirm body: a malformed code must fail exactly like a wrong one, so that
 * "your code is the wrong shape" never becomes a distinguishing signal. This
 * check exists only to stop an obviously incomplete entry from spending one
 * of the five attempts, and it runs *before* the request, never on a response.
 */
export function isWellFormedOtp(value: string): boolean {
  return new RegExp(`^\\d{${OTP_LENGTH}}$`).test(value.trim());
}

/** Strips anything a user might paste around the digits (spaces, dashes). */
export function normalizeOtpInput(value: string): string {
  return value.replace(/\D/g, "").slice(0, OTP_LENGTH);
}

/**
 * Whether a settlement is still moving.
 *
 * `RETRYING` and `PAYOUT_INITIATED` both mean "the rail has it"; the screen
 * polls in those states and shows nothing actionable, because a retry button
 * during an in-flight attempt invites the user to ask for a second payout the
 * server would refuse anyway (INV-13).
 */
export function isSettlementInFlight(status: SettlementStatus | string): boolean {
  return status === "PAYOUT_INITIATED" || status === "RETRYING";
}

export function isSettlementTerminal(status: SettlementStatus | string): boolean {
  return status === "PAYOUT_COMPLETED" || status === "REVERSED";
}

/**
 * Who may press retry.
 *
 * Past the automatic retry allowance a settlement is `MANUAL_REVIEW`, which
 * is a decision for platform operations rather than one more click for the
 * bank (AS-03). The server enforces this independently; the button is hidden
 * rather than disabled so nobody is invited into a 403.
 */
export function canRetryPayout(
  status: SettlementStatus | string,
  roles: readonly string[],
): boolean {
  if (isSettlementInFlight(status) || isSettlementTerminal(status)) return false;
  const isPlatform = roles.includes("PLATFORM_OPS_ADMIN") || roles.includes("PLATFORM_SUPER_ADMIN");
  if (status === "MANUAL_REVIEW") return isPlatform;
  return status === "PAYOUT_FAILED" && (isPlatform || roles.some((r) => r.startsWith("BANK_")));
}

/**
 * The deductions, in the order a supplier reads them.
 *
 * Gross is the headline the bank agreed to fund. What actually reaches the
 * supplier is gross minus the platform's two charges — and the bank's own
 * discount and fees, which were already netted off when the offer was made
 * and so are not repeated here. The settlement carries exactly these four
 * numbers, and the screen shows all four rather than only the net, because a
 * payout the supplier cannot reconcile is a support ticket.
 */
export interface SettlementBreakdown {
  grossFundingAmount: string;
  platformCommissionAmount: string;
  listingFeeDeducted: string;
  netSupplierPayout: string;
}

export function breakdownRows(s: SettlementBreakdown) {
  return [
    { key: "gross", amount: s.grossFundingAmount, deduction: false },
    { key: "commission", amount: s.platformCommissionAmount, deduction: true },
    { key: "listingFee", amount: s.listingFeeDeducted, deduction: true },
    { key: "net", amount: s.netSupplierPayout, deduction: false },
  ] as const;
}

/** Badge tone per settlement status — failure and manual review read differently. */
export function settlementTone(status: SettlementStatus | string): "success" | "warning" | "danger" | "info" {
  if (status === "PAYOUT_COMPLETED") return "success";
  if (status === "PAYOUT_FAILED") return "warning";
  if (status === "MANUAL_REVIEW" || status === "REVERSED") return "danger";
  return "info";
}
