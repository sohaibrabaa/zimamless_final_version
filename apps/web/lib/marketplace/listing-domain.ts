/**
 * Listing lifecycle constants (§10.2). Defaults are platform-administration
 * config in the real system (ZM-MKT-008 — "the supplier MUST NOT choose
 * arbitrary deadlines"); this mock hard-codes the requirement's own defaults
 * rather than exposing a control the supplier is explicitly forbidden from
 * having.
 */
export const OFFER_SUBMISSION_WINDOW_HOURS = 24;
export const SUPPLIER_SELECTION_WINDOW_HOURS = 12;

/** AS-02: reminders fire at 50% and 15% of remaining time before the selection deadline. */
export const SELECTION_REMINDER_FRACTIONS = [0.5, 0.15] as const;

export interface ListingDeadlines {
  offerSubmissionDeadline: string;
  supplierSelectionDeadline: string;
}

export function computeListingDeadlines(activatedAt: Date): ListingDeadlines {
  const offerSubmissionDeadline = new Date(
    activatedAt.getTime() + OFFER_SUBMISSION_WINDOW_HOURS * 60 * 60 * 1000
  );
  const supplierSelectionDeadline = new Date(
    offerSubmissionDeadline.getTime() + SUPPLIER_SELECTION_WINDOW_HOURS * 60 * 60 * 1000
  );
  return {
    offerSubmissionDeadline: offerSubmissionDeadline.toISOString(),
    supplierSelectionDeadline: supplierSelectionDeadline.toISOString(),
  };
}

export type ListingStatus =
  | "OPEN_FOR_OFFERS"
  | "OFFER_PERIOD_CLOSED"
  | "AWAITING_SELECTION"
  | "OFFER_SELECTED"
  | "EXPIRED"
  | "CANCELLED";

export function isOfferWindowOpen(deadline: string, now: Date = new Date()): boolean {
  return now.getTime() < new Date(deadline).getTime();
}
